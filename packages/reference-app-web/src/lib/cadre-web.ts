/**
 * cadre-web.ts — CadreNode lifecycle for the browser reference.
 *
 * This is the browser counterpart to `reference-app-rn/src/cadre-phone.ts`. It
 * brings up a real Sereus stack in the browser:
 *   CadreNode → control network (`CadreControl`) → signed open chat strand.
 *
 * Browser specifics vs the phone:
 *   - WebSocket + circuit-relay + WebRTC(+direct) transports (no TCP in a tab).
 *   - IndexedDB-backed raw storage via `strand-storage.ts` (per-strand handles
 *     pre-opened before the synchronous cadre-core storage provider is hit).
 *   - Ed25519 identity + party id persisted in the control IndexedDB database
 *     across reloads, alongside the durable trusted-owner anchor and
 *     bootstrap-peer store (`node-local-slots.ts`) — same database, shared fate.
 *   - Transaction profile — the browser is an edge node, like the phone.
 *
 * The node self-seeds as its own owner (mirroring `cadre-cli start
 * --owner`); the solo chat strand coordinates its own writes, so DML lands on
 * the strand's IndexedDB without any peers.
 *
 * Beyond the solo strand, this module also drives the **consent/invitation
 * strand-formation** flow: relay reservation for dialability, responder-side
 * `createOpenInvitation` / `encodeInvitation`, initiator-side `decodeInvitation`
 * / `formStrand` + closed-strand `addStrand`, plus read-only helpers that surface
 * the `CadreControl` authorization gates ("RBAC") to diagnostics. Live two-party
 * cross-cohort convergence still needs relay infra + a dialable second cadre.
 */

import {
	CadreNode,
	ed25519KeyPairFromLibp2p,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
	PersistentTrustedOwnerStore,
	PersistentBootstrapPeerStore,
	peerKeySigner,
} from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	StrandInstance,
	OpenInvitation,
	FormStrandResult,
	StrandFormationDisclosure,
	TrustedOwnerStore,
	BootstrapPeerStore,
	RelayReservationState,
} from '@serfab/cadre-core';
import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { IRawStorage, Libp2pTransports } from '@optimystic/db-p2p';
import { multiaddr } from '@multiformats/multiaddr';
import type { Database } from '@quereus/quereus';
import {
	loadOrCreateBrowserPeerKey,
	DEFAULT_PEER_KEY_NAME,
	type OptimysticWebDBHandle,
} from '@optimystic/db-p2p-storage-web';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { loadIceConfig } from './ice-config.js';
import { resolveRelayAddrs } from './relay-config.js';
import {
	openStores,
	closeStores,
	storageProvider,
	getStoreHandle,
	getStoreStorage,
	CONTROL_STORE_KEY,
} from './strand-storage.js';
import { kvSlot, TRUSTED_OWNERS_KV_KEY, BOOTSTRAP_PEERS_KV_KEY } from './node-local-slots.js';
import { getChatSAppConfig, CHAT_STRAND_ID, CHAT_SAPP_ID } from './chat-strand.js';
import { insertChatMessage, selectChatMessages } from './chat-dml.js';

/**
 * db-p2p's transport-factory element type. The WebRTC factories from
 * `@libp2p/webrtc` carry a nominally-different `[transportSymbol]` brand than
 * db-p2p's pinned `@libp2p/interface` (the symbol is a global registry key, so
 * they are runtime-identical). `CadreNodeConfig.network.transports` is exactly
 * this `Libp2pTransports`, so we bridge with the same cast the bare-libp2p
 * wiring used — no `any`, no pinning five transitive packages.
 */
type TransportFactory = Libp2pTransports[number];

/** Outcome of the solo owner self-genesis step. */
export type OwnerState = 'pending' | 'genesis' | 'existing' | 'error';

/**
 * Relay-reservation posture for the dialable side of formation — cadre-core owns
 * both the drive and the status derivation (`relay-reservation.ts`); this app
 * only supplies the relay addrs and renders the result. Re-exported under the
 * local names the store/diagnostics already use.
 */
export type RelayState = RelayReservationState;

/**
 * The posture of a tab with no node running (or no relay configured). A FACTORY,
 * not a shared const: the store assigns whatever `getRelayState()` returns into a
 * Svelte `$state` object, which proxies it — a write through that proxy would
 * otherwise mutate the singleton every later caller receives.
 */
export function noRelayState(): RelayState {
	return { status: 'none', addrs: [], circuitAddrs: [], error: null, retryAtMs: null };
}

