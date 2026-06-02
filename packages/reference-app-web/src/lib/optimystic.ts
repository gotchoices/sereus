/**
 * optimystic.ts — libp2p node + transactor wiring for the browser reference.
 *
 * Mirrors the shape of `reference-app-rn/src/cadre-phone.ts` but for the
 * browser:
 *   - WebSocket + circuit-relay transports (browsers cannot listen)
 *   - IndexedDB-backed raw storage via `@optimystic/db-p2p-storage-web`
 *   - Ed25519 identity persisted across reloads in the same IDB database
 *
 * Two operating modes:
 *   - **solo**: no bootstrap, clusterSize 1 — used by the scaffold to prove the
 *     stack boots in a browser.
 *   - **distributed**: `bootstrapNodes` populated, clusterSize 3 — wraps the
 *     node's `coordinatedRepo` in a `NetworkTransactor` so `MessageApp` writes
 *     fan out to a real cluster (mirrors the wiring in
 *     `optimystic/packages/reference-peer/src/cli.ts`).
 */

import {
	createLibp2pNode,
	type Libp2pKeyPeerNetwork,
	RepoClient,
	type NodeOptions,
} from '@optimystic/db-p2p/rn';
import type { IRawStorage } from '@optimystic/db-p2p';
import {
	NetworkTransactor,
	type ActionBlocks,
	type BlockActionStatus,
	type BlockGets,
	type CommitRequest,
	type CommitResult,
	type GetBlockResults,
	type IRepo,
	type ITransactor,
	type PendRequest,
	type PendResult,
} from '@optimystic/db-core';
import {
	IndexedDBRawStorage,
	openOptimysticWebDb,
	loadOrCreateBrowserPeerKey,
	DEFAULT_PEER_KEY_NAME,
	type OptimysticWebDBHandle,
} from '@optimystic/db-p2p-storage-web';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import type { Libp2p } from 'libp2p';
import {
	summarizeConnectionPaths,
	type ConnectionPathSummary,
} from './connection-path.js';
import { loadIceConfig } from './ice-config.js';

export type NodeMode = 'solo' | 'distributed';

/**
 * db-p2p's transport-factory element type. `@libp2p/webrtc@6.0.14` is the
 * correct transport for this libp2p generation — it declares
 * `@libp2p/interface@^3.1.0`, matching db-p2p's pin — but its *transitive*
 * `@libp2p/interface-internal` / `@libp2p/utils` resolve a newer
 * `@libp2p/interface@3.2.x` whose `Transport` carries a differently-branded
 * `[transportSymbol]`. The two are runtime-identical: `transportSymbol` is
 * `Symbol.for('@libp2p/transport')`, a global registry key, so libp2p's
 * transport registration works regardless of which interface copy declared it.
 * The skew is therefore purely nominal at the type layer; we bridge the
 * webRTC factories to this type rather than pin five transitive packages (which
 * would risk other workspaces) or force a monorepo-wide interface resolution.
 */
type TransportFactory = NonNullable<NodeOptions['transports']>[number];

export interface StartNodeOptions {
	/** Logical network identifier — also used as the IndexedDB database name. */
	networkName?: string;
	/** Bootstrap multiaddrs. Empty in solo mode. */
	bootstrapNodes?: string[];
	/** Desired cluster size. Defaults: solo → 1, distributed → 3. */
	clusterSize?: number;
	/**
	 * Super-majority threshold (fraction in (0, 1]). Defaults: distributed →
	 * 0.51, solo → libp2p-node-base default. The distributed default exists
	 * because `Math.ceil(3 * 0.67) = 3` leaves a 3-peer cluster with zero
	 * slack — any single peer that returns without its own promise signature
	 * sinks consensus.
	 */
	superMajorityThreshold?: number;
}

const DEFAULT_NETWORK_NAME = 'sereus-web-reference';
const IDENTITY_FIRST_SEEN_KEY = 'identity-first-seen';
const NETWORK_TIMEOUT_MS = 30_000;
const ABORT_OR_CANCEL_TIMEOUT_MS = 10_000;
// Per-peer dial cap. The browser is more dial-failure-prone than a node peer
// (WebSocket-only, circuit-relay required, frequently picks an undialable
// browser tab as coordinator) so a tight per-peer deadline lets the
// NetworkTransactor's retry loop move on without burning the full 30s budget.
const DIAL_TIMEOUT_MS = 3_000;

let node: Libp2p | null = null;
let db: OptimysticWebDBHandle | null = null;
let storage: IRawStorage | null = null;
let transactor: ITransactor | null = null;
let mode: NodeMode = 'solo';
let identityFirstSeenMs: number | null = null;
let activeNetworkName: string = DEFAULT_NETWORK_NAME;

export function getNode(): Libp2p | null {
	return node;
}

export function getDb(): OptimysticWebDBHandle | null {
	return db;
}

export function getStorage(): IRawStorage | null {
	return storage;
}

