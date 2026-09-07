/**
 * Node-local, NON-replicated record of how many machines this party had enrolled
 * the last time this node looked — the block-repair corroboration yardstick the
 * CONTROL network declares when its libp2p node is built.
 *
 * ## Why the number has to be remembered rather than read
 *
 * `resolveRepairYardstick` (in `@serfab/quereus-plugin-sereus`'s `cluster-size.ts`
 * — read it first; the arithmetic and both clamps are explained there and are not
 * repeated here) derives the yardstick from the machines that SERVE the network being
 * configured. For the CONTROL network that is the machines enrolled in the party, and
 * exactly so: every enrolled machine runs the control node by construction. (It is NOT
 * the right number for a strand, which runs on a subset — see
 * `StartStrandConfig.servingMachines`. This store is control-network-only, and that
 * scope is a safety property, not an accident.) Optimystic freezes a network's
 * `clusterPolicy` when its libp2p node is built and offers no runtime setter, so the
 * number has to be known at construction time.
 *
 * The control node cannot read it when it needs it. `CadreNode.buildControlNodeOptions`
 * runs inside `start()` BEFORE `createControlNode()`, which is before the
 * `ControlDatabase` holding the `CadrePeer` rows exists — so at the one moment the
 * number is needed, nothing can answer. That deadlock is why the control network
 * declared no yardstick at all and ran at `CONTROL_CLUSTER_POLICY`'s
 * `assumedClusterSize` of 2.
 *
 * This store breaks it the only way a chicken-and-egg is broken: by remembering
 * across the restart. `CadreNode.refreshAuthorizedControlPeers` records the count
 * every time membership is recomputed; `CadreNode.start()` reads it back before the
 * control node is built. A node therefore declares what it last knew, and a party
 * that grows applies the larger number on each node's NEXT launch. Raising the
 * yardstick is the safe direction and a node still holding the old value is running
 * at exactly today's behaviour, so the next natural restart is soon enough — there
 * is deliberately no forced rebuild.
 *
 * ## Why this is NOT a `NodeLocalSnapshot` like its two siblings
 *
 * The trusted-owner anchor (`trusted-owner-store.ts`) and the cold-start
 * bootstrap-peer store (`bootstrap-peer-store.ts`) are the same `{ version,
 * partyId, ... }` envelope over a {@link DurableSlot} this record is, and this
 * module is deliberately symmetrical with them — same injected-backend shape, same
 * `Memory*` / `Persistent*` / `File*` split, same party scoping. It does NOT share
 * their `NodeLocalSnapshot` machinery, for two reasons:
 *
 *  - **Shape.** `NodeLocalSnapshot` is a `key -> entry` map with no delete. This
 *    record is one integer that must be able to go DOWN after a machine is removed.
 *  - **Load policy — the important one.** `NodeLocalSnapshot.open` THROWS when the
 *    slot is present but unreadable. That is right for the anchor (a record that
 *    cannot be read in full is not a trust anchor) and right for the peer store (a
 *    failed read reported as absent would let the next snapshot write destroy a
 *    stranded node's only way home). It is WRONG here. Nothing in this record is
 *    trust-bearing, it holds nothing that is not recomputed the moment the control
 *    database is up, and refusing to start a node over an unreadable *repair hint*
 *    is strictly worse than declaring today's 2. So every unreadable, unparsable,
 *    foreign-party or junk slot LOGS and COLD-STARTS, yielding `undefined`, which
 *    declares nothing, which is byte-for-byte today's behaviour.
 *
 * Do not "unify" the three modules by routing this one through `NodeLocalSnapshot`:
 * that would quietly import the throw, and turn an unreadable hint into a node that
 * will not start.
 *
 * NOTE: writes are serialised in-process only, the same caveat `NodeLocalSnapshot`
 * carries. Two processes (or two browser tabs) sharing ONE slot for ONE party each
 * write their own view and the loser's count is lost. Two same-origin tabs of
 * `reference-app-web` do exactly that — its slot is one key of a shared IndexedDB
 * database, the same last-writer-wins caveat its `node-local-slots.ts` already
 * records for the other two records. Harmless here, unlike there: this value is one
 * integer both tabs re-derive from the same membership rows on their next refresh,
 * so the views reconverge rather than losing an entry nobody rewrites.
 */
import debug from 'debug';
import type { DurableSlot } from './node-local-snapshot.js';

const log = debug('sereus:cadre:enrolled-machine-store');

/** Envelope version. Guards future migrations; an unknown version cold-starts. */
const ENVELOPE_VERSION = 1;

/** Envelope property holding the count. */
const PAYLOAD_KEY = 'enrolledMachines';

export interface EnrolledMachineStore {
	/** Party this store is scoped to. */
	readonly partyId: string;

	/**
	 * Machines last recorded for this party, or `undefined` when nothing usable was
	 * ever recorded — a brand-new node, or a slot that could not be read. Callers
	 * pass this straight to `controlClusterPolicy`, whose `undefined` branch returns
	 * the frozen base policy unchanged, so "this node does not know" and "this node
	 * has never run" are the same declaration: none.
	 */
	count(): number | undefined;

	/**
	 * Record the current count. Reflected by {@link count} SYNCHRONOUSLY; the
	 * returned promise resolves once the persist attempt has settled.
	 *
	 * **Never rejects.** Its sole caller is
	 * `CadreNode.refreshAuthorizedControlPeers`, whose contract is never-rejects and
	 * which leaves the promise un-awaited (`void`) — so a rejection here would
	 * surface as an unhandled rejection in the embedder's process, over a hint that
	 * re-lands on the next refresh anyway. A failed persist is LOGGED, and the
	 * in-memory count stays correct for this session.
	 *
	 * A count that is not a positive integer is a caller bug: it is logged and
	 * IGNORED rather than persisted, so a degenerate value can never reach the slot
	 * and be read back as a declaration nobody chose.
	 */
	record(count: number): Promise<void>;
}

