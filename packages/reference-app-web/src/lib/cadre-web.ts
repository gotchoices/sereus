/**
 * cadre-web.ts — CadreNode lifecycle for the browser reference.
 *
 * This is the browser counterpart to `reference-app-rn/src/cadre-phone.ts`. It
 * brings up a real Sereus stack in the browser:
 *   CadreNode → control network (`CadreControl`) → signed open chat strand.
 *
 * Browser specifics vs the phone:
 *   - WebSocket + circuit-relay + WebRTC(+direct) transports (no TCP in a tab).
 *   - IndexedDB-backed raw storage via `strand-storage.ts` (per-scope handles
 *     pre-opened before the synchronous cadre-core storage provider is hit).
 *   - Ed25519 identity + the start record (`party-start.ts`: the party and how the tab
 *     came to it) persisted in the node-local IndexedDB database across reloads,
 *     alongside the per-party durable trusted-owner anchor and bootstrap-peer store
 *     (`node-local-slots.ts`) — same database, shared fate. That database is
 *     deliberately NOT the control block store: cadre-core scopes the control blocks
 *     by party id, and the party id is read out of this one.
 *   - Transaction profile — the browser is an edge node, like the phone.
 *
 * A tab founds a party on its first load and self-seeds as its owner (mirroring
 * `cadre-cli start --owner`); the solo chat strand coordinates its own writes, so DML
 * lands on the strand's IndexedDB without any peers. A tab can then join the user's
 * existing cadre by invitation, which moves its one node to that party, carrying the
 * founded party's strands along, and later remove the party it left. The web app has no
 * kit: `web-join.ts` follows the phone kit's sequence (architecture.md → "An app joins an
 * existing cadre"; `packages/cadre-rn/src/phone-node/node.ts`) itself, over this module's
 * lifecycle exports.
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
	generateStrandMemberKey,
	PersistentTrustedOwnerStore,
	PersistentBootstrapPeerStore,
	PersistentEnrolledMachineStore,
	PersistentStrandNetworkStateStore,
	controlStorageScope,
	resolveStunServers,
} from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	StrandInstance,
	OpenInvitation,
	FormStrandResult,
	StrandFormationDisclosure,
	TrustedOwnerStore,
	BootstrapPeerStore,
	EnrolledMachineStore,
	RelayReservationState,
	CreateCadreInvitationOptions,
	CreateCadreInvitationResult,
	CadreInviteStatus,
} from '@serfab/cadre-core';
import type { Libp2p } from '@libp2p/interface';
import type { IRawStorage } from '@optimystic/db-p2p';
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
import { resolveRelayAddrs } from './relay-config.js';
import {
	openStores,
	closeStores,
	storageProvider,
	getStoreHandle,
	getStoreStorage,
	NODE_LOCAL_STORE_KEY,
} from './strand-storage.js';
import {
	kvSlot,
	partyKvKey,
	TRUSTED_OWNERS_KV_KEY,
	BOOTSTRAP_PEERS_KV_KEY,
	ENROLLED_MACHINES_KV_KEY,
	STRAND_NETWORK_KV_KEY,
} from './node-local-slots.js';
import {
	foundedStart,
	newFoundedStart,
	readPartyStart,
	writePartyStart,
	type PartyOrigin,
	type PartyStart,
} from './party-start.js';
import { adoptMovesInto, StrandMoveRecords } from './web-strand-move.js';
import { finishRemovalAtStart, type UnfinishedRemoval } from './web-dissolve.js';
import { getChatSAppConfig, CHAT_STRAND_ID, CHAT_SAPP_ID } from './chat-strand.js';
import { insertChatMessage, newChatMessageId, selectChatMessages } from './chat-dml.js';

/**
 * How the start settled this tab's owner key. A party the tab founded runs owner genesis:
 * `genesis` (this start inserted the founding `OwnerKey` row) or `existing` (it was there).
 * A party the tab joined never does: `enrolled` when the party lists the tab's key as an
 * owner and it is wired for signing, `member` when it does not.
 */
