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
 *     across reloads.
 *   - Transaction profile — the browser is an edge node, like the phone.
 *
 * The node self-seeds as its own authority (mirroring `cadre-cli start
 * --authority`); the solo chat strand runs in `bootstrap` mode so DML lands on
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
	authorityKeyFromLibp2p,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
} from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	StrandInstance,
	OpenInvitation,
	FormStrandResult,
	StrandFormationDisclosure,
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

/** Outcome of the solo authority self-genesis step. */
export type AuthorityState = 'pending' | 'genesis' | 'existing' | 'error';

/**
 * Relay-reservation posture for the dialable side of formation.
 *  - `none`    — no relay configured; the tab is solo/undialable (Phase-1 posture).
 *  - `dialing` — a relay is configured and a reservation is in flight.
 *  - `reserved`— a `/p2p-circuit` address is held, so the tab is dialable.
 *  - `error`   — the relay dial/reservation failed (see {@link RelayState.error}).
 */
export type RelayStatus = 'none' | 'dialing' | 'reserved' | 'error';

export interface RelayState {
	status: RelayStatus;
	/** Configured relay multiaddrs (from the runtime relay manifest). */
	addrs: string[];
	/** This tab's `/p2p-circuit` listen addresses once reserved (dialable side). */
	circuitAddrs: string[];
	error: string | null;
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
export interface AuthorityGateProbe {
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
	useNumber: number;
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
	authorityKeyCount: number;
	validationKeyCount: number;
	formationInvites: FormationInviteRow[];
	formationUsage: FormationUsageRow[];
	strands: ControlStrandRow[];
}

const PARTY_ID_KEY = 'party-id';
const IDENTITY_FIRST_SEEN_KEY = 'identity-first-seen';

/** How long to wait for a circuit-relay reservation before giving up. */
const RELAY_RESERVE_TIMEOUT_MS = 10_000;
const RELAY_RESERVE_POLL_MS = 250;

let node: CadreNode | null = null;
let controlStorage: IRawStorage | null = null;
let partyId: string | null = null;
let activeStrandId: string | null = null;
let identityFirstSeenMs: number | null = null;
let authorityState: AuthorityState = 'pending';
let authorityError: string | null = null;
let relayState: RelayState = { status: 'none', addrs: [], circuitAddrs: [], error: null };
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

export function getAuthorityState(): { state: AuthorityState; error: string | null } {
	return { state: authorityState, error: authorityError };
}

/** Relay-reservation posture (dialability for formation). */
export function getRelayState(): RelayState {
	return relayState;
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
	const privateKey = await loadOrCreateBrowserPeerKey(controlHandle);
	controlStorage = getStoreStorage(CONTROL_STORE_KEY);

	// ICE servers (STUN/TURN) from the runtime manifest. Never throws; `[]` when
	// no manifest is configured (host/LAN candidates still work).
	const iceServers = await loadIceConfig();

	// Relay multiaddr(s) from the runtime manifest. When configured, the tab
	// listens on `/p2p-circuit` (+`/webrtc`) so it can hold a relay reservation
	// and become dialable for strand formation. Empty → Phase-1 solo posture.
	const relayAddrs = resolveRelayAddrs();
	relayState = {
		status: relayAddrs.length > 0 ? 'dialing' : 'none',
		addrs: relayAddrs,
		circuitAddrs: [],
		error: null,
	};

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
	};

	node = new CadreNode(config);
	await node.start();

	exposeDebugHook(node);
	await runAuthorityGenesis(node, privateKey);
	await reserveRelay(node, relayAddrs);

	return node;
}

/**
 * Solo authority self-genesis. A single-node cadre must seed itself as the
 * authority before it can author control-network writes. This reproduces the
 * `cadre-cli start --authority` path: bridge the libp2p identity into a
 * base64url authority keypair, run the idempotent genesis `AuthorityKey` insert,
 * then initialize seed-bootstrap.
 *
 * Fail-soft: the Phase-1 chat round-trip runs in `bootstrap` mode and does not
 * depend on authority, so a genesis failure is captured for diagnostics rather
 * than aborting node startup.
 */