/** A strand this tab joined via the consent/invitation formation flow. */
export interface FormedStrand {
	strandId: string;
	/**
	 * The closed strand's read-gating membership key (`MemberPrivateKey`) this tab
	 * attached with. Host and joiner record the **same** secret, so
	 * {@link getFormedStrands} surfaces both sides symmetrically (e.g. an e2e
	 * convergence check can assert the two memberKeys match).
	 */
	memberKey: string;
	/** Membership type — formed strands are closed (`'c'`). */
	type: 'o' | 'c';
}

/** Result of an attempted unauthorized control write (the RBAC gate demo). */
export interface OwnerGateProbe {
	/** True when the `CadreControl` constraint rejected the write (gate working). */
	rejected: boolean;
	/** The rejection message (when `rejected`), else null. */
	error: string | null;
}

/** A `FormationInvite` row, as surfaced to diagnostics. */
export interface FormationInviteRow {
	token: string;
	sAppId: string | null;
	expiresAt: string | null;
	totalUses: number | null;
}

/** A `FormationUsage` row, as surfaced to diagnostics. */
export interface FormationUsageRow {
	token: string;
	usageStampId: string;
	strandId: string | null;
}

/** A control-network `Strand` row (membership type + member-key presence). */
export interface ControlStrandRow {
	id: string;
	type: 'o' | 'c';
	hasMemberKey: boolean;
}

/** Control-network authorization ("RBAC") state, for the diagnostics surface. */
export interface ControlAuthorizationState {
	ownerKeyCount: number;
	validationKeyCount: number;
	formationInvites: FormationInviteRow[];
	formationUsage: FormationUsageRow[];
	strands: ControlStrandRow[];
}

const PARTY_ID_KEY = 'party-id';
const IDENTITY_FIRST_SEEN_KEY = 'identity-first-seen';

let node: CadreNode | null = null;
let controlStorage: IRawStorage | null = null;
let partyId: string | null = null;
let activeStrandId: string | null = null;
let identityFirstSeenMs: number | null = null;
let ownerState: OwnerState = 'pending';
let ownerError: string | null = null;
let trustedOwnerStore: TrustedOwnerStore | null = null;
let bootstrapPeerStore: BootstrapPeerStore | null = null;
let solicitationReady = false;
const formedStrands = new Map<string, FormedStrand>();

// ── Getters (read by the store + diagnostics) ─────────────────────────────────

export function getCadreNode(): CadreNode | null {
	return node;
}

/** The underlying control-network libp2p node — feeds the existing diagnostics. */
export function getControlNode(): Libp2p | null {
	return node?.getControlNode() ?? null;
}

export function getPartyId(): string | null {
	return partyId;
}

export function getChatStrandId(): string | null {
	return activeStrandId;
}

export function getChatStrand(): StrandInstance | undefined {
	if (!node || !activeStrandId) return undefined;
	return node.getStrand(activeStrandId);
}

/** Control IndexedDB handle — used by diagnostics for per-store row counts. */
export function getControlDbHandle(): OptimysticWebDBHandle | null {
	return getStoreHandle(CONTROL_STORE_KEY);
}

/** Control raw storage — used by diagnostics for the backend label + byte estimate. */
export function getControlStorage(): IRawStorage | null {
	return controlStorage;
}

export function getIdentityFirstSeenMs(): number | null {
	return identityFirstSeenMs;
}

export function getOwnerState(): { state: OwnerState; error: string | null } {
	return { state: ownerState, error: ownerError };
}

/**
 * Relay-reservation posture (dialability for formation). Read LIVE from the node
 * on every call — a reservation lost after start (relay restart, dropped
 * connection) shows up as `error` here, so nothing mints an invitation carrying
 * circuit addresses that no longer route.
 */
export function getRelayState(): RelayState {
	return node?.getRelayReservationState() ?? noRelayState();
}

/** Node-local trusted-owner anchor — durable across reload once `startCadre` resolves. */
export function getTrustedOwnerStore(): TrustedOwnerStore | null {
	return trustedOwnerStore;
}

/** Node-local bootstrap-peer store — durable across reload once `startCadre` resolves. */
export function getBootstrapPeerStore(): BootstrapPeerStore | null {
	return bootstrapPeerStore;
}

/** Strands joined this session via the consent/invitation formation flow. */
export function getFormedStrands(): FormedStrand[] {
	return [...formedStrands.values()];
}

// ── Persistence helpers (party id + identity-first-seen, on the control DB) ───

async function loadOrCreatePartyId(handle: OptimysticWebDBHandle): Promise<string> {
	const existing = await handle.get('kv', PARTY_ID_KEY);
	if (typeof existing === 'string' && existing.length > 0) {
		return existing;
	}
	const fresh = crypto.randomUUID();
	await handle.put('kv', fresh, PARTY_ID_KEY);
	return fresh;
}

