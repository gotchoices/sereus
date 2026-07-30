/**
 * cadre-phone.ts — CadreNode configured for a NativeScript phone node.
 *
 * - WebSocket + circuit-relay transports (NativeScript clients cannot listen,
 *   and have no TCP transport)
 * - SQLite-backed storage via @optimystic/db-p2p-storage-ns (lazy per-strand
 *   proxy — see ns-storage.ts)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Stable Ed25519 identity persisted in SQLite (key 'peer-private-key')
 * - Durable node-local records (trusted-owner anchor + cold-start bootstrap
 *   peers) in that same SQLite db — see node-local-slots.ts
 *
 * Mirrors packages/reference-app-rn/src/cadre-phone.ts with NS storage/identity.
 */

import { CadreNode, PersistentTrustedOwnerStore, PersistentBootstrapPeerStore } from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	ControlNetworkSeed,
	ApplySeedResult,
	StrandInstance,
	StrandConfig,
	ConnectionPathSummary,
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
import { anchorSlotKey, bootstrapPeersSlotKey, kvSlot } from './node-local-slots';

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
 * The {@link PEER_IDENTITY_DB_NAME} SQLite handle, held open for the node's
 * whole life. It backs three things that deliberately share one fate: the
 * Ed25519 identity BLOB, the trusted-owner anchor, and the bootstrap-peer
 * store (both node-local records, via `SqliteKVStore`'s `kv` table). This app
 * has no Keychain/Keystore integration (see the module comment), so the
 * anchor is only as protected as the plaintext identity it qualifies until
 * that hardening lands — moving one without the other would be a downgrade,
 * not an improvement.
 *
 * At most one handle is open at a time (`??=` below, cleared on close) — a
 * leaked native handle would block the next open of this file. Closed in
 * {@link stopPhoneNode}, reopened by the next {@link startPhoneNode}.
 *
 * No migration: an existing install has no persisted anchor or bootstrap-peer
 * record under these keys, so it cold-starts once (empty anchor, empty
 * bootstrap-peer set) rather than crashing or backfilling.
 */
let identityDb: OptimysticNSDBHandle | null = null;

export interface PhoneNodeOptions {
	/** Party ID — identifies this cadre. Generated on first run. */
	partyId: string;
	/** Bootstrap multiaddrs for the drone (WebSocket). Empty for solo/forming. */
	bootstrapAddrs: string[];
}

/**
 * Get the CadreNode singleton, or null if not started.
 */
export function getPhoneNode(): CadreNode | null {
	return node;
}

/**
 * Start the phone CadreNode. Idempotent — returns the existing node if running.
 */
export async function startPhoneNode(opts: PhoneNodeOptions): Promise<CadreNode> {
	if (node?.isRunning) return node;

	// One handle for the node's life, reused for the identity load below and for
	// both node-local records — see the `identityDb` doc comment for why they
	// share fate. `??=`, not a plain open: a leaked native handle blocks the next
	// open of this file, and the `node?.isRunning` early-return above already
	// keeps a healthy node from reaching here twice.
	// NOTE: `??=` is not a re-entrancy guard — two OVERLAPPING starts would each
	// see `null` and open their own handle, and the loser's leaks. Unreachable
	// today: the Connect button is disabled while `status === 'connecting'`
	// (settings-page.xml → `cadre.notConnecting`) and `startSolo` is only called
	// programmatically. If a caller ever starts concurrently, cache the in-flight
	// open promise instead of the handle.
	identityDb ??= await openOptimysticNSDb(PEER_IDENTITY_DB_NAME);
	const db = identityDb;

	const privateKey = await loadOrCreatePhoneKey(db);

	// Empty prefix, not `SqliteKVStore`'s default `'optimystic:txn:'`: the slot
	// keys are the literal `trusted-owners.<partyId>` / `bootstrap-peers.<partyId>`
	// strings, and this db holds nothing else under those names.
	const nodeLocalKv = new SqliteKVStore(db, '');
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

	const config: CadreNodeConfig = {
		privateKey,
		controlNetwork: {
			partyId: opts.partyId,
			bootstrapNodes: opts.bootstrapAddrs,
		},
		profile: 'transaction',
		storage: {
			provider: (strandId: string) => makeLazyNsStorage(strandId),
		},
		network: {
			transports: [webSockets(), circuitRelayTransport()],
			listenAddrs: [], // NativeScript clients cannot listen for inbound connections
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		trustedOwners: { store: trustedOwnerStore },
		bootstrapPeers: { store: bootstrapPeerStore },
		// Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an
		// ed25519 author key — see getChatSAppConfig). Relax the fail-closed schema
		// policy so the demo can form strands. Production nodes must leave this unset.
		requireSignedSchemas: false,
	};

	node = new CadreNode(config);
	await node.start();
	return node;
}

/**
 * Start in solo/forming mode — no drone, no network. The node forms its own
 * cadre and can create a local strand. This is the runtime-validation core of
 * the NS parity effort (createChatStrand → insertMessage → queryMessages).
 */
export async function startSolo(partyId: string): Promise<CadreNode> {
	return startPhoneNode({ partyId, bootstrapAddrs: [] });
}

/**
 * Stop the phone CadreNode and release resources.
 */
export async function stopPhoneNode(): Promise<void> {
	// Cleared BEFORE the stop, mirroring reference-app-rn's `stopPhoneNode`: a
	// throwing `node.stop()` must not leave a module-level reference to a node
	// whose `identityDb` handle the `finally` below has just closed — the
	// `node?.isRunning` early-return in `startPhoneNode` would hand that node
	// back and its next node-local write would fail on a closed handle.
	const stopping = node;
	node = null;
	try {
		if (stopping) await stopping.stop();
	} finally {
		// Close even when `node.stop()` threw, and even when a failed
		// `startPhoneNode` never got as far as constructing the node — this is a
		// native SQLite handle, and a leaked one blocks the next open of this file.
		// Cleared first so a failed close cannot leave a dangling handle that the
		// next start would reuse.
		const db = identityDb;
		identityDb = null;
		if (db) await db.close();
	}
}

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
