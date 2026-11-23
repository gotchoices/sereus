import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { createOwnerKey } from '../src/owner-key-store.js';
import { controlNodeConfig, freshPartyId, scopedWithin } from './control-db-node-helpers.js';
import { CountingRawStorage, formatBreakdown, formatSnapshot, StorageOpCounter, type OpSnapshot } from './storage-op-counter.js';

/**
 * **What this protects: the NUMBER of raw-storage operations a control-database
 * start and a party's founding perform.**
 *
 * Bringing `ControlDatabase` up is neither CPU- nor network-bound. Its duration is
 * (operations issued against `IRawStorage`) × (what one such operation costs on the
 * device). On an idle developer machine one operation costs ~1 ms and a cold start
 * looks fine; on a loaded disk or a phone's flash under launch contention the same
 * operation costs 50–90 ms and the identical start takes tens of seconds and reads
 * as a frozen app. So the operation count — not wall clock — is the thing worth
 * pinning: it is deterministic, and it is what a regression would move.
 *
 * The amplification (the same handful of blocks re-read dozens of times per start)
 * is produced inside `@optimystic/db-p2p` and was measured at ~1541 ops
 * (2026-08-12), then ~1983 after an upstream catalog-correctness fix (2026-08-14) —
 * history and ruled-out hypotheses in
 * `tickets/complete/optimystic-block-read-amplification-on-control-start.md` and
 * `tickets/complete/optimystic-schema-catalog-reread-per-write-blows-storage-budgets.md`.
 * The resolution was upstream's write-through raw-storage cache, which cadre-core
 * wires over every embedder-supplied storage (`@serfab/quereus-plugin-sereus`'s `cached-storage.ts`): what reaches
 * the backend now is dominated by the genuine writes plus one cold read per block.
 * **This spec is the guard that keeps that so** — a broken or unwired cache roughly
 * doubles the cold count (88 against 45 on 2026-09-14, the difference almost all
 * repeated `getMetadata` reads) and fails the ceiling loudly.
 *
 * Nothing else in the suite would notice a change that doubled the count: the only
 * other signal is wall clock, which stays green on an idle machine while the
 * device-facing behaviour gets worse.
 *
 * Deliberately backed by `MemoryRawStorage` rather than files — the COUNT is what is
 * asserted, so an in-memory backend keeps the spec fast and free of filesystem noise
 * while issuing exactly the same operations a file backend would. It did when the
 * pre-cache figure was cross-checked: the 1541 of 2026-08-12 was identical over
 * `FileRawStorage`. (The counter sits UNDER cadre-core's cache — `CountingRawStorage`
 * is not a `MemoryRawStorage`, so the wrap applies — which is the point: it counts
 * what would reach the device's disk.)
 *
 * The counts reproduce exactly — three consecutive runs gave byte-identical
 * per-method breakdowns — which is what makes a budget this close to the measurement
 * safe. If a run ever comes out a few operations off rather than wildly over, that
 * non-determinism is itself the finding; do not paper over it by widening the budget.
 *
 * Three phases: the cold start, the warm restart, and {@link GENESIS} — founding the party, which
 * is 16× the cold start on its own and was unbudgeted here until 2026-11-23, when its growth
 * surfaced as two flaky hang detectors elsewhere instead of as a number.
 *
 * Companions: `control-database-solo.spec.ts` (same cadre-of-one shape, asserting
 * behaviour rather than cost), `control-database-solo-warm-start.spec.ts` (the
 * file-backed warm start, whose per-operation deadlines are hang detectors — this
 * spec is the reason they should not have to be widened), and
 * `control-founding-consult-budget.spec.ts` (the other half of founding's cost: cohort
 * consults and commits, which happen above the write-through cache and never reach
 * the storage counted here).
 */

/** `start()`/`stop()` bring libp2p up and down; a bounded budget, only a hang detector. */
const LIFECYCLE_TIMEOUT_MS = 30_000;
/**
 * Founding the party is neither a lifecycle call nor a local-row read: it makes 36 durable
 * commits ({@link GENESIS}). Bounded where the PRODUCT bounds the same step,
 * `DEFAULT_OWNER_GENESIS_TIMEOUT_MS` in `src/edge-node/config.ts` — the reasoning is spelled out
 * on `control-database-solo-warm-start.spec.ts`'s `GENESIS_TIMEOUT_MS`, where a 15 s bound on this
 * call was failing under outside load. Only a hang detector; the COUNTS are what this spec asserts.
 */