async function trackIdentityFirstSeen(
	handle: OptimysticWebDBHandle,
	keyName: string,
): Promise<number> {
	const existingFirstSeen = await handle.get('kv', IDENTITY_FIRST_SEEN_KEY);
	if (typeof existingFirstSeen === 'string') {
		const parsed = Number(existingFirstSeen);
		if (Number.isFinite(parsed)) return parsed;
	}
	const now = Date.now();
	await handle.put('kv', String(now), IDENTITY_FIRST_SEEN_KEY);
	// Touch the identity key so the first-seen we record is anchored to the same
	// db the peer key lives in. (Same caveat as the bare-libp2p version: on an
	// upgrade where the key predates tracking, "first seen" understates age.)
	void keyName;
	return now;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start (or return the running) browser CadreNode and bring the control network
 * up. Idempotent. Does NOT start the chat strand — call {@link addChatStrand}
 * after this resolves so the caller can subscribe to events first.
 */
export async function startCadre(): Promise<CadreNode> {
	if (node) return node;

	// Pre-open the control network's IndexedDB handle before start() — cadre-core
	// hits the synchronous storage provider with key 'control' during start.
	await openStores([CONTROL_STORE_KEY]);
	const controlHandle = getStoreHandle(CONTROL_STORE_KEY)!;

	partyId = await loadOrCreatePartyId(controlHandle);
	identityFirstSeenMs = await trackIdentityFirstSeen(controlHandle, DEFAULT_PEER_KEY_NAME);
	// `loadOrCreateBrowserPeerKey` returns db-p2p-storage-web's pinned
	// `@libp2p/interface` `PrivateKey`, whose `Uint8ArrayList` brand is newer than
	// this app's `@libp2p/interface` (same global symbol → runtime-identical).
	// Bridge to the local `PrivateKey` type — the same brand-skew cast the
	// transport factories use above; cadre-core consumes the local brand.
	const privateKey = (await loadOrCreateBrowserPeerKey(controlHandle)) as unknown as PrivateKey;
	controlStorage = getStoreStorage(CONTROL_STORE_KEY);

	// ICE servers (STUN/TURN) from the runtime manifest. Never throws; `[]` when
	// no manifest is configured (host/LAN candidates still work).
	//
	// The signer proves to a peer-bound TURN credential issuer that this tab owns
	// the node key it is about to start with, so the issued credential can be
	// attributed (and revoked) per peer id. A rejected assertion degrades to an
	// unauthenticated retry inside `loadIceConfig` — it never costs us STUN.
	const iceServers = await loadIceConfig({ signer: peerKeySigner(privateKey) });

	// Relay multiaddr(s) from the runtime manifest. When configured, the tab
	// listens on `/p2p-circuit` (+`/webrtc`) so it can hold a relay reservation
	// and become dialable for strand formation. Empty → Phase-1 solo posture.
	const relayAddrs = resolveRelayAddrs();

	// Durable node-local records, in the same control IndexedDB database as the
	// identity/party-id above (shared fate — see `node-local-slots.ts`). No
	// migration: an existing install has no persisted anchor, so it cold-starts
	// once — `runOwnerGenesis` below re-anchors this node's own key on every
	// start, and an invited tab re-anchors on its next applied seed. A read
	// failure here must propagate (fail the start), unlike the fail-soft
	// `runOwnerGenesis`/`reserveRelay` below — an unreadable anchor is a refusal
	// to start, not a silent downgrade to trusting nobody.
	trustedOwnerStore = await PersistentTrustedOwnerStore.open(
		kvSlot(controlHandle, TRUSTED_OWNERS_KV_KEY),
		partyId,
	);
	bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
		kvSlot(controlHandle, BOOTSTRAP_PEERS_KV_KEY),
		partyId,
	);

	const config: CadreNodeConfig = {
		privateKey,
		controlNetwork: {
			partyId,
			bootstrapNodes: [], // solo bring-up; Phase 2 adds cadre bootstrap
		},
		profile: 'transaction', // browser is an edge node, like the phone
		storage: { provider: storageProvider },
		network: {
			transports: [
				webSockets(),
				circuitRelayTransport(),
				// Brand-skew bridge — runtime-safe, see TransportFactory above.
				webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
				webRTCDirect() as unknown as TransportFactory,
			],
			// Dialable side of formation listens via circuit relay + WebRTC; solo
			// tabs (no relay configured) keep the Phase-1 no-listen posture.
			//
			// The BARE `/p2p-circuit` entry is load-bearing and deliberate: it puts
			// libp2p's circuit-relay listener in SEARCH mode, which registers a pending
			// reservation and never throws when a relay is unreachable. It does NOT make
			// the tab depend on libp2p's relay *discovery* — cadre-core fills that pending
			// reservation by asking the relay directly (discovery could never see this
			// relay; see `relay-reservation.ts`). `network.relayAddrs` is the other
			// route to a reservation — it builds a `<relay>/p2p-circuit` CONFIGURED
			// listener that is fatal at start when the relay is down (libp2p's
			// transport manager defaults to FATAL_ALL). A browser tab must still boot
			// solo when its relay is down, and strand nodes inherit the resolved
			// listen addrs verbatim, so do NOT set `network.relayAddrs` here — the two
			// are alternatives, not layers. See cadre-core `relay-reservation.ts`.
			listenAddrs: relayAddrs.length > 0 ? ['/p2p-circuit', '/webrtc'] : [],
			// Permissive dial gater. libp2p's browser default denies dialing
			// insecure-WebSocket and private/loopback addresses, which blocks the
			// reference app from dialing a local/unsecured peer — e.g. an
			// out-of-band invitation pointing at a `127.0.0.1/.../ws` responder, or
			// the strand-cohort dial in the formation→convergence e2e. This is a
			// dev/reference surface (see README), so allow those dials; the
			// canonical libp2p pattern is `denyDialMultiaddr: () => false`
			// (per @libp2p/webrtc docs). Applies to both the control node and every
			// formed strand's cohort node (cadre-core threads it to both).
			connectionGater: { denyDialMultiaddr: () => false },
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		trustedOwners: { store: trustedOwnerStore },
		bootstrapPeers: { store: bootstrapPeerStore },
	};

	node = new CadreNode(config);
	await node.start();

	exposeDebugHook(node);
	await runOwnerGenesis(node, privateKey);
	// Fail-soft in cadre-core: an unreachable relay leaves the tab in the solo
	// posture rather than aborting startup. This resolves once the FIRST attempt
	// settles — `retrying` if it failed — and cadre-core keeps a supervisor going
	// that recovers the reservation on its own if the relay shows up later.
	await node.reserveRelays(relayAddrs);

	return node;
}

/**
 * Solo owner self-genesis. A single-node cadre must seed itself as the
 * owner before it can author control-network writes. This reproduces the
 * `cadre-cli start --owner` path: bridge the libp2p identity into a
 * base64url owner keypair, run the idempotent genesis `OwnerKey` insert,
 * then initialize seed-bootstrap.
 *
 * Fail-soft: the Phase-1 chat round-trip needs no peers and does not
 * depend on owner, so a genesis failure is captured for diagnostics rather
 * than aborting node startup.
 *
 * NOTE: fail-soft covers thrown errors, not a call that never settles — a hung
 * `ensureOwnerKey` would leave `startCadre` awaiting forever with `ownerState`
 * stuck at its initial value. Nothing hangs today: `e2e/solo/diagnostics.spec.ts`
 * asserts `diag-owner` reaches `genesis|existing` on a solo boot, and
 * `cadre-core/test/control-database-solo.spec.ts` covers the no-listen-address
 * control path under explicit deadlines. If that changes, bound the operation in
 * cadre-core rather than wrapping each call site here.
 */
async function runOwnerGenesis(cadre: CadreNode, privateKey: PrivateKey): Promise<void> {
	try {
		const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(privateKey);
		const controlDb = cadre.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot run owner genesis');
		}
		const inserted = await controlDb.ensureOwnerKey(publicKeyB64);
		cadre.initializeSeedBootstrap(privateKeyB64);
		ownerState = inserted ? 'genesis' : 'existing';
		ownerError = null;
	} catch (err) {
		ownerState = 'error';
		ownerError = err instanceof Error ? err.message : String(err);
		console.warn('[reference-app-web] owner self-genesis failed:', err);
	}
}

