import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { IRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { controlNodeConfig, freshPartyId, scopedWithin } from './control-db-node-helpers.js';
import { signedSApp } from './signed-sapp.js';
import { CountingRawStorage, formatBreakdown, formatSnapshot, StorageOpCounter, type OpSnapshot } from './storage-op-counter.js';

/**
 * **What this protects: the raw-storage cost of a SOLO strand — launch, insert,
 * select — on the network transactor, which every strand now runs on.**
 *
 * The network transactor resolves a lone node as its own coordinator, so a
 * device alone costs almost exactly what the old local transactor did. These
 * budgets were pinned by the two-arm evidence gate for moving solo strands off
 * the local transactor (tickets `strand-network-transactor-solo-parity` and
 * `retire-strand-mode-in-cadre-core`); the baseline arm died with that move, and
 * its measured figures survive as provenance in the budget comments below.
 * Two-sided budgets (ceiling = regression guard, floor = anti-vacuity guard)
 * exactly like `control-start-storage-op-budget.spec.ts`, whose rationale for
 * counting operations rather than wall clock applies verbatim here.
 *
 * Backed by `MemoryRawStorage` deliberately: operation counts are a property of
 * the storage layer's call pattern, not the backend — established by
 * `tickets/complete/control-start-storage-op-budget.md`, where `MemoryRawStorage`
 * and `FileRawStorage` agreed on the same figure. So no file-backed arm here.
 *
 * ONLY THE STRAND'S STORAGE IS COUNTED. The `CadreNodeConfig.storage.provider`
 * is called with the party's control scope key for the control node and with the
 * strandId for the strand, and the counting wrapper goes on the strandId branch
 * alone — the control database's ~1500-operation start would otherwise swamp the
 * measurement. The zero-ops assertion before `addStrand` makes a wrong wrap
 * fail loudly rather than inflate a budget.
 *
 * Wall clock is printed per phase (grep `[strand-write-budget]`) and bounded
 * only loosely — it is noise on a shared machine; the a-priori go/no-go
 * threshold (~250 ms per solo insert on a developer machine) was applied in the
 * retirement ticket's evidence table, not asserted here.
 */

/** `start()`/`stop()`/`addStrand()` bring libp2p nodes up and down; bounded hang detectors. */
const LIFECYCLE_TIMEOUT_MS = 60_000;

/**
 * Loose wall-clock ceiling per single-row write/read, far above the ~250 ms
 * a-priori decision threshold — a hang detector, not a performance assertion.
 */
const LOOSE_MS_PER_OP = 2_000;

/** Single-row writes/reads per phase. Small and fixed so per-op cost is readable. */
const ROW_COUNT = 5;

/** `within` scoped to this spec's failure label: `strand-write-budget control op <label> …`. */
const within = scopedWithin('strand-write-budget');

/**
 * The measured figures and the budgets sitting modestly above them.
 *
 * When a change moves a number, update BOTH the measurement and its date here —
 * a budget with no provenance cannot tell the next reader whether the count
 * grew or the budget was always wrong.
 */
const MEASURED_ON = '2026-10-20';
/**
 * The `../optimystic` commit these figures were measured against. At `03ffadc4` (2026-09-17)
 * the SELECT phase fell to zero backend operations, when that repo made a refresh of an
 * unchanged collection cost one request and stopped re-fetching a block it had already fetched
 * in the same refresh — the selects' one remaining backend read went with it. At `9cbc7427`
 * (same day) a pending record's claimed revision began to be written into the block's metadata
 * on EVERY pend, ahead of the record for crash ordering — before, only a pend that created the
 * block wrote metadata. That per-pend `saveMetadata` is an intended cost and is the whole of
 * the launch (+2) and insert (+8) rises re-baselined at `fbf165ee`. `9cbc7427` also had each
 * commit issue a `deletePendingTransaction` for its own already-promoted record (+11 insert,
 * +8 launch, all no-ops); `fbf165ee` removed those, and they must not come back.
 *
 * Re-measured whole at `28e6e044` on 2026-10-17. With the founder's empty-collection step
 * disabled every phase measured exactly the `fbf165ee` figures (launch 80 over 17, insert 88
 * over 3, select 0), so nothing moved upstream; launch and insert moved with that step
 * (`strand-founder-commits-every-table-collection`), explained on {@link LAUNCH} and {@link INSERT}.
 *
 * Re-measured whole at `b7d70516` on 2026-10-20, three runs identical: insert and select equal
 * the `28e6e044` figures, and launch moved from this side (`strand-founding-writes-batched`,
 * explained on {@link LAUNCH}).
 */
const BASELINE_UPSTREAM = 'optimystic b7d70516';
/**
 * Launch: `addStrand` on an empty store — strand libp2p node up, Strand
 * membership schema (8 tables + 1 index) + the one-table sApp schema applied,
 * open-strand founder bootstrap: an empty collection for each of the 11 declared trees the
 * founding transaction does not write (7 strand tables, 3 unique stamp indexes, `App.Note`),
 * then the founding transaction, whose Header row creates that table's collection. 366 over
 * 39 blocks. At 380, when the Header had an empty commit of its own before its row, the empty
 * collections were 300 of those operations over 22 of the blocks, about 25 operations per
 * collection, each a separate commit; the other 80 over 17 were the launch as it was before
 * them: 56 genuine writes over 6 blocks (8 pends, each writing metadata then the pending
 * record, and 8 commits), one `getMetadata` per block, and a handful of cold fills. Dropping
 * the Header's empty commit wrote the same blocks in one commit instead of two: 14 operations
 * fewer, no block fewer. Founding is once per strand; the batching that would cut the
 * per-collection cost is the tripwire on `createDeclaredCollections` in
 * `strand-membership-writer.ts`.
 * The 130 writes of earlier measurements went with upstream's `APPLY SCHEMA`
 * batching (`schema-batch-catalog-coalescing` and
 * `schema-batch-index-tree-flush-deferral` in `../optimystic`): the catalog is
 * committed once per apply, and an index on an empty table no longer writes its
 * empty tree. History: 1613 uncached (2026-08-13, when the retired
 * local-transactor baseline measured 1592 over the same blocks), 1979 after the
 * upstream catalog re-read (2026-08-14), 168 with cadre-core's write-through
 * cache wired (`@serfab/quereus-plugin-sereus`'s `cached-storage.ts`, 2026-08-17),
 * 78 with schema batching (2026-09-14), 88 at optimystic `2a1bfedb` (the no-op deletes), 80 at
 * `fbf165ee` — the 2 pends that did not create their block now write metadata too — 380
 * over 39 once the founder committed every declared table's collection (2026-10-17), and 366
 * over 39 once the founding transaction's own tables were left out of them (2026-10-20). The
 * same batched launch measured 322 uncached on 2026-09-14 (155 of them `getMetadata`), before
 * the empty collections.
 */
const LAUNCH: Budget = { ops: 366, blocks: 39, opBudget: 380, blockBudget: 42 };
/**
 * Insert: {@link ROW_COUNT} single-row autocommit inserts into `App.Note`.
 * 78 over 2 blocks — nearly all writes (the cache absorbs the transactor's
 * re-reads; 366 uncached on 2026-08-13). History: 75 on 2026-08-17, 86 on 2026-09-14, 80 at
 * optimystic `03ffadc4`, 99 at optimystic `2a1bfedb`, 88 over 3 at `fbf165ee`, 78 over 2 once
 * launch committed `App.Note`'s empty collection (2026-10-17): the first insert no longer
 * creates the collection, so one block fewer is pended and committed, and the 5 cold reads
 * (`listPendingTransactions`, `getMetadata`) of blocks not yet cached moved to launch.
 * (Between 2026-08-17 and 2026-09-14 the measured figure recorded here and the `ops` field
 * below disagreed — the comment said 86 while `ops` stayed at 75, so the floor was computed
 * off the older number.) The rise from 80 is explained operation for operation in the
 * {@link BASELINE_UPSTREAM} comment: `saveMetadata` went 14 → 22, then one per pend
 * plus one per commit (11 + 11, now 10 + 10), and the 11 no-op `deletePendingTransaction` calls
 * from `9cbc7427` are gone. The budget keeps 10 operations of headroom over an explained,
 * intended cost (90 → 98 at `fbf165ee`, 98 → 88 with the drop to 78); it was NOT raised to absorb
 * those no-op deletes, which were fixed upstream instead. It sits one operation below their
 * return (78 + 11 = 89), so this phase, not launch, is the one that catches them. What is still
 * uneven across commit steps is `saveMaterializedBlock` at 18 against 10 of each other step;
 * that excess has not been attributed to a named change, and the figure repeats exactly across
 * runs. This is the phase carrying the spec's anti-vacuity duty — see the NOTE on
 * {@link SELECT} — so the next rise should be explained before anyone raises the budget.
 */
const INSERT: Budget = { ops: 78, blocks: 2, opBudget: 88, blockBudget: 4 };
/**
 * Select: {@link ROW_COUNT} full-table selects of `App.Note`. 0 operations —
 * after the launch/insert phases every read the selects need is already cached,
 * and at {@link BASELINE_UPSTREAM} nothing at all reaches the backend (2 on 2026-09-14,
 * 230 uncached on 2026-08-13).
 *
 * NOTE: that prediction was written down before it happened. At 2 ops the halved floor
 * (`> ops/2` = `> 1`) was exactly the measurement, and the note here said a legitimate drop
 * to 1 would red this spec as "no longer measuring the real storage path", to be answered by
 * re-measuring rather than loosening. The drop came, to 0, and this is that re-baseline.
 *
 * A phase measured at zero cannot carry a halved floor — `> 0` can never pass — so
 * {@link expectWithinBudget} pins it EXACTLY instead. That is a tightening, not a hole: any
 * backend operation reappearing on this path is now a failure to explain. Two things keep the
 * zero from being a blind counter. Each select asserts it saw all {@link ROW_COUNT} inserted
 * rows, so the phase provably ran and returned the data at zero backend operations. And
 * launch (366) and insert (78) are counted through the same `CountingRawStorage` instance, on
 * the same node, in the same run, immediately before these selects — so those two phases,
 * which have real slack, carry the spec's anti-vacuity duty.
 */
const SELECT: Budget = { ops: 0, blocks: 0, opBudget: 0, blockBudget: 0 };

/** What was measured for one phase, and the ceiling allowed above it. */
interface Budget {
	/** Operations the phase issued when it was measured, on {@link MEASURED_ON}. */
	ops: number;
	/** Distinct blocks it touched when it was measured. */
	blocks: number;
	/** Ceiling for total operations; a run above it is a regression. */
	opBudget: number;
	/** Ceiling for distinct blocks; a run above it means new persistent structures. */
	blockBudget: number;
}

/** One phase's cost: the operation snapshot and the wall clock it took. */
interface PhaseCost {
	snapshot: OpSnapshot;
	ms: number;
}

interface RunCost {
	launch: PhaseCost;
	insert: PhaseCost;
	select: PhaseCost;
}

/** Print one phase's line under the greppable prefix. */
function printPhase(phase: string, cost: PhaseCost): void {
	console.log(`${formatSnapshot('strand-write-budget', phase, cost.snapshot)} — ${Math.round(cost.ms)}ms`);
}

/**
 * Stand up a solo `CadreNode` (no siblings, no bootstrap peers), `addStrand`,
 * then run {@link ROW_COUNT} single-row inserts and selects against the sApp
 * table, measuring each phase's strand-storage operations and wall clock. The
 * node is torn down before returning.
 */
async function measureSoloStrand(): Promise<RunCost> {
	const partyId = freshPartyId('strand-write-budget');
	const keyStore = new InMemoryKeyStore();
	const counter = new StorageOpCounter();
	const strandId = `budget-${Math.random().toString(36).slice(2)}`;
	// Count ONLY the strand's storage: the provider is called with the party's
	// control scope key for the control node and with the strandId for the strand —
	// the counting wrapper goes on the strand branch alone. Keyed on the strand id
	// rather than on "not the control key", so nothing here depends on how the
	// control scope is spelled.
	//
	// Memoised per scope for the same reason `fileStorageProvider` is: `CadreNode`
	// asks once per scope today, but a second call handing back a fresh (empty)
	// store would split the strand's blocks across two views rather than
	// measuring one.
	const byScope = new Map<string, IRawStorage>();
	const provider = (scope: string): IRawStorage => {
		let storage = byScope.get(scope);
		if (!storage) {
			storage = scope === strandId ? new CountingRawStorage(new MemoryRawStorage(), counter) : new MemoryRawStorage();
			byScope.set(scope, storage);
		}
		return storage;
	};

	const node = new CadreNode(controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage: provider }));
	try {
		await within('start()', LIFECYCLE_TIMEOUT_MS, () => node.start());
		// The control start must not have touched the counted storage — a provider
		// that wrapped the control scope too would inflate every budget below by ~1500 ops.
		expect(counter.snapshot().total,
			'strand storage counter saw operations BEFORE addStrand — the provider is wrapping the control storage too'
		).toBe(0);

		// --- Launch -------------------------------------------------------------
		let t0 = performance.now();
		const instance = await within('addStrand()', LIFECYCLE_TIMEOUT_MS, () =>
			node.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
				// `realtime` turns hibernation off, so no idle timer can fire mid-measurement.
				sAppConfig: signedSApp({ latencyHint: 'realtime' }),
				founder: true
			}));
		const launch: PhaseCost = { snapshot: counter.snapshot(), ms: performance.now() - t0 };
		expect(instance.status).toBe('active');
		// Every budget below is a NETWORK-transactor figure. A strand that landed
		// the local transactor would post lower counts and read as an improvement
		// rather than as the wrong measurement it is.
		expect(instance.database!.getTransactor(),
			'the measured strand is not on the network transactor — these budgets describe a different engine'
		).toBe('network');
		const db = instance.database!.getDatabase();

		// --- Insert: ROW_COUNT single-row autocommit inserts --------------------
		counter.reset();
		t0 = performance.now();
		for (let i = 0; i < ROW_COUNT; i++) {
			await within(`insert[${i}]`, LIFECYCLE_TIMEOUT_MS, () =>
				db.exec('insert into App.Note (Id) values (?)', [`note-${i}`]));
		}
		const insert: PhaseCost = { snapshot: counter.snapshot(), ms: performance.now() - t0 };

		// --- Select: ROW_COUNT full-table selects -------------------------------
		counter.reset();
		t0 = performance.now();
		for (let i = 0; i < ROW_COUNT; i++) {
			const ids = new Set<string>();
			await within(`select[${i}]`, LIFECYCLE_TIMEOUT_MS, async () => {
				for await (const row of db.eval('select Id from App.Note')) {
					ids.add(row.Id as string);
				}
			});
			// Every select really sees every insert — a phase that quietly read an
			// empty table would produce a meaningless (and suspiciously low) budget.
			expect(ids).toEqual(new Set(Array.from({ length: ROW_COUNT }, (_, n) => `note-${n}`)));
		}
		const select: PhaseCost = { snapshot: counter.snapshot(), ms: performance.now() - t0 };

		printPhase('launch', launch);
		printPhase('insert', insert);
		printPhase('select', select);
		return { launch, insert, select };
	} finally {
		await within('stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
	}
}