const GENESIS_TIMEOUT_MS = 60_000;

/** `within` scoped to this spec's failure label: `storage-op-budget control op <label> …`. */
const within = scopedWithin('storage-op-budget');

/**
 * The measured figures, and the budgets sitting modestly above them.
 *
 * Re-measure by reading the `[storage-op-budget]` lines this spec prints — they carry the
 * same per-method breakdown the blocked ticket tabulates. **They only appear under
 * `vitest run --reporter=verbose`**: vitest's default reporter shows a passing test's
 * console output nowhere, so a plain `vitest run` prints not one of these lines. Every
 * assertion below therefore also embeds the breakdown in its own message, so a FAILURE is
 * self-diagnosing (which method grew, over how many blocks) without a re-run.
 *
 * When a change moves a number, update BOTH the measurement and its date — a budget
 * with no provenance cannot tell the next reader whether the count grew or the budget was
 * always wrong. Each {@link Budget} carries its own date and substrate, because the phases were
 * not all measured at the same time or against the same Optimystic.
 *
 * The date the COLD and WARM figures were last taken.
 */
const MEASURED_ON = '2026-11-03';
/**
 * The `../optimystic` commit these figures were last measured against. The WARM figure fell
 * at optimystic 03ffadc4 on 2026-09-17 (44 ops over 22 blocks to 13 over 3) when that repo
 * made a refresh of an unchanged collection cost one request and stopped re-fetching a block
 * it had already fetched in the same refresh: the hydrate now reads the catalog's blocks and
 * leaves each table's block for the first read of that table. The COLD figure did not move
 * at all. Re-measured at 5a5661b0 on 2026-10-06 (clean tree) for the two cadre-invitation
 * tables: WARM unchanged, COLD grew by their blocks alone (see {@link COLD}). Re-measured at
 * 0e70f551 (Optimystic 1.17.0) on 2026-10-21: WARM unchanged, COLD grew by `getMetadata` blocks
 * alone. Re-measured at fe7069f0 on 2026-11-03 for control schema version 4: WARM unchanged, COLD
 * grew by the blocks of its two tables and one stamp tree alone.
 */
const BASELINE_UPSTREAM = 'optimystic fe7069f0';
/**
 * The substrate the GENESIS figures were measured against — an npm release rather than an
 * `../optimystic` commit like {@link BASELINE_UPSTREAM}, because on the day they were taken the
 * linked sibling checkout was mid-change and this suite would not start against it, so they come
 * from a `yarn check:published` worktree. Kept as its own constant rather than folded into
 * {@link BASELINE_UPSTREAM}: one constant naming two different substrates could not tell the next
 * reader which phase moved against what.
 */