// ── Strand formation (consent / invitation flow) ──────────────────────────────

/**
 * Lazily bring up the strand solicitation service (responder + initiator
 * transport). Idempotent; called by both {@link createInvitation} and
 * {@link joinViaInvitation}.
 *
 * Wires a {@link ControlFormationUsageRecorder} backed by the live control
 * database, mirroring RN's `initializeFormationResponder`
 * (`reference-app-rn/src/cadre-phone.ts`). Without it the responder accepts every
 * token blindly AND never resolves the host's bound strand — so a redeeming
 * `formStrand` would fall through to the responder-provisions placeholder and
 * return no `memberPrivateKey`. The recorder makes token validity + single-use
 * real and threads the bound host strand back (provision-then-record). The
 * control database must exist post-start, so its absence throws rather than
 * silently degrading to the no-recorder path.
 */
function ensureSolicitation(): CadreNode {
	if (!node) throw new Error('CadreNode not started');
	if (!solicitationReady) {
		const controlDb = node.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot wire formation responder');
		}
		node.initializeStrandSolicitation({
			formationUsageRecorder: new ControlFormationUsageRecorder(controlDb),
		});
		solicitationReady = true;
	}
	return node;
}

/** What {@link createInvitation} returns to the responder UI. */
export interface CreatedInvitation {
	/** Base64url-encoded `OpenInvitation` to copy out-of-band to the initiator. */
	encoded: string;
	token: string;
	sAppId: string;
	expiration: string;
	/**
	 * Id of the host closed strand the invite is bound to. A redeeming
	 * `formStrand` provisions THIS strand and returns its membership key
	 * (provision-then-record), so the host UI can track/render it.
	 */
	strandId: string;
}