export function getTransactor(): ITransactor | null {
	return transactor;
}

export function getMode(): NodeMode {
	return mode;
}

export function getNetworkName(): string {
	return activeNetworkName;
}

/**
 * Wall-clock time (ms since epoch) of the first observed presence of the
 * persisted identity on this device. Set when the key is generated, or on
 * first inspection if a key was already present before the app started
 * tracking. Returns `null` before the node has been started.
 */
export function getIdentityFirstSeenMs(): number | null {
	return identityFirstSeenMs;
}

async function trackIdentityFirstSeen(
	handle: OptimysticWebDBHandle,
	keyName: string,
): Promise<number> {
	const existingKey = await handle.get('kv', keyName);
	const existingFirstSeen = await handle.get('kv', IDENTITY_FIRST_SEEN_KEY);

	if (typeof existingFirstSeen === 'string') {
		const parsed = Number(existingFirstSeen);
		if (Number.isFinite(parsed)) return parsed;
	}

	const now = Date.now();
	await handle.put('kv', String(now), IDENTITY_FIRST_SEEN_KEY);
	// If the key was already present but no first-seen was recorded, this is
	// an upgrade path — "first seen" becomes now, which understates the real
	// age. That's an acceptable diagnostic compromise; the UI doesn't claim
	// the value is the key's true creation time.
	void existingKey;
	return now;
}

export async function startNode(opts: StartNodeOptions = {}): Promise<Libp2p> {
	if (node) return node;

	const networkName = opts.networkName ?? DEFAULT_NETWORK_NAME;
	const bootstrapNodes = opts.bootstrapNodes ?? [];
	const isDistributed = bootstrapNodes.length > 0;
	const clusterSize = opts.clusterSize ?? (isDistributed ? 3 : 1);
	const superMajorityThreshold = opts.superMajorityThreshold ?? (isDistributed ? 0.51 : undefined);
	activeNetworkName = networkName;
	mode = isDistributed ? 'distributed' : 'solo';

	db = await openOptimysticWebDb(networkName);
	identityFirstSeenMs = await trackIdentityFirstSeen(db, DEFAULT_PEER_KEY_NAME);
	const privateKey = await loadOrCreateBrowserPeerKey(db);
	storage = new IndexedDBRawStorage(db);

	// ICE servers (STUN/TURN) for WebRTC NAT traversal come from the runtime
	// manifest, never a hard-coded third party. `loadIceConfig` never throws and
	// returns `[]` when no manifest URL is configured — `webRTC` accepts an empty
	// `iceServers` array (host/LAN candidates still work; NAT traversal degrades).
	const iceServers = await loadIceConfig();

	const config: NodeOptions = {
		privateKey,
		networkName,
		bootstrapNodes,
		clusterSize,
		clusterPolicy: superMajorityThreshold !== undefined
			? { superMajorityThreshold }
			: undefined,
		storage,
		// webSockets  — dial public WS nodes (bootstrap / service peers).
		// circuitRelay — the signaling substrate: reserve a relay slot, accept a
		//                dial-in over `/p2p-circuit`, and carry the WebRTC SDP
		//                exchange. `webRTC` reuses this connection for signaling
		//                automatically, so it must stay present.
		// webRTC       — browser↔browser (and browser↔NAT'd peer): once SDP is
		//                swapped over the circuit a direct connection forms and the
		//                relay drops out of the data path. ICE from the manifest.
		// webRTCDirect — browser→public node with a public addr (e.g. a storage
		//                drone); dial-only from a browser, no relay involved.
		transports: [
			webSockets(),
			circuitRelayTransport(),
			// Cast bridges the nominal `@libp2p/interface` brand skew (see
			// `TransportFactory` above) — runtime-safe, no `any`.
			webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
			webRTCDirect() as unknown as TransportFactory,
		],
		// `/p2p-circuit` activates the CircuitRelayTransport listener, which is
		// what kicks `RelayDiscovery` and `ReservationStore.reserveRelay()` into
		// action. Without this entry the AddressManager never calls listen() on
		// the transport, so no reservation is made and the browser peer is not
		// dialable through any service-peer relay — the Tier 2 specs would
		// stall on `findCluster` picks that land on the browser tab itself.
		//
		// `/webrtc` (not `/webrtc-direct` — browsers can only *listen* for WebRTC
		// over a circuit reservation) lets libp2p construct the
		// `/<relay>/p2p-circuit/webrtc/p2p/<self>` listen address once the
		// reservation lands and advertise it via identify. A dialing peer reads
		// that addr and upgrades the relayed connection to a direct WebRTC one,
		// leaving the relay as signaling-only. Solo mode stays `[]` (no
		// reservation, transports present-but-idle).
		listenAddrs: isDistributed ? ['/p2p-circuit', '/webrtc'] : [],
		// libp2p's browser default gater denies insecure ws:// and private/loopback
		// addresses, which blocks dialing a local reference-peer fixture
		// (`/ip4/127.0.0.1/.../ws/...`). Lift both restrictions — the bootstrap
		// multiaddr is user-supplied here, not arbitrary, so the security
		// rationale for the default does not apply.
		connectionGater: { denyDialMultiaddr: () => false },
	};

	const created = await createLibp2pNode(config);
	node = created;
	exposeDebugHook(created);

	if (isDistributed) {
		transactor = buildNetworkTransactor(created, networkName);
	} else {
		transactor = buildLocalTransactor(created);
	}

	return created;
}

