import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { IRawStorage } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { signSchema } from '../src/schema-verification.js';
import { controlNodeConfig, freshPartyId, scopedWithin } from './control-db-node-helpers.js';
import { CountingRawStorage, formatBreakdown, formatSnapshot, StorageOpCounter, type OpSnapshot } from './storage-op-counter.js';
import type { SAppConfig, StrandMode } from '../src/types.js';

/**
 * **What this protects: the raw-storage cost of a SOLO strand — launch, insert,
 * select — on each transactor.**
 *
 * A strand on a lone device currently launches on the *local* transactor
 * (`mode: 'bootstrap'`, no peers consulted); the plan is to retire that mode and
 * run every strand on the *network* transactor, which resolves a lone node as
 * its own coordinator. This spec is the evidence gate for that retirement
 * (ticket `retire-strand-mode-in-cadre-core`): it measures both arms over the
 * same shape and pins budgets on the arm that survives.
 *
 * - `mode: 'bootstrap'` — the BASELINE arm. It exists only to produce the
 *   "before" column of the retirement's before/after table, and is deleted by
 *   `retire-strand-mode-in-cadre-core` along with the mode itself.
 * - `mode: 'networked'` — the arm that survives, carrying two-sided budgets
 *   (ceiling = regression guard, floor = anti-vacuity guard) exactly like
 *   `control-start-storage-op-budget.spec.ts`, whose rationale for counting
 *   operations rather than wall clock applies verbatim here.
 *
 * Backed by `MemoryRawStorage` deliberately: operation counts are a property of
 * the storage layer's call pattern, not the backend — established by
 * `tickets/complete/control-start-storage-op-budget.md`, where `MemoryRawStorage`
 * and `FileRawStorage` agreed on the same figure. So no file-backed arm here.
 *
 * ONLY THE STRAND'S STORAGE IS COUNTED. The `CadreNodeConfig.storage.provider`
 * is called with `'control'` for the control node and with the strandId for the
 * strand, and the counting wrapper goes on the strandId branch alone — the
 * control database's ~1500-operation start would otherwise swamp the
 * measurement. The zero-ops assertion before `addStrand` makes a wrong wrap
 * fail loudly rather than inflate a budget.
 *
 * Wall clock is printed per phase (grep `[strand-write-budget]`) and bounded
 * only loosely — it is noise on a shared machine; the a-priori go/no-go
 * threshold (~250 ms per solo insert on a developer machine) is applied in the
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

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

/**
 * The measured figures for the SURVIVING (networked) arm, and the budgets
 * sitting modestly above them. The bootstrap arm is print-only — its numbers
 * die with the mode.
 *
 * When a change moves a number, update BOTH the measurement and its date here —
 * a budget with no provenance cannot tell the next reader whether the count
 * grew or the budget was always wrong.
 */
const MEASURED_ON = '2026-08-13';
/**
 * Launch: `addStrand` on an empty store — strand libp2p node up, Strand
 * membership schema (8 tables + 1 index) + the one-table sApp schema applied,
 * open-strand founder bootstrap (Header row only). The bootstrap arm measured
 * 1592 over the same 17 blocks on the same day: the network transactor costs
 * +21 operations (all `getMetadata`) for the identical launch.
 */
const LAUNCH: Budget = { ops: 1613, blocks: 17, opBudget: 1780, blockBudget: 20 };
/**
 * Insert: {@link ROW_COUNT} single-row autocommit inserts into `App.Note`.
 * Bootstrap arm: 364 over the same 3 blocks (+2 operations here).
 */
const INSERT: Budget = { ops: 366, blocks: 3, opBudget: 410, blockBudget: 5 };
/**
 * Select: {@link ROW_COUNT} full-table selects of `App.Note`. Byte-identical
 * to the bootstrap arm's figure — reads cost the same on both transactors.
 */
const SELECT: Budget = { ops: 230, blocks: 2, opBudget: 260, blockBudget: 4 };

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

interface ArmCost {
	launch: PhaseCost;
	insert: PhaseCost;
	select: PhaseCost;
}