/**
 * Host side of closed-strand formation: mint a membership key, publish the
 * `Strand` row (`Type:'c'`) under this node's owner, and attach the local
 * instance against the signed chat schema. Mirrors RN `createClosedChatStrand`
 * (`reference-app-rn/src/chat-strand.ts`); the web chat schema carries no member
 * role column, so unlike RN there is no owner/member role assignment to mirror —
 * bring-up is just `publishStrand` + `addStrand`.
 *
 * The strand's raw storage is pre-opened before `addStrand` (the provider is
 * synchronous), mirroring the Phase-1 chat-strand bring-up in {@link addChatStrand}.
 *
 * Returns the generated strand id + membership key so the caller can bind a
 * `FormationInvite` to the strand (provision-then-record) and track it.
 */
async function createClosedChatStrand(
	cadre: CadreNode,
): Promise<{ strandId: string; memberPrivateKey: string }> {
	const strandId = crypto.randomUUID();
	const memberPrivateKey = await generateStrandMemberKey();
	await openStores([strandId]);
	await cadre.publishStrand(strandId, 'c', memberPrivateKey);
	await cadre.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: memberPrivateKey, Type: 'c' },
		sAppConfig: getChatSAppConfig(),
		// This node provisioned + published the strand, so it is the founder: run the
		// one-time genesis bootstrap that seats Header/Member/Owner from
		// MemberPrivateKey. Idempotent (insert-if-absent) across reload / re-addStrand.
		founder: true,
	});
	return { strandId, memberPrivateKey };
}

/**
 * Responder/host side: provision a closed strand bound to a fresh open
 * invitation for the chat sApp, then encode that invitation for out-of-band
 * (copy/paste) delivery. Mirrors RN's `createClosedStrandWithInvite`
 * (`reference-app-rn/src/use-cadre.ts`):
 *
 *   1. create the host closed strand (mint member key + publish `Type:'c'` row +
 *      attach the local instance) so the invite has a real strand to bind to,
 *   2. mint the `OpenInvitation`, then
 *   3. publish a `FormationInvite` **bound to that strand id** so a redeeming
 *      `formStrand` resolves the host strand and returns its real membership key
 *      (provision-then-record), rather than the responder minting a fresh one.
 *
 * Requires the tab to be **dialable** — the invitation embeds this cadre's
 * multiaddrs, so `createOpenInvitation` throws when no relay reservation has
 * produced a `/p2p-circuit` address. The dialability guard runs before any
 * strand is published so an undialable tab leaves no dangling host strand.
 */
export async function createInvitation(
	expirationMs: number = 24 * 60 * 60 * 1000,
): Promise<CreatedInvitation> {
	const cadre = ensureSolicitation();
	// Live read: a reservation lost since start now fails this guard, so the
	// invitation is refused with a clear message instead of embedding circuit
	// addresses that no longer route.
	const relay = getRelayState();
	if (relay.status !== 'reserved') {
		throw new Error(
			'This tab is not dialable — strand formation needs a circuit-relay ' +
				'reservation. Configure a relay (VITE_RELAY_ADDR or localStorage ' +
				`"relay-addr"). Relay status: ${relay.status}` +
				(relay.error ? ` (${relay.error})` : ''),
		);
	}
	const { strandId, memberPrivateKey } = await createClosedChatStrand(cadre);
	const invitation = await cadre.createOpenInvitation(CHAT_SAPP_ID, expirationMs);
	await cadre.publishFormationInvite(invitation.token, CHAT_SAPP_ID, {
		expiresAtMs: invitation.expiration.getTime(),
		strandId,
	});
	// Track the host strand so diagnostics / getFormedStrands() stay consistent
	// with the joiner side (both record `type:'c'` + the gating member key).
	formedStrands.set(strandId, { strandId, memberKey: memberPrivateKey, type: 'c' });
	return {
		encoded: cadre.encodeInvitation(invitation),
		token: invitation.token,
		sAppId: invitation.sAppId,
		expiration: invitation.expiration.toISOString(),
		strandId,
	};
}

/**
 * Initiator side: decode an out-of-band invitation, run the formation protocol
 * against the responder's cadre, then launch the resulting **closed** strand
 * against the same signed chat schema using the host's read-gating membership key
 * (`FormStrandResult.memberPrivateKey`, delivered after consent).
 *
 * The closed strand's raw storage is pre-opened before `addStrand` (the provider
 * is synchronous), mirroring the Phase-1 chat-strand bring-up.
 */