/**
 * Ephemeral in-memory store — the default when no store is injected via
 * `CadreNodeConfig.enrolledMachines`. A node using this cold-starts on every
 * launch: `count()` is `undefined` at `start()`, so its control node declares
 * nothing and runs at today's behaviour, exactly as before this record existed.
 */
export class MemoryEnrolledMachineStore implements EnrolledMachineStore {
	private current: number | undefined;

	constructor(readonly partyId: string) {}

	count(): number | undefined {
		return this.current;
	}

	async record(count: number): Promise<void> {
		const accepted = asMachineCount(count);
		if (accepted === undefined) {
			log('refusing to record a non-positive-integer count %o for party %s', count, this.partyId);
			return;
		}
		this.current = accepted;
	}
}

/**
 * Durable {@link EnrolledMachineStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileEnrolledMachineStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load policy is the module comment's: every failure
 * mode cold-starts, and `open` never rejects.
 */
export class PersistentEnrolledMachineStore implements EnrolledMachineStore {
	/** Serialises persists so the last count recorded is the last one written. */
	private writeChain: Promise<void> = Promise.resolve();
	/** Last count accepted, whether or not it has reached the slot yet. */
	private current: number | undefined;
	/** Last count believed to BE in the slot; drives the unchanged-write skip. */
	private persisted: number | undefined;

	private constructor(
		private readonly slot: DurableSlot,
		readonly partyId: string,
		loaded: number | undefined
	) {
		this.current = loaded;
		this.persisted = loaded;
	}

	/** Load (or cold-start) the party's last recorded machine count from `slot`. */
	static async open(slot: DurableSlot, partyId: string): Promise<PersistentEnrolledMachineStore> {
		return new PersistentEnrolledMachineStore(slot, partyId, await loadCount(slot, partyId));
	}

	count(): number | undefined {
		return this.current;
	}

	/**
	 * Record the count: visible via {@link count} synchronously, then persisted.
	 *
	 * Writes are SKIPPED when the slot already holds this number, because the sole
	 * caller runs on every committed membership write *and* every timed reconcile
	 * pass — a party whose membership is stable would otherwise rewrite the same
	 * integer forever. The skip is keyed off {@link persisted} rather than
	 * {@link current}, so a write that FAILED is retried by the next refresh instead
	 * of being suppressed as "unchanged".
	 */
	record(count: number): Promise<void> {
		const accepted = asMachineCount(count);
		if (accepted === undefined) {
			log('refusing to record a non-positive-integer count %o for party %s', count, this.partyId);
			return Promise.resolve();
		}
		this.current = accepted;
		if (this.persisted === accepted) {
			return Promise.resolve();
		}
		this.writeChain = this.writeChain.then(() => this.persistCurrent());
		return this.writeChain;
	}

	/**
	 * Write whatever {@link current} holds when this link of the chain runs — so a
	 * burst of records collapses into one write of the latest value — and never
	 * throw (see {@link EnrolledMachineStore.record}).
	 */
	private async persistCurrent(): Promise<void> {
		const pending = this.current;
		if (pending === undefined || pending === this.persisted) {
			return;
		}
		const envelope = {
			version: ENVELOPE_VERSION,
			partyId: this.partyId,
			[PAYLOAD_KEY]: pending
		};
		try {
			await this.slot.save(JSON.stringify(envelope, null, '\t'));
			this.persisted = pending;
			log('recorded %d enrolled machine(s) for party %s', pending, this.partyId);
		} catch (error) {
			log(
				'persisting %d enrolled machine(s) for party %s failed (in-memory count stands, retried on the next refresh): %o',
				pending, this.partyId, error
			);
		}
	}
}

/**
 * A usable machine count, or `undefined`. Anything that is not a positive integer
 * is unknown rather than coerced — `'3'`, `0`, `-1`, `2.5`, `null` and a missing key
 * all cold-start. Coercing here would be the beginning of a parser, and Optimystic
 * itself treats a degenerate declaration as absent, so a rounded value would be a
 * number nobody chose.
 */
function asMachineCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Read the slot into the initial count. EVERY failure — unreadable slot, unparsable
 * JSON, wrong envelope version, foreign `partyId`, junk payload — logs and returns
 * `undefined` (see the module comment for why this record, unlike its two siblings,
 * must not throw on an unreadable slot).
 */
async function loadCount(slot: DurableSlot, partyId: string): Promise<number | undefined> {
	let text: string | undefined;
	try {
		text = await slot.load();
	} catch (error) {
		// The deliberate divergence from `NodeLocalSnapshot.open`, which throws here.
		log('slot for party %s is present but unreadable (cold start — this node declares no yardstick): %o', partyId, error);
		return undefined;
	}
	if (text === undefined) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		log('corrupt slot for party %s (cold start): %o', partyId, error);
		return undefined;
	}

	if (!isRecord(parsed) || parsed.version !== ENVELOPE_VERSION || parsed.partyId !== partyId) {
		// A non-string partyId cannot equal the requested one, so this covers both a
		// malformed envelope and a slot reused for another party.
		log('slot for party %s has an unknown shape or a foreign partyId (cold start)', partyId);
		return undefined;
	}

	const count = asMachineCount(parsed[PAYLOAD_KEY]);
	if (count === undefined) {
		log('slot for party %s holds an unusable %s value %o (cold start)', partyId, PAYLOAD_KEY, parsed[PAYLOAD_KEY]);
		return undefined;
	}
	log('loaded %d enrolled machine(s) for party %s', count, partyId);
	return count;
}

/** A plain JSON object. Arrays excluded: an array envelope is not an envelope. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
