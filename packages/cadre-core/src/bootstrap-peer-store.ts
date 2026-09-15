/**
 * Node-local, NON-replicated bootstrap-peer store: dial targets a node learned
 * out of band, kept so it can dial those peers when nothing better is known.
 * Two sources feed it:
 *
 *  - **A seed's owner peers.** A newcomer applies a signed seed nominating the
 *    party's owner machines and the addresses they answer on.
 *    `SeedBootstrapService.applySeed` dials those owners exactly once,
 *    best-effort; when that dial fails (owner briefly down, relay reservation not
 *    up, not yet vouched) the node has an empty `CadrePeer` table and no
 *    connection, and `CadreNode.reconcileControlCohort`'s cold-start branch is
 *    the only way back — it re-dials these retained addresses every pass.
 *  - **Nodes this node added.** `CadreNode.addDrone` is handed the added node's
 *    addresses, but that node's `CadrePeer` row stays unsigned, and therefore
 *    unresolvable, until the node self-publishes — which needs a connection, and
 *    a node that cannot listen (a phone) is never dialed by it. The steady-state
 *    reconcile pass falls back to these addresses for a sibling whose signed
 *    record and address-book entry both yield nothing, including after a
 *    relaunch that outlived the record's freshness window.
 *
 * Held only in memory, either kind dies with the process and the node is left
 * with no address to dial, which is what this store exists to prevent.
 *
 * Three implementations, mirroring `trusted-owner-store.ts` (read that first —
 * it solves the same "must outlive the process, storage differs per platform"
 * problem, the two stores are deliberately symmetrical, and both persistent
 * forms share `node-local-snapshot.ts`):
 *  - {@link MemoryBootstrapPeerStore} (this module, cross-platform) — ephemeral;
 *    the default when no store is injected via `CadreNodeConfig.bootstrapPeers`.
 *  - {@link PersistentBootstrapPeerStore} (this module, cross-platform) — durable
 *    over any `DurableSlot` the embedding app supplies (IndexedDB, a LevelDB KV,
 *    SQLite, …).
 *  - `FileBootstrapPeerStore` — the above over a Node file in the node's state
 *    directory; Node-only, behind the subpath
 *    `@serfab/cadre-core/bootstrap-peer-store-file` (same isolation pattern as
 *    `key-store-file`) so `node:fs` never lands in the RN/browser entry graph.
 *
 * **Nothing here is trust-bearing, and a loader must not try to re-verify it.**
 * Only *dial targets* are retained — never a seed, a signature, or an authority
 * claim. A seed was signature-checked against the node-local trusted-owner
 * anchor before its addresses were retained, and an added node's addresses were
 * supplied by the owner that chose to add it. Either way a dial grants no
 * authority: `CadreNode.bootstrapDialAddrs` binds every address to the peer id it
 * was retained under, so a dial cannot be redirected to whoever answers. What a
 * persistent backend's loader DOES owe is dropping structurally junk entries
 * (unparseable peer id, empty address list, non-string address) rather than
 * carrying them into the dial loop.
 */
import debug from 'debug';
import { peerIdFromString } from '@libp2p/peer-id';
import { NodeLocalSnapshot, type DurableSlot, type NodeLocalSnapshotSpec } from './node-local-snapshot.js';

const log = debug('sereus:cadre:bootstrap-peer-store');

/**
 * One retained dial target learned out of band: an owner peer a seed nominated,
 * or a node this node added.
 */
export interface BootstrapPeerEntry {
	/** Multiaddr strings exactly as they were handed over (parsed at dial time). */
	addrs: string[];
	/** Wall-clock ms the entry was last recorded (diagnostics / future eviction). */
	recordedAt: number;
}

export interface BootstrapPeerStore {
	/** Party this store is scoped to. */
	readonly partyId: string;

	/**
	 * Every retained target, peerId -> entry. Every backend copies the map per call,
	 * so the result is a snapshot decoupled from later {@link record} and
	 * {@link forget} calls and is safe to iterate while recording. The entry objects
	 * need no copy: `record` REPLACES an entry rather than mutating it in place.
	 */
	all(): ReadonlyMap<string, BootstrapPeerEntry>;

	/**
	 * Retain (or REPLACE) a peer's dial addresses. Replace, not merge, so a
	 * re-seed after an owner's address changed drops the stale address instead of
	 * accumulating dead ones.
	 *
	 * Implementations MUST reflect the entry in {@link all} SYNCHRONOUSLY; the
	 * returned promise tracks durability only. That is what lets the synchronous
	 * `CadreNode.recordSeedBootstrapPeers` keep its signature while a file
	 * backend persists in the background.
	 *
	 * NOTE: entries are never evicted (only a local `removePeer` {@link forget}s
	 * one), and a persistent backend's file therefore grows across the node's whole
	 * lifetime rather than one process. Fine while a seed nominates one or a few
	 * owners, a node adds a handful of machines, and entries are keyed by peer id;
	 * if a node ever applies seeds naming many distinct owners or adds many
	 * machines, add eviction (oldest {@link BootstrapPeerEntry.recordedAt} first, or
	 * a cap) rather than letting the file grow unbounded — `recordedAt` exists so
	 * eviction has something to sort by.
	 */
	record(peerId: string, addrs: readonly string[]): Promise<void>;