async function runAuthorityGenesis(cadre: CadreNode, privateKey: PrivateKey): Promise<void> {
	try {
		const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(privateKey);
		const controlDb = cadre.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot run authority genesis');
		}
		const inserted = await controlDb.ensureAuthorityKey(publicKeyB64);
		cadre.initializeSeedBootstrap(privateKeyB64);
		authorityState = inserted ? 'genesis' : 'existing';
		authorityError = null;
	} catch (err) {
		authorityState = 'error';
		authorityError = err instanceof Error ? err.message : String(err);
		console.warn('[reference-app-web] authority self-genesis failed:', err);
	}
}

/**
 * Dial the configured relay(s) and wait until a `/p2p-circuit` reservation makes
 * this tab dialable. Fail-soft: a missing/unreachable relay leaves the tab in
 * the solo posture (formation create/join then surface a clear "not dialable"
 * error) rather than aborting node startup. A no-op when no relay is configured.
 */
async function reserveRelay(cadre: CadreNode, relayAddrs: string[]): Promise<void> {
	if (relayAddrs.length === 0) {
		relayState = { status: 'none', addrs: [], circuitAddrs: [], error: null };
		return;
	}
	const control = cadre.getControlNode();
	if (!control) {
		relayState = { status: 'error', addrs: relayAddrs, circuitAddrs: [], error: 'control node unavailable' };
		return;
	}
	try {
		for (const addr of relayAddrs) {
			await control.dial(multiaddr(addr));
		}
		const circuitAddrs = await waitForCircuitReservation(control);
		if (circuitAddrs.length > 0) {
			relayState = { status: 'reserved', addrs: relayAddrs, circuitAddrs, error: null };
		} else {
			relayState = {
				status: 'error',
				addrs: relayAddrs,
				circuitAddrs: [],
				error: `no circuit reservation within ${RELAY_RESERVE_TIMEOUT_MS}ms`,
			};
		}
	} catch (err) {
		relayState = {
			status: 'error',
			addrs: relayAddrs,
			circuitAddrs: [],
			error: err instanceof Error ? err.message : String(err),
		};
		console.warn('[reference-app-web] relay reservation failed:', err);
	}
}