/**
 * A self-consistent signed sApp config (same shape as
 * `control-database-solo-warm-start.spec.ts`'s): a throwaway key signs the
 * schema and doubles as the sApp id. `latencyHint: 'realtime'` turns
 * hibernation off (never idle, never hibernate) so no idle timer can fire
 * mid-measurement.
 */
function signedSApp(): SAppConfig {
	const priv = generatePrivateKey('ed25519', 'base64url') as string;
	const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
	return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv), latencyHint: 'realtime' };
}

/** Print one phase's line under the greppable prefix. */
function printPhase(arm: StrandMode, phase: string, cost: PhaseCost): void {
	console.log(`${formatSnapshot('strand-write-budget', `${arm} ${phase}`, cost.snapshot)} — ${Math.round(cost.ms)}ms`);
}

/**
 * Stand up a solo `CadreNode` (no siblings, no bootstrap peers), `addStrand` in
 * the given mode, then run {@link ROW_COUNT} single-row inserts and selects
 * against the sApp table, measuring each phase's strand-storage operations and
 * wall clock. The node is torn down before returning.
 */
async function measureArm(arm: StrandMode): Promise<ArmCost> {
	const partyId = freshPartyId(`strand-write-budget-${arm}`);
	const keyStore = new InMemoryKeyStore();
	const counter = new StorageOpCounter();
	const strandId = `budget-${arm}-${Math.random().toString(36).slice(2)}`;
	// Count ONLY the strand's storage: the provider is called with 'control' for
	// the control node and with the strandId for the strand — the counting
	// wrapper goes on the strand branch alone.
	const provider = (id: string): IRawStorage =>
		id === strandId ? new CountingRawStorage(new MemoryRawStorage(), counter) : new MemoryRawStorage();

	const node = new CadreNode(controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage: provider }));
	try {
		await within(`${arm}.start()`, LIFECYCLE_TIMEOUT_MS, () => node.start());
		// The control start must not have touched the counted storage — a provider
		// that wrapped 'control' too would inflate every budget below by ~1500 ops.
		expect(counter.snapshot().total,
			'strand storage counter saw operations BEFORE addStrand — the provider is wrapping the control storage too'
		).toBe(0);

		// --- Launch -------------------------------------------------------------
		let t0 = performance.now();
		const instance = await within(`${arm}.addStrand()`, LIFECYCLE_TIMEOUT_MS, () =>
			node.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: signedSApp(),
				mode: arm,
				founder: true
			}));
		const launch: PhaseCost = { snapshot: counter.snapshot(), ms: performance.now() - t0 };
		expect(instance.mode).toBe(arm);
		expect(instance.status).toBe('active');
		const db = instance.database!.getDatabase();

		// --- Insert: ROW_COUNT single-row autocommit inserts --------------------
		counter.reset();
		t0 = performance.now();
		for (let i = 0; i < ROW_COUNT; i++) {
			await within(`${arm}.insert[${i}]`, LIFECYCLE_TIMEOUT_MS, () =>
				db.exec('insert into App.Note (Id) values (?)', [`note-${i}`]));
		}
		const insert: PhaseCost = { snapshot: counter.snapshot(), ms: performance.now() - t0 };

		// --- Select: ROW_COUNT full-table selects -------------------------------
		counter.reset();
		t0 = performance.now();
		for (let i = 0; i < ROW_COUNT; i++) {
			const ids = new Set<string>();
			await within(`${arm}.select[${i}]`, LIFECYCLE_TIMEOUT_MS, async () => {
				for await (const row of db.eval('select Id from App.Note')) {
					ids.add(row.Id as string);
				}
			});
			// Every select really sees every insert — a phase that quietly read an
			// empty table would produce a meaningless (and suspiciously low) budget.
			expect(ids).toEqual(new Set(Array.from({ length: ROW_COUNT }, (_, n) => `note-${n}`)));
		}
		const select: PhaseCost = { snapshot: counter.snapshot(), ms: performance.now() - t0 };

		printPhase(arm, 'launch', launch);
		printPhase(arm, 'insert', insert);
		printPhase(arm, 'select', select);
		return { launch, insert, select };
	} finally {
		await within(`${arm}.stop()`, LIFECYCLE_TIMEOUT_MS, () => node.stop());
	}
}