export type OwnerState = 'pending' | 'genesis' | 'existing' | 'enrolled' | 'member' | 'error';

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

const IDENTITY_FIRST_SEEN_KEY = 'identity-first-seen';

/**
 * How often {@link wireJoinedOwnerKey} asks again for an owner key a redemption just granted,
 * and for how long, as the phone kit's `wireJoinedOwnerKey` does. A start that gives up wires
 * the key on the next start.
 */
const GRANTED_OWNER_RECHECK_MS = 2_000;
const GRANTED_OWNER_WAIT_MS = 60_000;

let node: CadreNode | null = null;
let controlStorage: IRawStorage | null = null;
/**
 * The party-scoped key of the control BLOCK store, set by {@link bringUp} once it knows
 * the party id. Held rather than re-derived at each getter, so there is exactly one
 * place the key is computed and the diagnostics getters cannot drift from the store the
 * node was actually handed. Null before a start and after {@link stopCadre}.
 */
let controlStoreKey: string | null = null;
/**
 * The start the running node was started with. The stored record, except during a join,
 * when it is the joined party's unwritten start until a member admits the tab
 * (`web-join.ts` → `switchToParty`), and while a dissolve reads the party it removes
 * ({@link readPartyAlone}). Null before a start and after {@link stopCadre}.
 */
let partyStart: PartyStart | null = null;
/** The removal a dissolve marker names that the running node's start could not finish. */
let unfinishedRemoval: UnfinishedRemoval | null = null;
let activeStrandId: string | null = null;
let identityFirstSeenMs: number | null = null;
let ownerState: OwnerState = 'pending';
let ownerError: string | null = null;
/** This tab's owner public key (base64url), bridged from its identity by {@link bringUp}. */
let ownerPublicKey: string | null = null;
let trustedOwnerStore: TrustedOwnerStore | null = null;
let bootstrapPeerStore: BootstrapPeerStore | null = null;
let enrolledMachineStore: EnrolledMachineStore | null = null;
/** The strand move records, over the node-local database; open while a node runs. */
let moveRecords: StrandMoveRecords | null = null;
// NOTE: accepted tradeoff — joins live only here and the node is built with `privateKey` and no durable `joinedStrands.store`, with no `strand:discovered` handler, so a strand joined from another party is lost on reload (named in the #18 release note); the plan for `cadre-core-remembers-joined-strands` left the web app as is; revisit if the web app is expected to survive a reload as a joiner. The same applies to strands a join moves into the party the tab joined (`adoptMovesInto`): their rows, party keys and invitations reach that party, and the strands sit in the node's discovered map, carried but not opened here.
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
	return partyStart?.partyId ?? null;
}

/** The start the running node was started with (see {@link partyStart}); null while no node runs. */
export function getPartyStart(): PartyStart | null {
	return partyStart;
}

/**
 * The old cadre's removal a marker names that the running node's start tried to finish and could
 * not (`web-dissolve.ts` → `finishRemovalAtStart`); null when there was none. The next start retries.
 */
export function getUnfinishedRemoval(): UnfinishedRemoval | null {
	return unfinishedRemoval;
}

export function getChatStrandId(): string | null {
	return activeStrandId;
}

export function getChatStrand(): StrandInstance | undefined {
	if (!node || !activeStrandId) return undefined;
	return node.getStrand(activeStrandId);
}

/**
 * The control BLOCK store's IndexedDB handle — used by diagnostics for per-store row
 * counts. Party-scoped, so it is null until {@link startCadre} has read the party id.
 * NOT the node-local `kv` database (`NODE_LOCAL_STORE_KEY`), which holds identity and
 * anchors rather than blocks.
 */
export function getControlDbHandle(): OptimysticWebDBHandle | null {
	return controlStoreKey ? getStoreHandle(controlStoreKey) : null;
}

/** Control raw storage — used by diagnostics for the backend label + byte estimate. */
export function getControlStorage(): IRawStorage | null {
	return controlStorage;
}