/**
 * Two-sided budget assertion — same rationale as
 * `control-start-storage-op-budget.spec.ts`: the ceiling is the regression
 * guard; the floor (half the measured figure) is the anti-vacuity guard that
 * fires if the strand ever stops routing through the storage this spec hands
 * it. Messages embed the breakdown because vitest's default reporter shows a
 * passing test's console output nowhere.
 */
function expectWithinBudget(phase: string, cost: PhaseCost, budget: Budget): void {
	const provenance = `measured ${budget.ops} ops over ${budget.blocks} distinct blocks on ${MEASURED_ON} at ${BASELINE_UPSTREAM}`;
	const breakdown = `This run, calls/distinct-blocks by method: ${formatBreakdown(cost.snapshot)}.`;
	if (budget.ops === 0) {
		expectPinnedAtZero(phase, cost, provenance, breakdown);
		return;
	}
	expect(
		cost.snapshot.total,
		`solo ${phase} issued ${cost.snapshot.total} raw-storage operations, over the budget of ${budget.opBudget} (${provenance}). `
		+ `Cost on a device is operations × per-operation storage latency, so this is a real slowdown on a loaded disk or a phone. ${breakdown}`
	).toBeLessThanOrEqual(budget.opBudget);
	expect(
		cost.snapshot.distinctBlocks,
		`solo ${phase} touched ${cost.snapshot.distinctBlocks} distinct blocks, over the budget of ${budget.blockBudget} (${provenance}). `
		+ `More distinct blocks means new persistent structures, not more redundancy — check what was added rather than widening the total budget. ${breakdown}`
	).toBeLessThanOrEqual(budget.blockBudget);
	const floor = Math.floor(budget.ops / 2);
	expect(
		cost.snapshot.total,
		`solo ${phase} issued only ${cost.snapshot.total} raw-storage operations, far below the ${provenance}. `
		+ 'Either this spec is no longer measuring the strand\'s real storage path (check the provider branch on strandId), '
		+ `or the cost genuinely improved — re-measure and TIGHTEN the budget rather than leaving the headroom. ${breakdown}`
	).toBeGreaterThan(floor);
}

