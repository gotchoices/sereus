/**
 * cadre-phone.ts — CadreNode configured for a NativeScript phone node.
 *
 * - WebSocket + circuit-relay transports (NativeScript clients cannot listen,
 *   and have no TCP transport)
 * - SQLite-backed storage via @optimystic/db-p2p-storage-ns (lazy per-strand
 *   proxy — see ns-storage.ts)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Stable Ed25519 identity persisted in SQLite (key 'peer-private-key')
 * - Durable node-local records (trusted-owner anchor, cold-start bootstrap
 *   peers, enrolled-machine count, strand peer book, strand network state) and
 *   the saved start options in that same SQLite db — see node-local-slots.ts
 *
 * Mirrors packages/reference-app-rn/src/cadre-phone.ts with NS storage/identity.
 */

import {
	CadreNode,
	PersistentTrustedOwnerStore,
	PersistentBootstrapPeerStore,
	PersistentEnrolledMachineStore,
	PersistentStrandPeerBookStore,
	PersistentStrandNetworkStateStore,
} from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	ControlNetworkSeed,
	ApplySeedResult,
	StrandInstance,
	StrandConfig,
	ConnectionPathSummary,
	DurableSlot,
} from '@serfab/cadre-core';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { PrivateKey } from '@libp2p/interface';
import {
	loadOrCreateNSPeerKey,
	openOptimysticNSDb,
	SqliteKVStore,
	type OptimysticNSDBHandle,
} from '@optimystic/db-p2p-storage-ns';
import { makeLazyNsStorage } from './ns-storage';
import {
	anchorSlotKey,
	bootstrapPeersSlotKey,
	enrolledMachinesSlotKey,
	strandPeersSlotKey,
	strandNetworkSlotKey,
	kvSlot,
	START_OPTIONS_SLOT_KEY,
} from './node-local-slots';
import {
	parseSavedStartOptions,
	serializeSavedStartOptions,
	type PhoneNodeOptions,
	type SavedStartOptions,
} from './start-options';

export type { PhoneNodeOptions, SavedStartOptions };

// ── Peer identity ─────────────────────────────────────────────────────────────
// Persist a single Ed25519 keypair so the node keeps the same PeerId across
// restarts. The key lives as a BLOB in the `kv` table of a dedicated SQLite db
// (not Keychain/Keystore — secure storage is a future hardening step).

const PEER_IDENTITY_DB_NAME = 'sereus-peer-identity';