/**
 * The node-local IndexedDB handle — the tab's identity, party id and durable slots
 * (`node-local-slots.ts`). Separate from {@link getControlDbHandle} since the control
 * block store became party-scoped: diagnostics counts the block object stores on that
 * one and the `kv` object store on this one.
 */
export function getNodeLocalDbHandle(): OptimysticWebDBHandle | null {
	return getStoreHandle(NODE_LOCAL_STORE_KEY);
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

// ── Persistence helpers (identity-first-seen, on the node-local DB) ───────────

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
 *
 * Starts the party `start` names, or the stored start record's, minting a party of
 * this tab's own when there is no record yet. A passed `start` is never written here:
 * a join passes the joined party's start and writes it only once a member admitted the
 * tab, and a rollback passes nothing, so the stored record is read again. Before the
 * node is built, a removal a dissolve marker names is finished (`finishRemovalAtStart`),
 * and the start drops that party as `formerPartyId`.
 *
 * The owner step depends on how the tab came to the party: a founded party runs owner
 * genesis, a joined one only wires the key when the party lists it as an owner
 * ({@link settleOwnerKey}). Then, with the key wired, every strand move record naming
 * this party is adopted ({@link adoptMovesInto}) before the start resolves, so a tab
 * closed after a join's admission finishes the move on its next load. A move record
 * IndexedDB refuses to read fails the start, as an unreadable anchor does.
 */
export async function startCadre(start?: PartyStart): Promise<CadreNode> {
	if (node) return node;
	try {
		const cadre = await bringUp(start);
		await settleOwnerKey(cadre, requireStart().origin);
		if (ownerKeyWired()) await adoptMovesInto(cadre, requireMoveRecords());
		return cadre;
	} catch (err) {
		// A failed start closes everything it opened, so the next call starts afresh. Its own
		// error is the one to report; a failure tearing down after it is only logged.
		await stopCadre().catch((cleanupErr: unknown) => {
			console.warn('[reference-app-web] cleaning up after a failed start failed:', cleanupErr);
		});
		throw err;
	}
}

/**
 * Start a node for `partyId` alone to run `read` on it, then stop it, whatever `read` does: a
 * dissolve reads the party it removes this way (`web-join.ts` → `removeFormerParty`). Nothing
 * is written to the start record, no strand launches, no relay is reserved, no owner step runs
 * and no move is adopted; the node never reaches the store. Throws while a node runs.
 */
export async function readPartyAlone<T>(partyId: string, read: (cadre: CadreNode) => Promise<T>): Promise<T> {
	if (node) throw new Error('A node is running; stop it before reading another party');
	try {
		return await read(await bringUp(foundedStart(partyId), 'read'));
	} finally {
		// The read's own error, if any, is the one to report.
		await stopCadre().catch((err: unknown) => {
			console.warn(`[reference-app-web] stopping the node started to read party ${partyId} failed:`, err);
		});
	}
}

/** `run`: the tab's node. `read`: a node started only to read a party ({@link readPartyAlone}). */
type BringUpPurpose = 'run' | 'read';

/**
 * Open the stores, build and start the node for `start` (the stored record's, or a fresh
 * founded party's, when none is given), set every module-level getter's source, and
 * reserve the relay. The owner step is the caller's: {@link startCadre} settles it by
 * origin, while a join redeems its invitation first (`web-join.ts` → `switchToParty`).
 *
 * `read` builds the node {@link readPartyAlone} needs: no strand admitted, no relay, no debug
 * hook, and no dissolve marker finished, since the party read may be the one a marker names.
 */
export async function bringUp(start?: PartyStart, purpose: BringUpPurpose = 'run'): Promise<CadreNode> {
	// Two databases, opened in order, because the second's NAME depends on the first's
	// contents. The node-local database holds this tab's identity, its start record and
	// its per-party durable slots; cadre-core's control block store is keyed by party id,
	// so it cannot be opened until the party id has been read out of the first.
	await openStores([NODE_LOCAL_STORE_KEY]);
	const nodeLocalHandle = getStoreHandle(NODE_LOCAL_STORE_KEY)!;

	const named = start ?? (await loadOrCreatePartyStart(nodeLocalHandle));
	const resolved = purpose === 'run' ? await finishBegunRemoval(nodeLocalHandle, named) : named;
	const { partyId } = resolved;
	identityFirstSeenMs = await trackIdentityFirstSeen(nodeLocalHandle, DEFAULT_PEER_KEY_NAME);
	const privateKey = await loadOrCreateBrowserPeerKey(nodeLocalHandle);
	// The identity-derived owner key, whichever party runs: `isOwner()` asks the party's
	// `OwnerKey` rows for it, and `wireOwnKeyIfOwner` / genesis wire it for signing.
	ownerPublicKey = ed25519KeyPairFromLibp2p(privateKey).publicKeyB64;

	// Now the party id is known, pre-open the party-scoped control block store — the key
	// cadre-core's synchronous provider will ask for during `node.start()` below.
	controlStoreKey = controlStorageScope(partyId);
	await openStores([controlStoreKey]);
	controlStorage = getStoreStorage(controlStoreKey);

	// Relay multiaddr(s) from the runtime manifest. When configured, the tab
	// listens on `/p2p-circuit` (+`/webrtc`) so it can hold a relay reservation
	// and become dialable for strand formation. Empty → Phase-1 solo posture.
	const relayAddrs = purpose === 'run' ? resolveRelayAddrs() : [];

	// STUN for the WebRTC upgrade: each relay is also a STUN server. `[]` with no
	// relay configured and no override (host/LAN candidates still work).
	const iceServers = resolveStunServers(relayAddrs, import.meta.env.VITE_STUN_URLS);

	// Durable node-local records, in the same node-local IndexedDB database as the
	// identity/start record above (shared fate — see `node-local-slots.ts`), each under
	// the party's own key: a tab that joins another cadre switches party, and comes
	// back to the founded one if the join fails, so one key per tab would have the
	// joined party's first save overwrite the founded party's records. A read
	// failure here must propagate (fail the start), unlike the fail-soft owner step
	// and `reserveRelay` below — an unreadable anchor is a refusal to start, not a
	// silent downgrade to trusting nobody.
	trustedOwnerStore = await PersistentTrustedOwnerStore.open(
		kvSlot(nodeLocalHandle, partyKvKey(TRUSTED_OWNERS_KV_KEY, partyId)),
		partyId,
	);
	bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
		kvSlot(nodeLocalHandle, partyKvKey(BOOTSTRAP_PEERS_KV_KEY, partyId)),
		partyId,
	);
	// The party's enrolled-machine count, from which the control node declares its
	// block-repair yardstick at bring-up — before the database that could answer the
	// question live exists. Unlike the two records above, an unreadable slot here does
	// NOT fail the start: the count is a repair hint, so `open` cold-starts and the
	// tab simply declares nothing.
	enrolledMachineStore = await PersistentEnrolledMachineStore.open(
		kvSlot(nodeLocalHandle, partyKvKey(ENROLLED_MACHINES_KV_KEY, partyId)),
		partyId,
	);
	// Each strand node's saved network state — the FRET routing table it re-imports
	// after a reload, with every peer's signed address record. Same database, its own
	// key; FRET verifies each record at import.
	const strandNetworkStateStore = await PersistentStrandNetworkStateStore.open(
		kvSlot(nodeLocalHandle, partyKvKey(STRAND_NETWORK_KV_KEY, partyId)),
		partyId,
	);
	moveRecords = new StrandMoveRecords(nodeLocalHandle);

	const config: CadreNodeConfig = {
		privateKey,
		controlNetwork: {
			partyId,
			// None: a founded party is solo, and a joined one dials the member that admitted
			// the tab from the bootstrap-peer store, where the redemption retained it.
			bootstrapNodes: [],
		},
		profile: 'transaction', // browser is an edge node, like the phone
		storage: { provider: storageProvider },
		network: {
			transports: [
				webSockets(),
				circuitRelayTransport(),
				webRTC({ rtcConfiguration: { iceServers } }),
				webRTCDirect(),
			],
			// Dialable side of formation listens via circuit relay + WebRTC; solo
			// tabs (no relay configured) keep the Phase-1 no-listen posture.
			//
			// The BARE `/p2p-circuit` entry is load-bearing and deliberate: it puts
			// libp2p's circuit-relay listener in SEARCH mode, which registers a pending
			// reservation and never throws when a relay is unreachable. It does NOT make
			// the tab depend on libp2p's relay *discovery* — cadre-core fills that pending
			// reservation by asking the relay directly (discovery could never see this
			// relay; see `relay-reservation.ts`). `network.relayAddrs` would produce the
			// same bare entry on the control node, and is not set here for a reason that
			// has since been lifted: it used to make a first reservation attempt that does
			// not land FATAL to `start()`, and a browser tab must still boot solo when its
			// relay is down. `network.requireRelay: false` (cadre-core `types.ts`) is now
			// that same tolerance for a CONFIGURED relay, so the tab could switch — it has
			// not, so for now it keeps the explicit `reserveRelays` call below: same drive,
			// fail-soft posture.
			//
			// NOTE: `reserveRelays` reaches the CONTROL node only. `network.relayAddrs` is
			// what gives a strand node a supervised reservation of its own (one per relay,
			// `strand-network-config.ts`); this tab's strand nodes inherit the bare entry
			// below and nothing drives it, so they publish no circuit addr of their own and
			// are not dialable inbound. Switching this config to
			// `relayAddrs` + `requireRelay: false` is what closes it; the phone takes that
			// route first (ticket `phone-becomes-reachable-through-a-relay`), and the tab
			// should follow it rather than invent a second shape.
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
		strandFilter: purpose === 'run' ? { mode: 'all' } : { mode: 'none' },
		hibernation: { enabled: false },
		trustedOwners: { store: trustedOwnerStore },
		bootstrapPeers: { store: bootstrapPeerStore },
		enrolledMachines: { store: enrolledMachineStore },
		strandNetworkState: { store: strandNetworkStateStore },
	};

	const cadre = new CadreNode(config);
	node = cadre;
	partyStart = resolved;
	await cadre.start();
	if (purpose === 'read') return cadre;

	exposeDebugHook(cadre);
	// Fail-soft in cadre-core: an unreachable relay leaves the tab in the solo
	// posture rather than aborting startup. This resolves once the FIRST attempt
	// settles — `retrying` if it failed — and cadre-core keeps a supervisor going
	// that recovers the reservation on its own if the relay shows up later.
	await cadre.reserveRelays(relayAddrs);

	return cadre;
}

/**
 * The stored start record, or a fresh founded party's, written in one `put` before it is
 * used. A tab with only the old `party-id` key (before the start record) starts a fresh
 * party: no compatibility read.
 */
async function loadOrCreatePartyStart(handle: OptimysticWebDBHandle): Promise<PartyStart> {
	const stored = await readPartyStart(handle);
	if (stored) return stored;
	const fresh = newFoundedStart();
	await writePartyStart(handle, fresh);
	return fresh;
}

/** `finishRemovalAtStart`, keeping what it could not finish for {@link getUnfinishedRemoval}. */
async function finishBegunRemoval(handle: OptimysticWebDBHandle, starting: PartyStart): Promise<PartyStart> {
	const { start, unfinished } = await finishRemovalAtStart(handle, starting);
	unfinishedRemoval = unfinished;
	return start;
}

/** {@link getPartyStart}, throwing while no node runs. */
export function requireStart(): PartyStart {
	if (!partyStart) throw new Error('CadreNode not started');
	return partyStart;
}

/** The strand move records, over the node-local database; throws while no node runs. */
export function requireMoveRecords(): StrandMoveRecords {
	if (!moveRecords) throw new Error('CadreNode not started');
	return moveRecords;
}

// ── Owner step ────────────────────────────────────────────────────────────────

/**
 * A founded party runs owner genesis; a joined one only wires a key the party already lists
 * (`granted`: a redemption has just made the key an owner, so wait for the row).
 */
function settleOwnerKey(cadre: CadreNode, origin: PartyOrigin, granted = false): Promise<void> {
	return origin === 'founded' ? runOwnerGenesis(cadre) : wireJoinedOwnerKey(cadre, granted);
}

/** Whether this tab's key is wired for owner signing on the running node, whichever way the start settled it. */
export function ownerKeyWired(): boolean {
	return ownerState === 'genesis' || ownerState === 'existing' || ownerState === 'enrolled';
}

/**
 * Solo owner self-genesis, for a party this tab founded. A single-node cadre must
 * seed itself as the owner before it can author control-network writes. This
 * reproduces the `cadre-cli start --owner` path: take the identity-derived owner
 * keypair, run the idempotent genesis `OwnerKey` insert, then initialize
 * seed-bootstrap. Never for a party the tab joined: genesis on a party whose
 * control store has not arrived would seat the tab's key as a founding owner.
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
 * cadre-core rather than wrapping each call site here. The same holds for the joined
 * party's {@link wireJoinedOwnerKey}: its deadline bounds the re-asks, not one
 * `wireOwnKeyIfOwner` call (the kit races each against a timer; this copy does not).
 */
async function runOwnerGenesis(cadre: CadreNode): Promise<void> {
	try {
		const { privateKeyB64, publicKeyB64 } = cadre.getIdentityOwnerKey();
		const controlDb = cadre.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot run owner genesis');
		}
		const inserted = await controlDb.ensureOwnerKey(publicKeyB64);
		await cadre.initializeSeedBootstrap(privateKeyB64);
		ownerState = inserted ? 'genesis' : 'existing';
		ownerError = null;
	} catch (err) {
		ownerState = 'error';
		ownerError = err instanceof Error ? err.message : String(err);
		console.warn('[reference-app-web] owner self-genesis failed:', err);
	}
}

