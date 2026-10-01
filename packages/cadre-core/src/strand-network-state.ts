/**
 * Node-local, NON-replicated **strand network state**: for each strand this node
 * runs, the last network state Optimystic's db-p2p saved for that strand's libp2p
 * node — its FRET routing table (each peer entry carrying the peer's signed libp2p
 * address record), the network-size high-water mark, and which of those peers were
 * seen serving the strand. db-p2p reads it back once when the strand node is built
 * and re-imports the table, which hands every record to the libp2p peerStore, so a
 * restarted strand node already has addresses for the peers it was talking to
 * (gotchoices/sereus#18).
 *
 * The payload is opaque here. db-p2p owns its version fence (a snapshot whose
 * `version` it does not write is discarded whole) and FRET owns table validation
 * (a structurally corrupt table is refused, a stale record dropped). This module
 * checks only that an entry is a plain object with a numeric `version`, and never
 * rewrites one.
 *
 * Three implementations mirroring `bootstrap-peer-store.ts` (same "must outlive the
 * process, storage differs per platform" problem; both persistent forms share
 * `node-local-snapshot.ts`):
 *  - {@link MemoryStrandNetworkStateStore} (this module, cross-platform) — ephemeral;
 *    the default when no store is injected via `CadreNodeConfig.strandNetworkState`.
 *    A node using it restarts with an empty routing table.
 *  - {@link PersistentStrandNetworkStateStore} (this module, cross-platform) —
 *    durable over any `DurableSlot` the embedding app supplies.
 *  - `FileStrandNetworkStateStore` — the above over a Node file in the node's state
 *    directory; Node-only, behind the subpath
 *    `@serfab/cadre-core/strand-network-state-file` so `node:fs` never lands in the
 *    RN/browser graph.
 *
 * One store per NODE holding every strand, keyed by strand id, so the embedder
 * wires one slot, like the other node-local stores.
 *
 * **Nothing here is trust-bearing.** A routing-table entry grants no authority:
 * every address record is signed by the peer it names and verified by FRET at
 * import, and the dialed peer authenticates by peer id at the handshake.
 */
import debug from 'debug';
import type { NetworkStatePersistence, PersistedNetworkState } from '@optimystic/db-p2p';
import { NodeLocalSnapshot, type DurableSlot, type NodeLocalSnapshotSpec } from './node-local-snapshot.js';

const log = debug('sereus:cadre:strand-network-state');

export interface StrandNetworkStateStore {
	/** Party this store is scoped to. */
	readonly partyId: string;

	/**
	 * The last state saved for `strandId`, or undefined. Synchronous: served from the
	 * in-memory half of the store. The returned object is the stored one — callers
	 * must not mutate it.
	 */
	load(strandId: string): PersistedNetworkState | undefined;

	/**
	 * Replace the strand's state. Implementations MUST reflect it in {@link load}
	 * SYNCHRONOUSLY; the returned promise tracks durability only. The store keeps
	 * `state` itself, so the caller must not mutate it afterwards (db-p2p builds a
	 * fresh object per save).
	 */
	save(strandId: string, state: PersistedNetworkState): Promise<void>;

	/**
	 * Drop the strand's state — for a strand this node unpublished or left, whose
	 * peers must not be re-imported by a later launch. A no-op for the stored state
	 * when nothing is held, but {@link forgetGeneration} advances either way. Same
	 * contract as {@link save}: reflected synchronously, the promise tracks durability.
	 */
	forget(strandId: string): Promise<void>;

	/**
	 * How many times `strandId` has been forgotten through this store instance.
	 * {@link strandNetworkStatePersistence} compares it against the value it captured
	 * to drop a save that arrives after the forget.
	 */
	forgetGeneration(strandId: string): number;
}

/** Per-strand forget counts; the in-process half of {@link StrandNetworkStateStore.forgetGeneration}. */
class ForgetGenerations {
	private readonly counts = new Map<string, number>();

	of(strandId: string): number {
		return this.counts.get(strandId) ?? 0;
	}

	advance(strandId: string): void {
		this.counts.set(strandId, this.of(strandId) + 1);
	}
}

/**
 * Ephemeral in-memory store for nodes without durable storage (tests, and the
 * default when nothing is injected). Same contract, no disk: a strand relaunched in
 * the same process re-imports its table (a hibernation resume, a stop()→start()),
 * and a restarted process starts with none.
 */
export class MemoryStrandNetworkStateStore implements StrandNetworkStateStore {
	private readonly strands = new Map<string, PersistedNetworkState>();
	private readonly generations = new ForgetGenerations();

	constructor(readonly partyId: string) {}

	load(strandId: string): PersistedNetworkState | undefined {
		return this.strands.get(strandId);
	}

	async save(strandId: string, state: PersistedNetworkState): Promise<void> {
		this.strands.set(strandId, state);
	}