/** Poll the control node's multiaddrs until a `/p2p-circuit` address appears. */
async function waitForCircuitReservation(control: Libp2p): Promise<string[]> {
	const deadline = Date.now() + RELAY_RESERVE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const circuit = control
			.getMultiaddrs()
			.map((ma) => ma.toString())
			.filter((s) => s.includes('/p2p-circuit'));
		if (circuit.length > 0) return circuit;
		await delay(RELAY_RESERVE_POLL_MS);
	}
	return [];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
 * `Strand` row (`Type:'c'`) under this node's authority, and attach the local
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
		// Formed strands replicate across a cohort. Without an explicit mode,
		// addStrand infers `bootstrap` from the empty CadrePeer cohort (formation
		// exchanges peer addrs but persists no CadrePeer rows yet) and the strand
		// gets a local transactor that never replicates — the silent no-convergence
		// failure mode. `networked` launches even before the cohort peer dials in.
		mode: 'networked',
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
	if (relayState.status !== 'reserved') {
		throw new Error(
			'This tab is not dialable — strand formation needs a circuit-relay ' +
				'reservation. Configure a relay (VITE_RELAY_ADDR or localStorage ' +
				`"relay-addr"). Relay status: ${relayState.status}` +
				(relayState.error ? ` (${relayState.error})` : ''),
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
		// Formed strands replicate across a cohort — request `networked` explicitly
		// so the joiner's strand does not infer `bootstrap` from the empty CadrePeer
		// cohort and end up with a non-replicating local transactor. See the matching
		// note in createClosedChatStrand.
		mode: 'networked',
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
 * Demonstrate the `CadreControl` authority gate: attempt a `Strand` insert that
 * claims an authority it does not hold (a non-enrolled key + bogus signature) and
 * carries no consuming `FormationUsage` row. The `Strand.Authorized` constraint
 * satisfies *neither* branch, so the write must be rejected at commit.
 *
 * Returns `{ rejected: true }` when the constraint correctly blocks the write
 * (the RBAC gate is working) and `{ rejected: false }` if it unexpectedly
 * succeeds — a regression worth surfacing.
 */
export async function attemptUnauthorizedStrandWrite(): Promise<AuthorityGateProbe> {
	if (!node) throw new Error('CadreNode not started');
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	const db = controlDb.getDatabase();
	const probeId = `rbac-probe-${node.peerId?.toString() ?? 'anon'}`;
	// Mirror the canonical authorized insert (control-database.ts `insertStrand`):
	// the `Strand` context is exactly `(AuthorityKey, Signature)` and `StampId` is a
	// real `not null unique` column supplied in `values`. Providing a fresh StampId
	// keeps the not-null/anti-replay column satisfied so the ONLY failing condition
	// is the `Authorized` check — no enrolled authority matches the bogus key and no
	// `FormationUsage` row consents — proving the rejection is the authority gate
	// itself, not an incidental column/context error.
	const stampId = `rbac-probe-stamp-${crypto.randomUUID()}`;
	try {
		await db.exec(
			`insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
				with context AuthorityKey = ?, Signature = ?
				values (?, 'o', null, ?)`,
			['not-an-authority-key', 'bogus-signature', probeId, stampId],
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
 * of authority/validation keys, the `FormationInvite` / `FormationUsage` rows,
 * and each `Strand`'s membership type + member-key presence. Pure read-only SQL
 * over the control database's Quereus handle — no network round-trips.
 */
export async function readControlAuthorizationState(): Promise<ControlAuthorizationState> {
	if (!node) throw new Error('CadreNode not started');
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	const db = controlDb.getDatabase();

	const authorityKeyCount = await countRows(db, 'CadreControl.AuthorityKey');
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
		'select Token, UseNumber, StrandId from CadreControl.FormationUsage',
	)) {
		formationUsage.push({
			token: row.Token as string,
			useNumber: row.UseNumber as number,
			strandId: (row.StrandId as string | null) ?? null,
		});
	}

	const strands: ControlStrandRow[] = (await controlDb.queryStrands()).map((s) => ({
		id: s.Id,
		type: s.Type,
		hasMemberKey: s.MemberPrivateKey != null && s.MemberPrivateKey.length > 0,
	}));

	return { authorityKeyCount, validationKeyCount, formationInvites, formationUsage, strands };
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
 * node the strand auto-selects `bootstrap` mode (no other cadre peers), so DML
 * lands on the strand's IndexedDB local transactor with no peers needed.
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
	authorityState = 'pending';
	authorityError = null;
	relayState = { status: 'none', addrs: [], circuitAddrs: [], error: null };
	solicitationReady = false;
	formedStrands.clear();
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
 * Resolve a strand instance's libp2p node, or throw a clear, surfaced error. The
 * strand may be still launching, or in `bootstrap` mode with no libp2p node — both
 * surface as a thrown error rather than a bare `undefined` deref.
 */
function requireStrandLibp2p(strandId: string): Libp2p {
	const libp2pNode = requireStrandInstance(strandId).libp2pNode;
	if (!libp2pNode) {
		throw new Error(
			`strand ${strandId} has no libp2p node — it is still launching or runs in ` +
				'bootstrap mode (no cohort). Formed strands must be added with mode:"networked".',
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
		getAuthorityState: () => authorityState,
		// Phase 2 — formation + RBAC, surfaced for e2e drive/assert.
		getRelayState: () => relayState,
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