const GENESIS_UPSTREAM = 'npm optimystic 1.29.1';
/**
 * Cold: first-ever start against empty storage — 19 control tables and 3 indexes
 * created. 63 operations over 38 blocks: 21 genuine writes over 3 blocks, one
 * `getMetadata` per block, and a handful of cold list fills. The 131 writes of
 * earlier measurements went with upstream's `APPLY SCHEMA` batching
 * (`schema-batch-catalog-coalescing` and `schema-batch-index-tree-flush-deferral`
 * in `../optimystic`): the catalog is committed once per apply, and an index on an
 * empty table no longer writes its empty tree. History: 1541 uncached (2026-08-12),
 * 1983 after the upstream catalog re-read (2026-08-14), 172 over 21 blocks with
 * the write-through cache wired (2026-08-17), 169 over 20 with the 9-table schema
 * (2026-09-10), 45 over 20 with schema batching (2026-09-14), 46 over 21 with the
 * same 9 tables at optimystic 7f5e8a90 (2026-09-28; one more `getMetadata` block, not
 * investigated), 48 over 23 with the 10-table schema (2026-09-28; two more
 * `getMetadata` blocks, nothing else moved), 50 over 25 with the 11-table schema at
 * optimystic 461a01bc (2026-10-01; two more `getMetadata` blocks again, nothing else
 * moved; not re-measured without the new table at that commit), 56 over 31 with the
 * 15-table schema at optimystic 5a5661b0 (2026-10-06; six more `getMetadata` blocks for
 * `CadreInvite`, `CadreInviteUsage`, their two indexes and the two `JoinRequest` outcome
 * tables added in between, which were not measured on their own; nothing else moved), 60 over
 * 35 with the 17-table schema at optimystic 0e70f551 (2026-10-21; four more `getMetadata`
 * blocks, from 2026-10-20 01:04 at the latest, so before Optimystic 1.17.0's code; the
 * schema changes since 2026-10-06, `owner-grant-tables`' `OwnerGrant` and `OwnerGrantUsage`
 * among them, were not measured one at a time; nothing else moved), 63 over 38 with the 19-table
 * schema at optimystic fe7069f0 (2026-11-03; three more `getMetadata` blocks; nothing else moved). The same batched start measured 88 uncached on 2026-09-14 (57 of them `getMetadata`), so a
 * run near 90 that is mostly `getMetadata` means the cache has left the path.
 *
 * Observed at 65 over the same 38 blocks against {@link GENESIS_UPSTREAM} on 2026-11-23 — the run
 * that took the genesis figures, in a `yarn check:published` worktree. Two operations above the 63
 * at {@link BASELINE_UPSTREAM}, comfortably inside the budget; WHICH two was not determined,
 * because the linked checkout could not be started that day. The figure above is deliberately left
 * at its own substrate rather than restated against another.
 */
const COLD: Budget = {
	ops: 63, blocks: 38, opBudget: 73, blockBudget: 42,
	measuredOn: MEASURED_ON, upstream: BASELINE_UPSTREAM
};
/**
 * Warm: a second start against the store the cold one left behind — the catalog
 * hydrates instead of the schema being applied. 13 operations over 3 blocks: a
 * cold CACHE over a warm STORE, reading the catalog's own blocks four ways each
 * (`getMetadata`, `listRevisions`, `getMaterializedBlock`, `listPendingTransactions`)
 * plus one `listBlockIds` fill. It was 44 over 22 blocks until {@link BASELINE_UPSTREAM}
 * — one read per block for every table — and the drop is that repo no longer touching a
 * table's block during the hydrate; the first read of each table pays for it instead, which
 * this phase does not perform. NOTE: the per-table→per-block mapping is NOT one-to-one —
 * adding the ninth control table (`StrandPartyKey`) moved cold DOWN from 172 ops / 21 blocks
 * to 169 / 20, which is packing, not a saving to bank on; the tenth (`JoinedStrand`) and the
 * eleventh (`PendingJoin`) each moved it UP by 2 ops over 2 blocks and left warm unchanged.
 * Re-measure rather than predict when the schema changes again.
 *
 * The second start deliberately gets a fresh storage IDENTITY over the shared
 * backing store (see the comment at the spec body): cadre-core's cache is memoized
 * per storage instance, and the tripwire the pre-cache version of this comment set
 * — "if a change ever makes the warm path backend-sensitive, this figure stops
 * standing for a real device restart" — tripped exactly as predicted when the
 * cache was wired (a shared instance measured 3 ops, the first start's surviving
 * cache, not a restart). A device restart kills the process and the cache with it;
 * the fresh identity reproduces that. History: 315 uncached (2026-08-12), 463
 * after the upstream catalog re-read (2026-08-14), 52 cache-wired (2026-08-17),
 * 46 with the 9-table schema (2026-09-10), 44 with schema batching (2026-09-14), 13 at
 * optimystic 03ffadc4 (2026-09-17), still 13 with the 10-table schema at optimystic
 * 7f5e8a90 (2026-09-28), still 13 with the 11-table schema at optimystic 461a01bc
 * (2026-10-01), still 13 with the 17-table schema at optimystic 0e70f551 (2026-10-21), still 13 with
 * the 19-table schema at {@link BASELINE_UPSTREAM} (2026-11-03). 13 is still a cold cache: the 3-op signature the
 * tripwire names is a SHARED storage instance, which reads the catalog once and nothing else.
 */