/**
 * The owner step of a party this tab joined: wire the identity key for signing only when
 * the party lists it as a live owner (`CadreNode.wireOwnKeyIfOwner`), never insert an
 * `OwnerKey` row, so a joined tab can neither seat itself as a founder nor anchor a key that
 * is no owner's. `enrolled` when wired, `member` otherwise. Fail-soft as genesis is.
 *
 * `granted`: a redemption has just made this key an owner, so a key not listed yet means
 * the row has not reached this node, not that it is no owner. It is asked again every 2 s
 * for up to a minute; a start that gives up wires it on the next start.
 */
export async function wireJoinedOwnerKey(cadre: CadreNode, granted: boolean): Promise<void> {
	try {
		const deadline = Date.now() + GRANTED_OWNER_WAIT_MS;
		while (!(await cadre.wireOwnKeyIfOwner())) {
			if (!granted || Date.now() >= deadline) {
				ownerState = 'member';
				ownerError = null;
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, GRANTED_OWNER_RECHECK_MS));
		}
		ownerState = 'enrolled';
		ownerError = null;
	} catch (err) {
		ownerState = 'error';
		ownerError = err instanceof Error ? err.message : String(err);
		console.warn('[reference-app-web] wiring the joined owner key failed:', err);
	}
}

// ── Strand formation (consent / invitation flow) ──────────────────────────────

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
 * (`reference-app-rn/src/chat-strand.ts`), except that the web app assigns no
 * owner/member role: the chat schema's `Participant.Role` column is left at its
 * `'member'` default, so bring-up is one `foundStrand` call.
 *
 * `foundStrand` does both control-plane steps (publish + attach as founder, which
 * runs the one-time genesis bootstrap seating Header/Member/Owner from this party's
 * own `StrandPartyKey` identity, minted by the publish — NOT from the shared
 * `MemberPrivateKey`) and is safe to re-run: a tab closed between them resumes
 * rather than failing forever on `UNIQUE constraint failed: Strand.Id`. The id
 * here is freshly minted per call, so the resume path is reached only if a caller
 * ever passes a stable id — but going through the one entry point is what keeps
 * this call site off the pattern that bricks when they do.
 *
 * The strand's raw storage is pre-opened before founding (the provider is
 * synchronous), mirroring the Phase-1 chat-strand bring-up in {@link addChatStrand}.
 *
 * Returns the generated strand id + the membership key the strand ACTUALLY runs
 * under (the resolved row's, not necessarily the one minted here) so the caller
 * can bind a `FormationInvite` to the strand (provision-then-record) and track it.
 */
async function createClosedChatStrand(
	cadre: CadreNode,
): Promise<{ strandId: string; memberPrivateKey: string }> {
	const strandId = crypto.randomUUID();
	await openStores([strandId]);
	const { strandRow } = await cadre.foundStrand({
		strandId,
		type: 'c',
		memberPrivateKey: await generateStrandMemberKey(),
		sAppConfig: getChatSAppConfig(),
	});
	if (!strandRow.MemberPrivateKey) {
		throw new Error(
			`Closed strand ${strandId} was founded without a MemberPrivateKey — no ` +
				'invitation bound to it could read the strand',
		);
	}
	return { strandId, memberPrivateKey: strandRow.MemberPrivateKey };
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
	if (!node) throw new Error('CadreNode not started');
	const cadre = node;
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
	if (!node) throw new Error('CadreNode not started');
	const cadre = node;
	const invitation: OpenInvitation = cadre.decodeInvitation(encoded.trim());
	const result: FormStrandResult = await cadre.formStrand(invitation, {
		partyId: partyStart?.partyId,
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
			FounderOwnerKey: null,
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

// ── Cadre invitations (adding a device or app) ────────────────────────────────

/**
 * Whether this tab's owner key is one of the cadre's owner keys: only an owner can mint a
 * cadre invitation. False when owner genesis never derived the key.
 */
export async function isOwner(): Promise<boolean> {
	if (!node) throw new Error('CadreNode not started');
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	if (!ownerPublicKey) return false;
	return (await controlDb.getOwnerKeys()).has(ownerPublicKey);
}

/**
 * Whether `peerId` is already a machine of this cadre (a `CadrePeer` row that is not
 * revoked), so an owner is not offered an invitation for an app the cadre holds.
 */
export async function isMemberPeer(peerId: string): Promise<boolean> {
	if (!node) throw new Error('CadreNode not started');
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	return (await controlDb.queryCadrePeers()).some((row) => row.peerId === peerId);
}

/**
 * Mint an invitation into this cadre, for one app's peer id or for whoever redeems it
 * first. Thin pass-through to `CadreNode.createCadreInvitation`.
 */
export async function createCadreInvitation(
	options: CreateCadreInvitationOptions,
): Promise<CreateCadreInvitationResult> {
	if (!node) throw new Error('CadreNode not started');
	return node.createCadreInvitation(options);
}

/** Every cadre invitation the node holds, with its standing. Thin pass-through to `CadreNode.listCadreInvitations`. */
export async function listCadreInvitations(): Promise<CadreInviteStatus[]> {
	if (!node) throw new Error('CadreNode not started');
	return node.listCadreInvitations();
}

/**
 * Withdraw a cadre invitation by its key; false when it was already withdrawn or is not
 * held here. Thin pass-through to `CadreNode.withdrawCadreInvitation`.
 */
export async function withdrawCadreInvitation(key: string): Promise<boolean> {
	if (!node) throw new Error('CadreNode not started');
	return node.withdrawCadreInvitation(key);
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
 * Local to the tab, whichever party the node runs: `founder: true` with no control row
 * puts it in no strand bundle, so a join does not move it, and its database is keyed by
 * strand id, so after a join it keeps working in the joined party as the same strand.
 *
 * Throws `SchemaVerificationError` if the sApp signature does not match its
 * schema/version — the signature gate the reference is meant to exercise.
 */
export async function addChatStrand(): Promise<StrandInstance> {
	if (!node) throw new Error('CadreNode not started');
	await openStores([CHAT_STRAND_ID]);
	const instance = await node.addStrand({
		strandRow: { Id: CHAT_STRAND_ID, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
		sAppConfig: getChatSAppConfig(),
		founder: true,
	});
	activeStrandId = CHAT_STRAND_ID;
	return instance;
}

/**
 * Stop the node and release all IndexedDB handles. The node's references are cleared and
 * the stores closed even when `node.stop()` throws (a node whose start failed partway),
 * so a join's rollback can start the left party again over a clean slate; the throw is
 * rethrown after.
 */
export async function stopCadre(): Promise<void> {
	const stopping = node;
	node = null;
	try {
		if (stopping) await stopping.stop();
	} finally {
		clearDebugHook();
		await closeStores();
		controlStorage = null;
		controlStoreKey = null;
		partyStart = null;
		activeStrandId = null;
		identityFirstSeenMs = null;
		ownerState = 'pending';
		ownerError = null;
		ownerPublicKey = null;
		unfinishedRemoval = null;
		formedStrands.clear();
		// The slot closures captured `nodeLocalHandle`, now closed by `closeStores()`
		// above — drop the references so nothing can write through a closed handle.
		trustedOwnerStore = null;
		bootstrapPeerStore = null;
		enrolledMachineStore = null;
		moveRecords = null;
	}
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
 * Upsert the author `Participant` row then append an `App.Message` into the FORMED
 * strand's database (`getStrand(strandId)`), NOT the solo chat strand. Returns the
 * new message id. Reuses the shared chat DML so the write is byte-identical to the
 * Messages UI path (including the load-bearing Participant-before-Message FK ordering).
 *
 * Mints the key here rather than holding it across attempts, because nothing re-presents
 * this write: the e2e test calls it once and asserts on the id it returns. The composer,
 * which the user CAN press twice, holds its id instead (`messages.svelte.ts`).
 */
export async function writeChatMessage(
	strandId: string,
	message: { participantName: string; content: string },
): Promise<string> {
	const id = newChatMessageId();
	await insertChatMessage(
		requireStrandDatabase(strandId),
		id,
		message.participantName,
		message.content,
	);
	return id;
}

/**
 * Read all `App.Message` rows from the FORMED strand's database, reduced to the
 * `{ id, participantId, content }` shape the e2e convergence assertion needs.
 */
export async function readChatMessages(
	strandId: string,
): Promise<Array<{ id: string; participantId: string; content: string }>> {
	const rows = await selectChatMessages(requireStrandDatabase(strandId));
	return rows.map((r) => ({ id: r.id, participantId: r.participantId, content: r.content }));
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
		getPartyId: () => partyStart?.partyId ?? null,
		// The start record as the running node was started from, so a test can see how
		// the tab came to its party (`origin`) and which party it left (`formerPartyId`).
		getPartyStart: () => partyStart,
		getControlPeerId: () => cadre.getControlNode()?.peerId.toString() ?? null,
		getConnectionCount: () => cadre.getControlNode()?.getConnections().length ?? 0,
		getStrandStatus: () => getChatStrand()?.status ?? null,
		getOwnerState: () => ownerState,
		// Whether this tab's key is one of the running party's `OwnerKey` rows — what a joined
		// member must NOT be after a reload (genesis on a joined party would insert it).
		isOwner: () => isOwner(),
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
		writeChatMessage: (strandId: string, message: { participantName: string; content: string }) =>
			writeChatMessage(strandId, message),
		readChatMessages: (strandId: string) => readChatMessages(strandId),
	};
}

function clearDebugHook(): void {
	if (typeof window === 'undefined') return;
	delete (window as unknown as { __cadre?: unknown }).__cadre;
}