/**
 * Solo-mode transactor — mirrors `LocalTransactor` from the optimystic
 * reference-peer CLI. Bypasses the network entirely and routes all reads /
 * writes at the node's local `storageRepo`, which is backed by
 * `IndexedDBRawStorage`. The `MessageApp` can be driven against this without
 * any peers connected.
 */
function buildLocalTransactor(libp2p: Libp2p): ITransactor {
	const storageRepo = (libp2p as unknown as { storageRepo?: IRepo }).storageRepo;
	if (!storageRepo) {
		throw new Error('storageRepo missing on libp2p node — cannot build LocalTransactor');
	}
	return new LocalTransactor(storageRepo);
}

class LocalTransactor implements ITransactor {
	constructor(private readonly repo: IRepo) {}

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		return await this.repo.get(blockGets);
	}

	async getStatus(_actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]> {
		throw new Error('LocalTransactor.getStatus is not implemented');
	}

	async pend(request: PendRequest): Promise<PendResult> {
		return await this.repo.pend(request);
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		// CommitRequest extends RepoCommitRequest structurally (it adds headerId,
		// tailId on top of {blockIds, actionId, rev}); the repo only reads the
		// RepoCommitRequest fields and ignores the rest.
		return await this.repo.commit(request);
	}

	async cancel(actionRef: ActionBlocks): Promise<void> {
		await this.repo.cancel(actionRef);
	}
}

function buildNetworkTransactor(libp2p: Libp2p, networkName: string): ITransactor {
	// `createLibp2pNode` attaches the cluster-aware `coordinatedRepo` and the
	// pre-wired `keyNetwork` to the node instance (see libp2p-node-base.ts).
	// Using those directly mirrors `reference-peer/src/cli.ts` and keeps the
	// browser peer's key-network state (high-water mark, FRET adapter) in
	// lockstep with the consensus layer.
	const exposed = libp2p as unknown as {
		coordinatedRepo?: IRepo;
		keyNetwork?: Libp2pKeyPeerNetwork;
	};
	const coordinatedRepo = exposed.coordinatedRepo;
	const keyNetwork = exposed.keyNetwork;
	if (!coordinatedRepo || !keyNetwork) {
		throw new Error(
			'coordinatedRepo / keyNetwork missing on libp2p node — cannot build NetworkTransactor',
		);
	}
	const protocolPrefix = `/optimystic/${networkName}`;
	return new NetworkTransactor({
		timeoutMs: NETWORK_TIMEOUT_MS,
		abortOrCancelTimeoutMs: ABORT_OR_CANCEL_TIMEOUT_MS,
		dialTimeoutMs: DIAL_TIMEOUT_MS,
		keyNetwork,
		getRepo: (peerId) => {
			return peerId.toString() === libp2p.peerId.toString()
				? coordinatedRepo
				: RepoClient.create(peerId, keyNetwork, protocolPrefix);
		},
	});
}

export async function stopNode(): Promise<void> {
	if (node) {
		await node.stop();
		node = null;
	}
	clearDebugHook();
	if (db) {
		db.close();
		db = null;
	}
	storage = null;
	transactor = null;
	identityFirstSeenMs = null;
	mode = 'solo';
}

/**
 * Exposes a read-only `__optimystic` global so Playwright specs and devtools
 * can inspect the running libp2p node without reaching into module-scoped
 * state. Returns the node's current multiaddrs, peer id, and connection
 * count — enough to verify a circuit-relay reservation has been published
 * (`/p2p-circuit` in the multiaddrs) before the spec presses forward.
 *
 * `getConnectionPaths()` additionally classifies every open connection as
 * relayed vs direct (per transport) and surfaces a stuck-on-relay condition, so
 * specs can assert on connection-path classification without scraping the DOM.
 */
function exposeDebugHook(libp2p: Libp2p): void {
	if (typeof window === 'undefined') return;
	(window as unknown as { __optimystic?: unknown }).__optimystic = {
		getMultiaddrs: () => libp2p.getMultiaddrs().map((ma) => ma.toString()),
		getPeerId: () => libp2p.peerId.toString(),
		getConnectionCount: () => libp2p.getConnections().length,
		getConnectionPaths: (settleWindowMs?: number): ConnectionPathSummary =>
			summarizeConnectionPaths(libp2p.getConnections(), settleWindowMs),
	};
}

function clearDebugHook(): void {
	if (typeof window === 'undefined') return;
	delete (window as unknown as { __optimystic?: unknown }).__optimystic;
}