const WARM: Budget = {
	ops: 13, blocks: 3, opBudget: 17, blockBudget: 5,
	measuredOn: MEASURED_ON, upstream: BASELINE_UPSTREAM
};
/**
 * Genesis: `ensureOwnerKey` on a party that has none. It gives all 35 control collections (19
 * tables, 3 indexes, 13 `unique` columns) their empty history and then inserts the founding
 * `OwnerKey` row — one collection at a time, 35 durable commits plus the insert's, 36 in all (the
 * `saveCommitProof` count in the breakdown below is that figure). 1,010 operations over 105
 * distinct blocks, plus 183 barriers, every one of them a `flush`.
 *
 * Budgeted here because nothing else notices this cost as a NUMBER. It surfaced instead as two
 * flaky hang detectors in `control-database-solo-warm-start.spec.ts` once the step had grown from
 * 750–820 ms (2026-10-20) to 2.0–2.9 s on `FileRawStorage`, which is the failure mode the head
 * comment describes: wall clock stays green on an idle machine while the device-facing behaviour
 * gets worse. The counts are deterministic — byte-identical across six runs, and the same over
 * `MemoryRawStorage` and `FileRawStorage` — which is what makes a budget this close safe.
 *
 * **The barrier arm is not optional padding here.** On disk the barriers ARE the cost: `flush`
 * 183× took 1.4–1.5 s of a 2.1 s run — two per commit, plus roughly one per block written — while
 * every non-barrier method together took under 40 ms. A change that doubled the fsyncs per commit without writing one extra block
 * would double the genesis on a phone and pass an operations-only budget untouched.
 *
 * This is also the phase a batched-commit API would collapse — the request is
 * `blocked/report-control-genesis-commits-one-collection-at-a-time`, and the lever it asks for is
 * fewer commits, not cheaper ones (issuing the syncs concurrently was measured and does not help;
 * see the NOTE on `syncInventedCollections` in `@serfab/quereus-plugin-sereus`). When it lands and
 * is adopted, every figure here drops a long way at once; the FLOORS in
 * {@link expectWithinBudget} are what make that drop announce itself instead of leaving stale
 * headroom behind.
 */
const GENESIS: Budget = {
	ops: 1010, blocks: 105, opBudget: 1100, blockBudget: 115,
	barriers: { measured: 183, budget: 200 },
	measuredOn: '2026-11-23', upstream: GENESIS_UPSTREAM
};

/** What was measured for one phase, and the ceiling allowed above it. */
interface Budget {
	/** Operations the phase issued when it was measured. */
	ops: number;
	/** Distinct blocks it touched when it was measured. */
	blocks: number;
	/** Ceiling for total operations; a run above it is a regression. */
	opBudget: number;
	/** Ceiling for distinct blocks; a run above it means new persistent structures. */
	blockBudget: number;
	/**
	 * Durability barriers the phase issued (`flush` and `whenDurable` together), and the ceiling
	 * above them. Omitted for a phase whose barriers are not where its cost is — a start issues a
	 * handful (5 on the cold phase, 2026-11-23) against {@link GENESIS}'s 183, two per commit,
	 * which is where genesis's wall clock goes. `OpSnapshot.barriers` is deliberately outside
	 * {@link ops}, so a phase that pays barriers needs this arm or a change in them is invisible
	 * to the budget.
	 */
	barriers?: { measured: number; budget: number };
	/** The date these figures were measured. */
	measuredOn: string;
	/** The substrate they were measured against — {@link BASELINE_UPSTREAM} or {@link GENESIS_UPSTREAM}. */
	upstream: string;
}

// `StorageOpCounter`, `CountingRawStorage` and the formatters live in
// `storage-op-counter.ts`, shared with `strand-solo-write-budget.spec.ts`. The
// budgets below passing unchanged is the proof the hoist was faithful.