	/**
	 * Drop a peer's retained dial addresses — for a peer this node removed from the
	 * party, which must not stay a dial target. Forgetting a peer with no entry is a
	 * no-op.
	 *
	 * Same contract as {@link record}: the removal is reflected in {@link all}
	 * SYNCHRONOUSLY, and the returned promise tracks durability only.
	 */
	forget(peerId: string): Promise<void>;
}

/**
 * Ephemeral in-memory store for nodes without durable storage (tests, browser
 * demos, not-yet-persisted mobile). Same contract, no disk: a node using this
 * loses its retry targets on restart and must be re-seeded to rejoin.
 */
export class MemoryBootstrapPeerStore implements BootstrapPeerStore {
	private readonly peers = new Map<string, BootstrapPeerEntry>();

	constructor(readonly partyId: string) {}

	all(): ReadonlyMap<string, BootstrapPeerEntry> {
		return new Map(this.peers);
	}

	async record(peerId: string, addrs: readonly string[]): Promise<void> {
		this.peers.set(peerId, { addrs: [...addrs], recordedAt: Date.now() });
		log('bootstrap peer retained (party=%s, peer=%s, addrs=%d)', this.partyId, peerId, addrs.length);
	}

	async forget(peerId: string): Promise<void> {
		if (this.peers.delete(peerId)) {
			log('bootstrap peer forgotten (party=%s, peer=%s)', this.partyId, peerId);
		}
	}
}

/**
 * What the store persists: `peers` maps peerId -> {@link BootstrapPeerEntry}.
 *
 * A structurally junk entry is DROPPED and its siblings retained — nothing here
 * is trust-bearing (see the module comment) and the record is a stranded node's
 * only way back into its party, so discarding the whole set over one bad entry
 * would be strictly worse. What "junk" means: an unparseable peer id (the dial
 * path binds every address to this id, so an id that cannot parse is not a dial
 * target at all), an empty address list, or a non-string address — each would
 * otherwise log a parse failure once per reconcile pass forever.
 */
const BOOTSTRAP_PEER_SNAPSHOT: NodeLocalSnapshotSpec<BootstrapPeerEntry> = {
	label: 'bootstrap-peer store',
	payloadKey: 'peers',
	unusableEntry: 'drop-entry',
	acceptEntry: (peerId, entry) => {
		if (typeof entry !== 'object' || entry === null) return undefined;
		const { addrs, recordedAt } = entry as { addrs?: unknown; recordedAt?: unknown };
		if (!Array.isArray(addrs) || addrs.length === 0) return undefined;
		if (addrs.some((addr) => typeof addr !== 'string' || addr.length === 0)) return undefined;
		if (typeof recordedAt !== 'number') return undefined;
		try {
			peerIdFromString(peerId);
		} catch {
			return undefined;
		}
		return { addrs: [...(addrs as string[])], recordedAt };
	}
};

/**
 * Durable {@link BootstrapPeerStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileBootstrapPeerStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent, corrupt,
 * foreign-party or unreadable slot does, and what a failed persist does — is
 * documented once on `NodeLocalSnapshot`; this class only supplies the payload
 * shape and the drop-the-bad-entry policy above.
 */
export class PersistentBootstrapPeerStore implements BootstrapPeerStore {
	private constructor(private readonly snapshot: NodeLocalSnapshot<BootstrapPeerEntry>) {}

	/** Load (or cold-start) the party's retained dial targets from `slot`. */
	static async open(slot: DurableSlot, partyId: string): Promise<PersistentBootstrapPeerStore> {
		return new PersistentBootstrapPeerStore(
			await NodeLocalSnapshot.open(slot, partyId, BOOTSTRAP_PEER_SNAPSHOT)
		);
	}

	get partyId(): string {
		return this.snapshot.partyId;
	}

	all(): ReadonlyMap<string, BootstrapPeerEntry> {
		return this.snapshot.entrySnapshot();
	}

	/**
	 * Retain a peer's dial addresses: visible via {@link all} synchronously, then
	 * the full snapshot is persisted (see `NodeLocalSnapshot.put`).
	 */
	record(peerId: string, addrs: readonly string[]): Promise<void> {
		log('bootstrap peer retained (party=%s, peer=%s, addrs=%d); persisting', this.partyId, peerId, addrs.length);
		return this.snapshot.put(peerId, { addrs: [...addrs], recordedAt: Date.now() });
	}

	/**
	 * Drop a peer's dial addresses: gone from {@link all} synchronously, then the
	 * full snapshot is persisted — unless there was no entry, which writes nothing
	 * (see `NodeLocalSnapshot.remove`).
	 */
	forget(peerId: string): Promise<void> {
		log('bootstrap peer forgotten (party=%s, peer=%s)', this.partyId, peerId);
		return this.snapshot.remove(peerId);
	}
}