export async function joinViaInvitation(
	encoded: string,
	disclosure: StrandFormationDisclosure = {},
): Promise<FormedStrand> {
	const cadre = ensureSolicitation();
	const invitation: OpenInvitation = cadre.decodeInvitation(encoded.trim());
	const result: FormStrandResult = await cadre.formStrand(invitation, {
		partyId: partyId ?? undefined,
		...disclosure,
	});

	// Provision the closed strand locally: pre-open its IndexedDB store, then add
	// it with the host's read-gating membership key. That key is `memberPrivateKey`
	// — the closed strand's secret the host provisions and returns over the
	// formation protocol after consent (provision-then-record) — NOT
	// `invitePrivateKey` (the initiator's own generated signing key, which is `''`
	// on the manager's dial path and cannot authorize reads). A closed-strand
	// `formStrand` always returns this key; its absence means the host strand was
	// not closed or the responder provisioned none, so fail loudly rather than
	// attach with a key that cannot read. Mirrors RN
	// `joinClosedChatStrandFromFormation` (`reference-app-rn/src/chat-strand.ts`).
	if (!result.memberPrivateKey) {
		throw new Error(
			'formStrand returned no membership key — the host strand is not closed or the ' +
				'responder provisioned no member key; cannot attach a closed chat strand',
		);
	}
	await openStores([result.strandId]);
	await cadre.addStrand({
		strandRow: {
			Id: result.strandId,
			MemberPrivateKey: result.memberPrivateKey,
			Type: 'c',
		},
		sAppConfig: getChatSAppConfig(),
	});

	const formed: FormedStrand = {
		strandId: result.strandId,
		// The read-gating membership key we attached with — the SAME secret the host
		// published (provision-then-record), NOT `result.memberKey` (our own partyId,
		// set on the manager's dial path). Keeps host/joiner `formedStrands` symmetric.
		memberKey: result.memberPrivateKey,
		type: 'c',
	};
	formedStrands.set(result.strandId, formed);
	return formed;
}

// ── RBAC / authorization gate (observability) ─────────────────────────────────

/**
 * Demonstrate the `CadreControl` owner gate: attempt a `Strand` insert that
 * claims an owner it does not hold (a non-enrolled key + bogus signature) and
 * carries no consuming `FormationUsage` row. The `Strand.AuthorizedInsert` constraint
 * satisfies *neither* branch, so the write must be rejected at commit.
 *
 * Returns `{ rejected: true }` when the constraint correctly blocks the write
 * (the RBAC gate is working) and `{ rejected: false }` if it unexpectedly
 * succeeds — a regression worth surfacing.
 */