	async forget(strandId: string): Promise<void> {
		this.generations.advance(strandId);
		if (this.strands.delete(strandId)) {
			log('strand %s: network state forgotten (party=%s)', strandId, this.partyId);
		}
	}

	forgetGeneration(strandId: string): number {
		return this.generations.of(strandId);
	}
}

/**
 * What the store persists: `strands` maps strandId -> the state db-p2p saved. An
 * entry that is not a plain object with a numeric `version` is dropped and its
 * siblings kept (`drop-entry`): nothing here is trust-bearing, and one damaged
 * strand must not cost every other strand its routing table. Everything past that
 * structural check is db-p2p's and FRET's to judge at import.
 */
const STRAND_NETWORK_STATE_SNAPSHOT_SPEC: NodeLocalSnapshotSpec<PersistedNetworkState> = {
	label: 'strand network state',
	payloadKey: 'strands',
	unusableEntry: 'drop-entry',
	acceptEntry: (_strandId, raw) => {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
		if (typeof (raw as { version?: unknown }).version !== 'number') return undefined;
		return raw as PersistedNetworkState;
	}
};

/**
 * Durable {@link StrandNetworkStateStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileStrandNetworkStateStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent, corrupt,
 * foreign-party or unreadable slot does (the last one THROWS), and what a failed
 * persist does — is documented once on `NodeLocalSnapshot`. Writes are serialised
 * in-process by the snapshot's write chain, so several strand nodes saving at once
 * cannot interleave partial snapshots.
 */
export class PersistentStrandNetworkStateStore implements StrandNetworkStateStore {
	private readonly generations = new ForgetGenerations();

	private constructor(private readonly snapshot: NodeLocalSnapshot<PersistedNetworkState>) {}

	/** Load (or cold-start) the party's strand network state from `slot`. */
	static async open(slot: DurableSlot, partyId: string): Promise<PersistentStrandNetworkStateStore> {
		return new PersistentStrandNetworkStateStore(
			await NodeLocalSnapshot.open(slot, partyId, STRAND_NETWORK_STATE_SNAPSHOT_SPEC)
		);
	}

	get partyId(): string {
		return this.snapshot.partyId;
	}

	load(strandId: string): PersistedNetworkState | undefined {
		return this.snapshot.get(strandId);
	}

	/**
	 * Replace, visible via {@link load} synchronously, then the full snapshot is persisted.
	 *
	 * NOTE: every save rewrites the party's whole snapshot — every strand's table —
	 * and db-p2p saves on every `connection:open`. Fine for a handful of strands; if
	 * slot writes show up in profiles, move to one slot per strand or coalesce saves.
	 */
	save(strandId: string, state: PersistedNetworkState): Promise<void> {
		return this.snapshot.put(strandId, state);
	}

	/** Forget, gone from {@link load} synchronously, then persisted — unless nothing was there. */
	forget(strandId: string): Promise<void> {
		this.generations.advance(strandId);
		if (this.snapshot.has(strandId)) {
			log('strand %s: network state forgotten (party=%s); persisting', strandId, this.partyId);
		}
		return this.snapshot.remove(strandId);
	}

	forgetGeneration(strandId: string): number {
		return this.generations.of(strandId);
	}
}

/**
 * Adapts one strand's slice of the store to db-p2p's `NodeOptions.persistence`.
 * Build one per strand runtime (`StrandInstanceManager.buildStrandRuntime` does).
 *
 * A save is dropped once the strand has been forgotten after this adapter was
 * built: db-p2p saves fire-and-forget on connection events, so a node being torn
 * down can still save after `forget(strandId)`, which would put the entry back.
 * Saving resumes with the next runtime built for the strand (a relaunch or a
 * hibernation resume), which builds a new adapter.
 *
 * NOTE: a strand that keeps running after its state was forgotten (self-revocation
 * forgets but stops nothing) saves nothing more until its runtime is rebuilt. If a
 * removed party is routinely re-admitted without a relaunch, re-arm saving at
 * re-admission.
 *
 * NOTE: db-p2p saves on `connection:open` and on a changed serving verdict, not when
 * a peer's addresses change. A peer whose address rotates during a long connection
 * (a relay reservation moving) is saved with its old record until the next save,
 * which matters only to a restart in between. If restarts are seen dialing rotated
 * addresses, the fix is upstream: db-p2p saving when FRET's table changes.
 */
export function strandNetworkStatePersistence(
	store: StrandNetworkStateStore,
	strandId: string
): NetworkStatePersistence {
	const generation = store.forgetGeneration(strandId);
	return {
		load: async () => store.load(strandId),
		save: async (state) => {
			if (store.forgetGeneration(strandId) !== generation) {
				log('strand %s: dropping a network-state save that arrived after the strand was forgotten', strandId);
				return;
			}
			await store.save(strandId, state);
		}
	};
}