/**
 * Assert one phase against its budget.
 *
 * Two-sided on purpose. The ceiling is the regression guard. The FLOOR is the
 * anti-vacuity guard: if the node ever stops routing through the storage this spec
 * hands it — a config rename, a provider that is silently ignored — the count
 * collapses to near zero and a ceiling-only assertion passes while measuring
 * nothing. A genuine improvement trips the same floor, which is the intended
 * prompt to re-measure and tighten rather than to leave stale headroom.
 *
 * Every message carries the per-method breakdown, because vitest's default reporter prints
 * a passing test's `console.log` nowhere: a bare total says the count grew, the breakdown
 * says WHICH method grew, and a reader should not need a second run under
 * `--reporter=verbose` to learn that.
 */
function expectWithinBudget(phase: string, snapshot: OpSnapshot, budget: Budget): void {
	const provenance = `measured ${budget.ops} ops over ${budget.blocks} distinct blocks on ${budget.measuredOn} at ${budget.upstream}`;
	const breakdown = `This run, calls/distinct-blocks by method: ${formatBreakdown(snapshot)}.`;
	expect(
		snapshot.total,
		`${phase} issued ${snapshot.total} raw-storage operations, over the budget of ${budget.opBudget} (${provenance}). `
		+ 'Duration is operations × per-operation storage latency, whichever phase this is, so this is a real slowdown on a loaded disk or a phone. '
		+ 'This fires FIRST when a control table is added too — check the distinct-block budget below before reading it as pure slowdown. '
		+ 'A count about double the measurement, mostly repeated getMetadata reads, means the write-through cache (cached-storage.ts in @serfab/quereus-plugin-sereus) has left the path. '
		+ `History in tickets/complete/optimystic-block-read-amplification-on-control-start.md. ${breakdown}`
	).toBeLessThanOrEqual(budget.opBudget);

	expect(
		snapshot.distinctBlocks,
		`${phase} touched ${snapshot.distinctBlocks} distinct blocks, over the budget of ${budget.blockBudget} (${provenance}). `
		+ 'More distinct blocks means new persistent structures, not more redundancy — check what was added rather than widening the total budget. '
		+ `The total-operation budget above will have fired on the same cause; widen both deliberately or neither. ${breakdown}`
	).toBeLessThanOrEqual(budget.blockBudget);

	// The floor: half the measured figure. Wide enough that ordinary noise never trips
	// it, narrow enough that "the storage is no longer in the path" always does.
	const floor = Math.floor(budget.ops / 2);
	expect(
		snapshot.total,
		`${phase} issued only ${snapshot.total} raw-storage operations, far below the ${provenance}. `
		+ 'Either this spec is no longer measuring the real storage path (check that the node is still given this storage), '
		+ `or the amplification genuinely improved — in which case re-measure and TIGHTEN the budget rather than leaving the headroom. ${breakdown}`
	).toBeGreaterThan(floor);

	if (budget.barriers) expectBarriersWithinBudget(phase, snapshot, budget.barriers, breakdown);
}

/**
 * The barrier arm, for a phase whose wall clock is barriers rather than block operations
 * ({@link Budget.barriers}). Two-sided for the same two reasons the operation arms are, and the
 * floor matters more here than anywhere else in the spec: the whole point of asking Optimystic to
 * commit several collections as one transaction is to delete most of these, so the improvement we
 * are waiting for is precisely what this floor catches and makes someone re-measure.
 */
function expectBarriersWithinBudget(
	phase: string,
	snapshot: OpSnapshot,
	barriers: { measured: number; budget: number },
	breakdown: string
): void {
	const issued = snapshot.barriers.reduce((sum, m) => sum + m.calls, 0);
	expect(
		issued,
		`${phase} issued ${issued} durability barriers, over the budget of ${barriers.budget} (measured ${barriers.measured}). `
		+ 'A barrier touches no block, so the operation budgets above cannot see this: on disk two fsyncs per commit are two thirds '
		+ 'of this phase, and a change that added one per commit would slow a phone down while every other assertion here passed. '
		+ `Check what began committing more often, or committing in smaller pieces, before widening this. ${breakdown}`
	).toBeLessThanOrEqual(barriers.budget);

	expect(
		issued,
		`${phase} issued only ${issued} durability barriers, far below the ${barriers.measured} measured. `
		+ 'If commits were batched (blocked/report-control-genesis-commits-one-collection-at-a-time), this is the improvement we asked for: '
		+ `re-measure every figure for this phase and TIGHTEN it. Otherwise the writes are no longer being made durable. ${breakdown}`
	).toBeGreaterThan(Math.floor(barriers.measured / 2));
}