/**
 * Two-sided budget assertion for the surviving arm — same rationale as
 * `control-start-storage-op-budget.spec.ts`: the ceiling is the regression
 * guard; the floor (half the measured figure) is the anti-vacuity guard that
 * fires if the strand ever stops routing through the storage this spec hands
 * it. Messages embed the breakdown because vitest's default reporter shows a
 * passing test's console output nowhere.
 */
function expectWithinBudget(phase: string, cost: PhaseCost, budget: Budget): void {
	const provenance = `measured ${budget.ops} ops over ${budget.blocks} distinct blocks on ${MEASURED_ON}`;
	const breakdown = `This run, calls/distinct-blocks by method: ${formatBreakdown(cost.snapshot)}.`;
	expect(
		cost.snapshot.total,
		`networked solo ${phase} issued ${cost.snapshot.total} raw-storage operations, over the budget of ${budget.opBudget} (${provenance}). `
		+ `Cost on a device is operations × per-operation storage latency, so this is a real slowdown on a loaded disk or a phone. ${breakdown}`
	).toBeLessThanOrEqual(budget.opBudget);
	expect(
		cost.snapshot.distinctBlocks,
		`networked solo ${phase} touched ${cost.snapshot.distinctBlocks} distinct blocks, over the budget of ${budget.blockBudget} (${provenance}). `
		+ `More distinct blocks means new persistent structures, not more redundancy — check what was added rather than widening the total budget. ${breakdown}`
	).toBeLessThanOrEqual(budget.blockBudget);
	const floor = Math.floor(budget.ops / 2);
	expect(
		cost.snapshot.total,
		`networked solo ${phase} issued only ${cost.snapshot.total} raw-storage operations, far below the ${provenance}. `
		+ 'Either this spec is no longer measuring the strand\'s real storage path (check the provider branch on strandId), '
		+ `or the cost genuinely improved — re-measure and TIGHTEN the budget rather than leaving the headroom. ${breakdown}`
	).toBeGreaterThan(floor);
}

describe('solo strand write budget, per transactor', () => {
	// BASELINE ARM — deleted by `retire-strand-mode-in-cadre-core`. It exists to
	// produce the "before" column of the retirement's evidence table and nothing
	// else: numbers are printed, not budgeted (a budget on a mode being deleted
	// would only have to be deleted with it).
	it('bootstrap (local transactor) arm: prints the baseline figures', async () => {
		const cost = await measureArm('bootstrap');
		// Sanity only — the arm really measured something.
		expect(cost.launch.snapshot.total).toBeGreaterThan(0);
		expect(cost.insert.snapshot.total).toBeGreaterThan(0);
		expect(cost.select.snapshot.total).toBeGreaterThan(0);
	}, 180_000);

	// SURVIVING ARM — the network transactor a solo strand runs on after the
	// retirement. Two-sided operation budgets; wall clock loosely bounded.
	it('networked (network transactor) arm: stays within its operation budgets', async () => {
		const cost = await measureArm('networked');
		expectWithinBudget('launch', cost.launch, LAUNCH);
		expectWithinBudget('insert', cost.insert, INSERT);
		expectWithinBudget('select', cost.select, SELECT);

		// Loose wall-clock ceilings: hang detectors only. The real speed evidence
		// is the printed per-phase milliseconds, judged against the a-priori ~250 ms
		// per-insert threshold in the retirement ticket, not here.
		expect(cost.insert.ms / ROW_COUNT,
			`a solo networked insert averaged ${Math.round(cost.insert.ms / ROW_COUNT)}ms over MemoryRawStorage — far beyond a hang-free run`
		).toBeLessThan(LOOSE_MS_PER_OP);
		expect(cost.select.ms / ROW_COUNT,
			`a solo networked select averaged ${Math.round(cost.select.ms / ROW_COUNT)}ms over MemoryRawStorage — far beyond a hang-free run`
		).toBeLessThan(LOOSE_MS_PER_OP);
	}, 180_000);
});