async function loadOrCreatePhoneKey(db: OptimysticNSDBHandle): Promise<PrivateKey> {
	// `loadOrCreateNSPeerKey` returns a PrivateKey branded by db-p2p-storage-ns's
	// own pinned `@libp2p/interface`/`uint8arraylist` copies (it is linked from a
	// separate install). Those carry a nominally-different `Uint8ArrayList[symbol]`
	// brand than sereus's copy — `uint8arraylist` declares it as a `unique symbol`,
	// which TypeScript treats per-copy — but the symbol is a global-registry key
	// (`Symbol.for`), so the types are runtime-identical. Bridge with
	// `as unknown as PrivateKey` — no `any`, no pinning transitive packages.
	// Mirrors the transport cast in reference-app-rn/src/cadre-phone.ts.
	return await loadOrCreateNSPeerKey(db) as unknown as PrivateKey;
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let node: CadreNode | null = null;

/**
 * The options {@link node} was started with — recorded only once a start SUCCEEDS,
 * so {@link stopPhoneNode} can mark exactly that configuration as no longer
 * auto-starting, and a start that failed has nothing for it to write.
 */
let nodeOptions: PhoneNodeOptions | null = null;

/**
 * The start in flight, if any. The launch auto-start (`CadreViewModel.restore`) and a
 * Connect tap can overlap; each gets this one promise rather than building a second
 * `CadreNode`.
 */
let starting: Promise<CadreNode> | null = null;

/** The {@link PEER_IDENTITY_DB_NAME} handle and the one node-local KV store over it. */
interface IdentityDb {
	db: OptimysticNSDBHandle;
	/**
	 * Empty prefix, not `SqliteKVStore`'s default `'optimystic:txn:'`: the slot keys
	 * are the literal `trusted-owners.<partyId>` / `start-options` / … strings of
	 * `node-local-slots.ts`, and this db holds nothing else under those names.
	 */
	nodeLocalKv: SqliteKVStore;
}

/**
 * The open (or opening) {@link PEER_IDENTITY_DB_NAME} SQLite database. It backs
 * things that deliberately share one fate: the Ed25519 identity BLOB, the five
 * party-scoped node-local records (trusted-owner anchor, bootstrap peers,
 * enrolled-machine count, strand peer book, strand network state) and the saved start
 * options, each under
 * its own key of `SqliteKVStore`'s `kv` table. This app has no Keychain/Keystore
 * integration (see the module comment), so the anchor is only as protected as the
 * plaintext identity it qualifies until that hardening lands — moving one without
 * the other would be a downgrade, not an improvement.
 *
 * The in-flight open PROMISE is cached, not the handle: the open is asynchronous, and
 * the launch-time read of the saved start options and a Connect tap can both reach
 * it, so caching only the resolved handle would let two overlapping opens each leak
 * one native handle, which blocks the next open of this file. Held open once opened —
 * for the node's life, or from the launch read until the next start reuses it — and
 * closed in {@link stopPhoneNode}; a rejected open is forgotten so the next call
 * retries.
 *
 * No migration: an existing install has no persisted record under these keys, so it
 * cold-starts once (empty anchor, empty bootstrap-peer set, no saved options) rather
 * than crashing or backfilling.
 */
let identityDbOpening: Promise<IdentityDb> | null = null;

function openIdentityDb(): Promise<IdentityDb> {
	if (identityDbOpening) return identityDbOpening;
	const opening = openOptimysticNSDb(PEER_IDENTITY_DB_NAME).then(
		(db): IdentityDb => ({ db, nodeLocalKv: new SqliteKVStore(db, '') }),
	);
	identityDbOpening = opening;
	// The rejection itself reaches every caller awaiting `opening`; this only forgets it.
	void opening.catch(() => {
		if (identityDbOpening === opening) identityDbOpening = null;
	});
	return opening;
}

/**
 * Close the identity database if it was opened, and forget it — cleared first, so a
 * failed close cannot leave a dangling handle that the next start would reuse. An open
 * that failed has nothing to close; its rejection was already reported to its caller.
 */
async function closeIdentityDb(): Promise<void> {
	const opening = identityDbOpening;
	identityDbOpening = null;
	if (!opening) return;
	const opened = await opening.catch(() => undefined);
	if (opened) await opened.db.close();
}

async function startOptionsSlot(): Promise<DurableSlot> {
	return kvSlot((await openIdentityDb()).nodeLocalKv, START_OPTIONS_SLOT_KEY);
}

/**
 * Get the CadreNode singleton, or null if not started.
 */
export function getPhoneNode(): CadreNode | null {
	return node;
}

/**
 * The options the node last started with, and whether it should start again
 * unattended (see `start-options.ts`); `undefined` when none are saved or the record
 * is unusable. A read FAULT propagates, so the caller can say the settings could not
 * be read rather than behave as if there were none.
 */
export async function loadSavedStartOptions(): Promise<SavedStartOptions | undefined> {
	return parseSavedStartOptions(await (await startOptionsSlot()).load());
}

/** Best-effort: a failed write is logged and changes nothing about the node. */
async function saveStartOptions(saved: SavedStartOptions): Promise<void> {
	try {
		await (await startOptionsSlot()).save(serializeSavedStartOptions(saved));
	} catch (err) {
		console.warn('[cadre-phone] could not save the start options:', err);
	}
}

/**
 * Start the phone CadreNode.
 * Idempotent — returns the start in flight if there is one, else the existing node if
 * it is running. A caller whose options differ gets that node anyway: whatever is
 * running wins, and only the call that did the work saves its options.
 */
export async function startPhoneNode(opts: PhoneNodeOptions): Promise<CadreNode> {
	if (starting) return starting;
	if (node?.isRunning) return node;
	starting = buildAndStartNode(opts).finally(() => {
		starting = null;
	});
	return starting;
}

async function buildAndStartNode(opts: PhoneNodeOptions): Promise<CadreNode> {
	// One handle for the node's life, reused for the identity load below and for every
	// node-local record — see the `identityDbOpening` doc comment for why they share
	// fate. A failed start leaves it open, so a retry reuses it.
	const { db, nodeLocalKv } = await openIdentityDb();

	const privateKey = await loadOrCreatePhoneKey(db);

	// Every record is party-scoped. They survive a relaunch because the party id does:
	// it is saved with the other start options below, and app launch starts from them.
	// A party id this phone has not started with before — a blank Party ID field mints
	// one — starts every slot empty.
	//
	// NOTE: the trusted-owner anchor is only as protected as the plaintext
	// identity BLOB it qualifies — this app has no Keychain/Keystore integration
	// (see the module comment above), unlike reference-app-rn's secure-enclave
	// anchor. Whoever adds NS secure storage must move both together.
	const trustedOwnerStore = await PersistentTrustedOwnerStore.open(
		kvSlot(nodeLocalKv, anchorSlotKey(opts.partyId)),
		opts.partyId,
	);
	const bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
		kvSlot(nodeLocalKv, bootstrapPeersSlotKey(opts.partyId)),
		opts.partyId,
	);
	// The party's enrolled-machine count, from which the control node declares its
	// block-repair yardstick at bring-up — before the database that could answer the
	// question live exists. Unlike the two records above, an unreadable slot here does
	// NOT fail the start: the count is a repair hint, so `open` cold-starts and the
	// node simply declares nothing.
	const enrolledMachineStore = await PersistentEnrolledMachineStore.open(
		kvSlot(nodeLocalKv, enrolledMachinesSlotKey(opts.partyId)),
		opts.partyId,
	);
	// The strand peers this phone has met, with their last-known addresses — what it
	// dials first for each strand after a relaunch. Same store, its own key, dial
	// hints only.
	const strandPeerBookStore = await PersistentStrandPeerBookStore.open(
		kvSlot(nodeLocalKv, strandPeersSlotKey(opts.partyId)),
		opts.partyId,
	);
	// Each strand node's saved network state — the FRET routing table it re-imports
	// after a relaunch, with every peer's signed address record. Same store, its own
	// key; FRET verifies each record at import.
	const strandNetworkStateStore = await PersistentStrandNetworkStateStore.open(
		kvSlot(nodeLocalKv, strandNetworkSlotKey(opts.partyId)),
		opts.partyId,
	);

	const config: CadreNodeConfig = {
		privateKey,
		controlNetwork: {
			partyId: opts.partyId,
			bootstrapNodes: opts.bootstrapAddrs,
		},
		profile: 'transaction',
		storage: {
			provider: (scope: string) => makeLazyNsStorage(scope),
		},
		network: {
			transports: [webSockets(), circuitRelayTransport()],
			listenAddrs: [], // NativeScript clients cannot listen for inbound connections
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		trustedOwners: { store: trustedOwnerStore },
		bootstrapPeers: { store: bootstrapPeerStore },
		enrolledMachines: { store: enrolledMachineStore },
		strandPeers: { store: strandPeerBookStore },
		strandNetworkState: { store: strandNetworkStateStore },
		// Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an
		// ed25519 author key — see getChatSAppConfig). Relax the fail-closed schema
		// policy so the demo can form strands. Production nodes must leave this unset.
		requireSignedSchemas: false,
	};

	const built = new CadreNode(config);
	node = built;
	await built.start();
	// Saved only now, so a start that failed — a typo in Settings — never replaces the
	// last configuration that actually came up.
	nodeOptions = opts;
	await saveStartOptions({ options: opts, autoStart: true });
	return built;
}

/**
 * Start in solo/forming mode — no drone, no network. The node forms its own
 * cadre and can create a local strand. This is the runtime-validation core of
 * the NS parity effort (createChatStrand → insertMessage → queryMessages).
 *
 * Like any start, a successful one is saved as the options the next launch starts
 * with — harmless for this programmatic smoke path, but it does replace whatever
 * Settings last connected with.
 */
export async function startSolo(partyId: string): Promise<CadreNode> {
	return startPhoneNode({ partyId, bootstrapAddrs: [] });
}

/**
 * Stop the phone CadreNode and release resources.
 */
export async function stopPhoneNode(): Promise<void> {
	// Disconnect tapped during a start (the launch auto-start) stops the node that start
	// produces rather than racing it. The start's failure is reported to its own
	// caller; here it only means there may be less to tear down.
	if (starting) {
		await starting.catch(() => undefined);
	}
	// Stopping is the user logging out (Settings → Disconnect is the only caller), so
	// the next launch must not start the node again by itself. Written while the
	// handle is still open; an OS kill runs none of this, which is why `autoStart`
	// survives one.
	if (nodeOptions) {
		await saveStartOptions({ options: nodeOptions, autoStart: false });
	}
	// Cleared BEFORE the stop, mirroring reference-app-rn's `stopPhoneNode`: a
	// throwing `node.stop()` must not leave a module-level reference to a node
	// whose identity database the `finally` below has just closed — the
	// `node?.isRunning` early-return in `startPhoneNode` would hand that node
	// back and its next node-local write would fail on a closed handle.
	//
	// NOTE: a `startPhoneNode` that arrives after this point and before the `finally`
	// builds a node on the handle the `finally` then closes, and saves `autoStart: true`
	// over the Disconnect. Unreachable today: Disconnect is shown only while connected,
	// and the launch auto-start starts only from `idle`. If a new unattended caller of
	// `startPhoneNode` appears, make a start wait for an in-flight stop.
	const stopping = node;
	node = null;
	nodeOptions = null;
	try {
		if (stopping) await stopping.stop();
	} finally {
		// Close even when `node.stop()` threw, and even when a failed
		// `startPhoneNode` never got as far as constructing the node — this is a
		// native SQLite handle, and a leaked one blocks the next open of this file.
		await closeIdentityDb();
	}
}

// Every helper below guards on `!node`, not on `node.isRunning`. A start that
// failed inside `CadreNode.start()` leaves a non-running node in the singleton
// until `stopPhoneNode` clears it, so these would forward to it.
// NOTE: unreachable today — the only UI path to them is `cadre-vm.ts`, which
// adopts a node solely when `isRunning` and sets status `error` on a failed
// start. If a caller ever reaches these without that gate, widen the guard here.

// ── Seed helpers ────────────────────────────────────────────────────────────────

/**
 * Apply a seed received from the drone (or another owner).
 */
export async function applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
	if (!node) throw new Error('Phone node not started');
	return node.applySeed(seed);
}

/**
 * Decode a base64url-encoded seed string into a ControlNetworkSeed object.
 */
export function decodeSeed(encoded: string): ControlNetworkSeed {
	if (!node) throw new Error('Phone node not started');
	return node.decodeSeed(encoded);
}

// ── Peer helpers ──────────────────────────────────────────────────────────────

/**
 * Dial a peer by multiaddr on the running control network node.
 */
export async function dialPeer(addr: string): Promise<void> {
	if (!node) throw new Error('Phone node not started');
	const libp2p = node.getControlNode();
	if (!libp2p) throw new Error('Control network not available');
	await libp2p.dial(multiaddr(addr));
}

// ── Diagnostics helpers ──────────────────────────────────────────────────────────

/**
 * Classify the node's open connections as relayed vs direct (by transport).
 */
export function getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
	if (!node) throw new Error('Phone node not started');
	return node.getConnectionPaths(settleWindowMs);
}

// ── Strand helpers ────────────────────────────────────────────────────────────────

/**
 * Add a strand to this node. The strand must already exist in the control
 * database (inserted via seed or direct write).
 */
export async function addStrand(config: StrandConfig): Promise<StrandInstance> {
	if (!node) throw new Error('Phone node not started');
	return node.addStrand(config);
}