describe('control database start, raw-storage operation budget', () => {
	it('stays within its operation budget on a cold start, a warm restart and genesis', async () => {
		const partyId = freshPartyId('storage-op-budget');
		const keyStore = new InMemoryKeyStore();
		const counter = new StorageOpCounter();
		// One BACKING store across both runs — the same warm-restart shape
		// `control-database-solo.spec.ts` uses, so the second start enters the
		// catalog-hydrate path rather than re-creating the schema. But each start gets
		// its own CountingRawStorage IDENTITY over it: cadre-core memoizes its
		// write-through cache per storage instance (`cached-storage.ts`), so reusing
		// one instance would hand the "restarted" node the first start's warm cache
		// and the warm figure would stop standing for a real device restart, where
		// the process — and the cache — dies with it. A fresh identity means a cold
		// cache over a warm store, which is what a device restart pays.
		const inner = new MemoryRawStorage();
		const config = () => controlNodeConfig({
			partyId, nodeClass: 'device', keyStore,
			storage: new CountingRawStorage(inner, counter)
		});

		// --- Cold: first ever start, empty storage ---------------------------------
		const first = new CadreNode(config());
		let ownerPublicKey: string;
		let cold: OpSnapshot;
		let genesis: OpSnapshot;
		try {
			counter.reset();
			await within('first.start() (cold)', LIFECYCLE_TIMEOUT_MS, () => first.start());
			// Snapshot immediately: everything after this point is the spec's own doing.
			cold = counter.snapshot();
			console.log(formatSnapshot('storage-op-budget', 'cold start', cold));

			// --- Genesis: founding the party, its own phase ----------------------------
			// Genesis sits after the cold snapshot so it costs the COLD budget nothing —
			// it is a founding write, not part of coming up — and it is counted on its
			// own because it is by far the most expensive thing this spec drives (1,010
			// operations against the cold start's 63). It serves the warm run below too:
			// without a written row, a warm start that silently came up on an empty
			// database would be indistinguishable from one that hydrated, and the warm
			// budget would be measuring the wrong path.
			ownerPublicKey = (await createOwnerKey(new InMemoryKeyStore())).publicKey;
			const db = first.getControlDatabase();
			expect(db).not.toBeNull();
			counter.reset();
			expect(await within('ensureOwnerKey() (genesis)', GENESIS_TIMEOUT_MS, () => db!.ensureOwnerKey(ownerPublicKey)))
				.toBe(true);
			genesis = counter.snapshot();
			console.log(formatSnapshot('storage-op-budget', 'genesis', genesis));
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
		}

		// --- Warm: second start over what the first left behind ---------------------
		const second = new CadreNode(config());
		let warm: OpSnapshot;
		try {
			counter.reset();
			await within('second.start() (warm)', LIFECYCLE_TIMEOUT_MS, () => second.start());
			warm = counter.snapshot();
			console.log(formatSnapshot('storage-op-budget', 'warm restart', warm));

			// Anti-vacuity: the warm start hydrated a catalog that still sees the prior
			// session's rows, rather than coming up on an empty database. These reads sit
			// AFTER the snapshot and cost the warm budget nothing — which is the point:
			// since BASELINE_UPSTREAM the hydrate no longer touches a table's block at
			// all, so the first read of `OwnerKey` is here rather than inside the phase.
			const db = second.getControlDatabase();
			expect(db).not.toBeNull();
			expect(await within('hasOwnerKey() (warm)', LIFECYCLE_TIMEOUT_MS, () => db!.hasOwnerKey())).toBe(true);
			expect(await within('getOwnerKeys() (warm)', LIFECYCLE_TIMEOUT_MS, () => db!.getOwnerKeys()))
				.toEqual(new Set([ownerPublicKey]));
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
		}

		expectWithinBudget('cold start', cold, COLD);
		expectWithinBudget('warm start', warm, WARM);
		expectWithinBudget('genesis', genesis, GENESIS);
	}, 180_000);
});