export async function attemptUnauthorizedStrandWrite(): Promise<OwnerGateProbe> {
	if (!node) throw new Error('CadreNode not started');
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	const db = controlDb.getDatabase();
	const probeId = `rbac-probe-${node.peerId?.toString() ?? 'anon'}`;
	// Mirror the canonical authorized insert (control-database.ts `insertStrand`):
	// the `Strand` context is exactly `(OwnerKey, Signature)` and `StampId` is a
	// real `not null unique` column supplied in `values`. Providing a fresh StampId
	// keeps the not-null/anti-replay column satisfied so the ONLY failing condition
	// is the `AuthorizedInsert` check — no enrolled owner matches the bogus key and no
	// `FormationUsage` row consents — proving the rejection is the owner gate
	// itself, not an incidental column/context error.
	const stampId = `rbac-probe-stamp-${crypto.randomUUID()}`;
	try {
		await db.exec(
			`insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
				with context OwnerKey = ?, Signature = ?
				values (?, 'o', null, ?)`,
			['not-an-owner-key', 'bogus-signature', probeId, stampId],
		);
		// Reaching here means the gate let an unauthorized write through. Best-effort
		// cleanup is not attempted (the row is itself a regression marker).
		return { rejected: false, error: null };
	} catch (err) {
		return { rejected: true, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Read the control-network authorization ("RBAC") state for diagnostics: counts
 * of owner/validation keys, the `FormationInvite` / `FormationUsage` rows,
 * and each `Strand`'s membership type + member-key presence. Pure read-only SQL
 * over the control database's Quereus handle — no network round-trips.
 */
export async function readControlAuthorizationState(): Promise<ControlAuthorizationState> {
	if (!node) throw new Error('CadreNode not started');
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	const db = controlDb.getDatabase();

	const ownerKeyCount = await countRows(db, 'CadreControl.OwnerKey');
	const validationKeyCount = await countRows(db, 'CadreControl.ValidationKey');

	const formationInvites: FormationInviteRow[] = [];
	for await (const row of db.eval(
		'select Token, sAppId, ExpiresAt, TotalUses from CadreControl.FormationInvite',
	)) {
		formationInvites.push({
			token: row.Token as string,
			sAppId: (row.sAppId as string | null) ?? null,
			expiresAt: (row.ExpiresAt as string | null) ?? null,
			totalUses: (row.TotalUses as number | null) ?? null,
		});
	}

	const formationUsage: FormationUsageRow[] = [];
	for await (const row of db.eval(
		'select Token, UsageStampId, StrandId from CadreControl.FormationUsage',
	)) {
		formationUsage.push({
			token: row.Token as string,
			usageStampId: row.UsageStampId as string,
			strandId: (row.StrandId as string | null) ?? null,
		});
	}

	const strands: ControlStrandRow[] = (await controlDb.queryStrands()).map((s) => ({
		id: s.Id,
		type: s.Type,
		hasMemberKey: s.MemberPrivateKey != null && s.MemberPrivateKey.length > 0,
	}));

	return { ownerKeyCount, validationKeyCount, formationInvites, formationUsage, strands };
}

/** Count rows in a fully-qualified control table via a scalar aggregate. */
async function countRows(db: Database, table: string): Promise<number> {
	for await (const row of db.eval(`select count(1) as Count from ${table}`)) {
		return (row.Count as number) ?? 0;
	}
	return 0;
}

/**
 * Add the signed open chat strand. Pre-opens the strand's IndexedDB handle
 * (the provider is synchronous), then `addStrand`s an open strand. On a solo
 * node the strand's cohort is itself — it coordinates its own writes — so DML
 * lands on the strand's IndexedDB with no other peers needed.
 *
 * Throws `SchemaVerificationError` if the sApp signature does not match its
 * schema/version — the signature gate the reference is meant to exercise.
 */
export async function addChatStrand(): Promise<StrandInstance> {
	if (!node) throw new Error('CadreNode not started');
	await openStores([CHAT_STRAND_ID]);
	const instance = await node.addStrand({
		strandRow: { Id: CHAT_STRAND_ID, MemberPrivateKey: null, Type: 'o' },
		sAppConfig: getChatSAppConfig(),
		founder: true,
	});
	activeStrandId = CHAT_STRAND_ID;
	return instance;
}

/** Stop the node and release all IndexedDB handles. */
export async function stopCadre(): Promise<void> {
	if (node) {
		await node.stop();
		node = null;
	}
	clearDebugHook();
	await closeStores();
	controlStorage = null;
	partyId = null;
	activeStrandId = null;
	identityFirstSeenMs = null;
	ownerState = 'pending';
	ownerError = null;
	solicitationReady = false;
	formedStrands.clear();
	// The slot closures captured `controlHandle`, now closed by `closeStores()`
	// above — drop the references so nothing can write through a closed handle.
	trustedOwnerStore = null;
	bootstrapPeerStore = null;
}

// ── Formed-strand connectivity + DML (e2e formation→convergence hooks) ────────
//
// Formation exchanges peer addrs but does NOT persist them as `CadrePeer` rows,
// so the strand cohort seed stays empty and the two strand instances never
// auto-connect (strand peer discovery via the control network is still TODO). The
// e2e test wires the cohort link by hand — dialing one strand's libp2p node at the
// other's strand multiaddr — and reads/writes the FORMED strand (a responder-minted
// UUID strand, distinct from the solo `CHAT_STRAND_ID` the Messages UI renders).
// These helpers back the additive `__cadre` hooks for exactly that.

/**
 * Resolve a strand instance by id, or throw a clear, surfaced error. The strand
 * may be unknown (a strandId this tab never formed) — surfaced as a thrown error
 * rather than a bare `undefined` deref so the test (and devtools) fail loudly.
 * Targets the **strand-level** instance (`getStrand`), never the control node.
 */
function requireStrandInstance(strandId: string): StrandInstance {
	if (!node) throw new Error('CadreNode not started');
	const instance = node.getStrand(strandId);
	if (!instance) {
		throw new Error(`strand ${strandId} not found on this node`);
	}
	return instance;
}

/**
 * Resolve a strand instance's libp2p node, or throw a clear, surfaced error. A
 * strand that is still launching (or has been released) holds no node yet — that
 * surfaces as a thrown error rather than a bare `undefined` deref.
 */
function requireStrandLibp2p(strandId: string): Libp2p {
	const libp2pNode = requireStrandInstance(strandId).libp2pNode;
	if (!libp2pNode) {
		throw new Error(
			`strand ${strandId} has no libp2p node — it is still launching, or it was released`,
		);
	}
	return libp2pNode;
}

/**
 * Resolve a strand instance's attached Quereus database, or throw. Read/write
 * hooks need the DB handle (not the libp2p node), so this guards the strand not
 * yet being active (no attached database) separately. A wrong/unknown strandId
 * errors clearly rather than silently reading an empty solo strand.
 */
function requireStrandDatabase(strandId: string): Database {
	const instance = requireStrandInstance(strandId);
	if (!instance.database) {
		throw new Error(`strand ${strandId} has no database — it is still launching`);
	}
	return instance.database.getDatabase();
}

/**
 * The strand-level libp2p multiaddrs for a formed strand — the cohort peer's
 * dialable addresses, NOT the control node's. The second party dials one of these
 * to join the strand cohort.
 */
export function getStrandMultiaddrs(strandId: string): string[] {
	return requireStrandLibp2p(strandId).getMultiaddrs().map(String);
}

/**
 * Dial a strand-cohort peer's multiaddr from this strand's libp2p node, wiring the
 * cohort link the control network does not yet seed. libp2p handles an
 * already-connected dial idempotently; an unreachable addr surfaces the libp2p
 * error rather than wedging.
 */
export async function dialStrandPeer(strandId: string, addr: string): Promise<void> {
	await requireStrandLibp2p(strandId).dial(multiaddr(addr));
}

/**
 * Live strand-cohort connection count. The test polls this until ≥ 1 before
 * expecting convergence — a 2-member cohort commit needs a super-majority of 2, so
 * a write only lands once both members are connected.
 */
export function getStrandConnectionCount(strandId: string): number {
	return requireStrandLibp2p(strandId).getConnections().length;
}

/**
 * Upsert the author `Member` row then append an `App.Message` into the FORMED
 * strand's database (`getStrand(strandId)`), NOT the solo chat strand. Returns the
 * new message id. Reuses the shared chat DML so the write is byte-identical to the
 * Messages UI path (including the load-bearing Member-before-Message FK ordering).
 */
export async function writeChatMessage(
	strandId: string,
	message: { memberName: string; content: string },
): Promise<string> {
	return insertChatMessage(requireStrandDatabase(strandId), message.memberName, message.content);
}

/**
 * Read all `App.Message` rows from the FORMED strand's database, reduced to the
 * `{ id, memberId, content }` shape the e2e convergence assertion needs.
 */
export async function readChatMessages(
	strandId: string,
): Promise<Array<{ id: string; memberId: string; content: string }>> {
	const rows = await selectChatMessages(requireStrandDatabase(strandId));
	return rows.map((r) => ({ id: r.id, memberId: r.memberId, content: r.content }));
}

// ── Debug hook ────────────────────────────────────────────────────────────────

/**
 * Read-only `__cadre` global for devtools / future e2e — mirrors the old
 * `__optimystic` hook but surfaces cadre state (party id, control peer id +
 * connection count, chat strand status) without reaching into module scope.
 */
function exposeDebugHook(cadre: CadreNode): void {
	if (typeof window === 'undefined') return;
	(window as unknown as { __cadre?: unknown }).__cadre = {
		getPartyId: () => partyId,
		getControlPeerId: () => cadre.getControlNode()?.peerId.toString() ?? null,
		getConnectionCount: () => cadre.getControlNode()?.getConnections().length ?? 0,
		getStrandStatus: () => getChatStrand()?.status ?? null,
		getOwnerState: () => ownerState,
		// Phase 2 — formation + RBAC, surfaced for e2e drive/assert.
		// Delegate, never capture — the posture is derived live from the node.
		getRelayState: () => getRelayState(),
		getFormedStrands: () => getFormedStrands(),
		createInvitation: (expirationMs?: number) => createInvitation(expirationMs),
		joinViaInvitation: (encoded: string, disclosure?: StrandFormationDisclosure) =>
			joinViaInvitation(encoded, disclosure),
		attemptUnauthorizedStrandWrite: () => attemptUnauthorizedStrandWrite(),
		readControlAuthorizationState: () => readControlAuthorizationState(),
		// Formed-strand cohort connectivity + DML — the test wires the strand peer
		// link by hand and reads/writes the formed (closed) strand directly.
		getStrandMultiaddrs: (strandId: string) => getStrandMultiaddrs(strandId),
		dialStrandPeer: (strandId: string, addr: string) => dialStrandPeer(strandId, addr),
		getStrandConnectionCount: (strandId: string) => getStrandConnectionCount(strandId),
		writeChatMessage: (strandId: string, message: { memberName: string; content: string }) =>
			writeChatMessage(strandId, message),
		readChatMessages: (strandId: string) => readChatMessages(strandId),
	};
}

function clearDebugHook(): void {
	if (typeof window === 'undefined') return;
	delete (window as unknown as { __cadre?: unknown }).__cadre;
}