/**
 * A phase measured at zero operations, pinned exactly in both directions.
 *
 * The halved floor is meaningless here (`> 0` can never pass), so the assertion becomes the
 * same kind the consult spec uses for its per-call sequences: the shape IS the signal, and a
 * change in either direction is a behaviour change to re-measure. The anti-vacuity duty the
 * floor would have carried moves to the phases that still cost something — see {@link SELECT}.
 */
function expectPinnedAtZero(phase: string, cost: PhaseCost, provenance: string, breakdown: string): void {
	expect(
		cost.snapshot.total,
		`solo ${phase} issued ${cost.snapshot.total} raw-storage operations; it is pinned at zero (${provenance}). `
		+ 'Everything this phase reads is already cached from the phases before it, so any operation reaching the backend '
		+ 'is a change to explain — a cache that stopped answering, or a new read on the path. Re-measure and re-pin '
		+ `deliberately; do not replace this pin with a ceiling. ${breakdown}`
	).toBe(0);
}

describe('solo strand write budget', () => {
	it('stays within its operation budgets', async () => {
		const cost = await measureSoloStrand();
		expectWithinBudget('launch', cost.launch, LAUNCH);
		expectWithinBudget('insert', cost.insert, INSERT);
		expectWithinBudget('select', cost.select, SELECT);

		// Loose wall-clock ceilings: hang detectors only. The real speed evidence
		// is the printed per-phase milliseconds, judged against the a-priori ~250 ms
		// per-insert threshold in the retirement ticket, not here.
		expect(cost.insert.ms / ROW_COUNT,
			`a solo insert averaged ${Math.round(cost.insert.ms / ROW_COUNT)}ms over MemoryRawStorage — far beyond a hang-free run`
		).toBeLessThan(LOOSE_MS_PER_OP);
		expect(cost.select.ms / ROW_COUNT,
			`a solo select averaged ${Math.round(cost.select.ms / ROW_COUNT)}ms over MemoryRawStorage — far beyond a hang-free run`
		).toBeLessThan(LOOSE_MS_PER_OP);
	}, 180_000);
});
