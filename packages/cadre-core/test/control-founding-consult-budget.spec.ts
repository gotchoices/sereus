import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { IRawStorage } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandWatcher } from '../src/strand-watcher.js';
import type { SAppConfig } from '../src/types.js';
import { controlNodeConfig, freshPartyId, scopedWithin } from './control-db-node-helpers.js';
import {
	formatConsultSnapshot,
	formatPerBlock,
	installConsultCounter,
	type ConsultCounter,
	type ConsultSnapshot
} from './cohort-consult-counter.js';

/**
 * **What this protects: the NUMBER of cohort consults and commits the control plane
 * issues while a solo party is founded and then runs idle.**
 *
 * The control database's cost has two halves. `control-start-storage-op-budget.spec.ts`
 * and `strand-solo-write-budget.spec.ts` count raw-storage operations BELOW the
 * write-through cache. This spec counts the half ABOVE it, which never reaches raw
 * storage: how often Optimystic's coordinator (`CoordinatorRepo`) asks a block's cohort —
 * the machines responsible for it — for the latest revision (a "consult"), and how many
 * commits a flow issues. `cohort-consult-counter.ts` does the counting.
 *
 * Upstream consults a block's cohort in two cases:
 *  - the block is MISSING locally: on every read, by design. The memo that remembered a
 *    confirmed absence was removed on 2026-09-15 (upstream `drop-the-settled-absence-memo`,
 *    GitHub issue #20) because it served freshly written blocks as never created.
 *  - the block is HELD but its read-repair window has lapsed: at most once per
 *    `readRepairWindowMs`, 10 s by default.
 *
 * On a cohort of one a consult is one local `findCluster` call (0.009 ms, measured
 * upstream); on a party of several machines it is a round trip to every other cohort
 * member. So the count is the portable signal, and nothing else in the suite would notice
 * a change that doubled it.
 *
 * The standing example is `CadreControl.Revocation`. On a party that has never revoked
 * anyone it has never been written, so it is a missing block, and every membership lookup
 * reads it first — the "every call costs the same" shape pinned below. Ticket
 * `revocation-ledger-marker` changes that for CONNECTED parties only (its marker is filed
 * from the connected-only reconcile step), so these solo numbers should not move when it
 * lands. If they do, find out why before re-pinning.
 *
 * **Phases**, on one solo `CadreNode` (`profile: 'transaction'`, one `MemoryRawStorage`
 * per storage id), each measured from a zeroed counter: cold `start()`; genesis
 * (`ensureOwnerKey` with the identity key, the production call); `foundStrand`, with the
 * control network's and the strand's consults reported separately by which
 * `CoordinatorRepo` issued them; six back-to-back calls each of
 * `queryRevokedStamps('CadrePeer')` and `queryCadrePeers()`; one idle
 * `reconcileControlCohort()` pass.
 *
 * **Background work is taken out of the phases, not budgeted around.** See
 * {@link settleStart}: the self-registration timer is disarmed, and the two reads `start()`
 * leaves running are awaited and charged to the cold phase, since every start pays them.
 *
 * **Timing.** Missing-block consults do not depend on time; held-block consults do. The
 * whole run measured ~320 ms, far inside one 10 s window, and every count below assumes the
 * run stays inside one window. A run slow enough to cross it re-consults held blocks and
 * reads as a regression, so every failure message says how far into the run its phase began.
 *
 * The counts reproduce exactly: three consecutive runs gave identical per-phase counts and
 * identical per-block breakdowns (only the ids of freshly created tree blocks differ). If a
 * run ever comes out a few consults off, that non-determinism is itself the finding — find
 * the block that moved; do not widen a budget over it.
 *
 * Companions: `control-start-storage-op-budget.spec.ts` (the storage half of a control
 * start — it snapshots before genesis, so genesis is budgeted only here) and
 * `strand-solo-write-budget.spec.ts` (the storage half of a solo strand).
 */

const SCOPE = 'consult-budget';

/** `start()`/`stop()`/`foundStrand()` bring libp2p nodes up and down; bounded hang detectors. */
const LIFECYCLE_TIMEOUT_MS = 60_000;

/** A single control read or write; a hang detector. */
const OP_TIMEOUT_MS = 30_000;

/** `within` scoped to this spec's failure label: `consult-budget control op <label> …`. */
const within = scopedWithin(SCOPE);

/** Upstream's default `readRepairWindowMs`: a held block is re-consulted once this lapses. */
const READ_REPAIR_WINDOW_MS = 10_000;

/** Back-to-back calls per membership read. Enough to show a per-call shape, not only a total. */
const PER_CALL_READS = 6;

/** Only for {@link settleStart}'s fallback: consult activity must stop for this long. */
const QUIET_MS = 300;

/** The strand watcher's poll interval and the reconcile interval, pushed past any run. */
const IDLE_TIMER_MS = 3_600_000;

/**
 * The measured figures, and the budgets sitting modestly above them.
 *
 * Re-measure by reading the `[consult-budget]` lines this spec prints; they carry the
 * per-block breakdown. **They only appear under `vitest run --reporter=verbose`** — the
 * default reporter prints a passing test's console output nowhere — so every assertion
 * also embeds the breakdown, and a failure names the block that grew without a re-run.
 *
 * When a change moves a number, update BOTH the measurement and its date here — a budget
 * with no provenance cannot tell the next reader whether the count grew or the budget was
 * always wrong.
 */
const MEASURED_ON = '2026-09-15';

/**
 * Cold: `start()` against empty storage, plus the membership-gate seed and the strand
 * watcher's first poll it leaves running. 30 consults over 18 blocks, 2 commits. Every
 * control table and index block is consulted once as the schema is applied (all missing),
 * the schema catalog (`optimystic/schema`) 7 times, and three never-written tables twice
 * more each: `CadrePeer` and `Revocation` by the gate seed's `queryCadrePeers`, `Strand` by
 * the watcher's `queryStrands`. The trace that motivated this spec snapshotted at `start()`'s
 * return, before the seed and the poll, and recorded 24 over the same 18 blocks.
 */
const COLD: Budget = { consults: 30, blocks: 18, commits: 2, consultBudget: 36, blockBudget: 22, commitBudget: 3 };
/**
 * Genesis: `ensureOwnerKey` on the fresh party. 14 consults over 3 blocks, 4 commits:
 * `OwnerKey` ×6 and its unique stamp index ×6, both missing until the insert commits, and
 * the never-written `Revocation` ×2. Same figures as the motivating trace.
 */
const GENESIS: Budget = { consults: 14, blocks: 3, commits: 4, consultBudget: 17, blockBudget: 4, commitBudget: 5 };
/**
 * `foundStrand`, control network side: the `Strand` row published. 25 consults over 6
 * blocks, 6 commits: `Strand` ×8 and its two unique indexes ×6 and ×4 (missing until the
 * publish commits), the never-written `Revocation` ×4 and `CadrePeer` ×2, and 1 on a tree
 * block the commit created. The trace taken before upstream removed the absence memo
 * recorded 47 consults and 12 commits for control and strand together; here they sum to
 * 50 and 12.
 */
const FOUNDING_CONTROL: Budget = { consults: 25, blocks: 6, commits: 6, consultBudget: 30, blockBudget: 8, commitBudget: 8 };
/**
 * `foundStrand`, strand side: strand node up, membership and sApp schemas applied, founder
 * bootstrap. 25 consults over 15 blocks, 6 commits: the strand's schema catalog ×7,
 * `Header` ×5, one consult on each other strand table and index as its schema is applied
 * (11, all missing), and 1 each on two tree blocks the bootstrap created.
 */
const FOUNDING_STRAND: Budget = { consults: 25, blocks: 15, commits: 6, consultBudget: 30, blockBudget: 18, commitBudget: 8 };
/**
 * `reconcileControlCohort`, one idle pass on the founded solo party. 8 consults over 2
 * blocks, no commits: the pass's two `CadrePeer` reads (the gate refresh and the sibling
 * enumeration — see the NOTE in `runReconcileControlCohort`), each consulting the
 * never-written `CadrePeer` and `Revocation` twice. Nothing on the strand's repo.
 */
const RECONCILE: Budget = { consults: 8, blocks: 2, commits: 0, consultBudget: 10, blockBudget: 3, commitBudget: 0 };
/** The strand's repo during the idle reconcile pass: nothing, and nothing allowed. */
const RECONCILE_STRAND: Budget = { consults: 0, blocks: 0, commits: 0, consultBudget: 0, blockBudget: 0, commitBudget: 0 };
/**
 * `queryRevokedStamps('CadrePeer')` per call: `Revocation` ×2 on EVERY call, because a
 * never-written table is a missing block and a missing block is consulted on every read.
 * The motivating trace measured [4, 2, 2, 2, 2, 2] right after genesis rather than after
 * founding; the steady 2 is the same.
 */
const REVOKED_STAMPS_PER_CALL = [2, 2, 2, 2, 2, 2];
/**
 * `queryCadrePeers()` per call: `CadrePeer` ×2 and `Revocation` ×2 on every call. Both are
 * never written here — self-registration, which would write this node's `CadrePeer` row, is
 * disarmed. The motivating trace measured 2 per call once a `CadrePeer` row existed, and 0
 * once `Revocation` was held as well.
 */
const CADRE_PEERS_PER_CALL = [4, 4, 4, 4, 4, 4];

/** What was measured for one phase, and the ceiling allowed above it. */
interface Budget {
	/** Consults the phase issued when it was measured, on {@link MEASURED_ON}. */
	consults: number;
	/** Distinct blocks those consults named. */
	blocks: number;
	/** Commits the phase issued. */
	commits: number;
	/** Ceiling for consults; a run above it is a regression. */
	consultBudget: number;
	/** Ceiling for distinct consulted blocks; a run above it reads new structures. */
	blockBudget: number;
	/** Ceiling for commits; a run above it writes more than it did. */
	commitBudget: number;
}

/** One phase's counts, and where it sat in the run (the read-repair window is measured from the start). */
interface PhaseCost {
	snapshot: ConsultSnapshot;
	/** Milliseconds from the cold start's beginning to this phase's beginning. */
	atMs: number;
	ms: number;
}

/** A membership read's per-call counts on the control network's repo. */
interface PerCallCost {
	calls: ConsultSnapshot[];
	/** Consults charged to the strand's repo across all calls; expected 0. */
	strandConsults: number;
	atMs: number;
}

/** How the strand watcher's deferred first poll was settled; see {@link settleStart}. */
type FirstPoll = 'run-by-spec' | 'fired-inside-start';

interface FoundingRun {
	firstPoll: FirstPoll;
	cold: PhaseCost;
	genesis: PhaseCost;
	foundingControl: PhaseCost;
	foundingStrand: PhaseCost;
	revokedStamps: PerCallCost;
	cadrePeers: PerCallCost;
	reconcileControl: PhaseCost;
	reconcileStrand: PhaseCost;
}

/**
 * Test-only window onto the private members {@link settleStart} disarms or awaits. The repo
 * precedent is `control-write-lock.spec.ts`'s `selfRegistrationTimerSlot`.
 */
interface CadreNodeInternals {
	selfRegistrationTimer: ReturnType<typeof setTimeout> | null;
	membershipGateDrain: Promise<void> | null;
	strandWatcher: StrandWatcher | null;
}

interface StrandWatcherInternals {
	initialPollTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * A self-consistent signed sApp config, the same shape as `strand-solo-write-budget.spec.ts`'s:
 * a throwaway key signs the schema and doubles as the sApp id. `latencyHint: 'realtime'`
 * turns hibernation off, so no idle timer can fire mid-measurement.
 */
function signedSApp(): SAppConfig {
	const priv = generatePrivateKey('ed25519', 'base64url') as string;
	const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
	const schema = 'create table Note (Id text primary key);';
	const version = '1.0.0';
	return { id: pub, version, schema, signature: signSchema(schema, version, priv), latencyHint: 'realtime' };
}

/** One `MemoryRawStorage` per storage id, memoised — the control network and the strand never share blocks. */
function memoryStorageProvider(): (id: string) => IRawStorage {
	const byId = new Map<string, IRawStorage>();
	return (id: string) => {
		let storage = byId.get(id);
		if (!storage) {
			storage = new MemoryRawStorage();
			byId.set(id, storage);
		}
		return storage;
	};
}

/** Resolve once no consult or commit has been issued for {@link QUIET_MS}. */
async function waitForQuiet(counter: ConsultCounter): Promise<void> {
	const activity = (): number => {
		const snapshot = counter.snapshot();
		return snapshot.consults + snapshot.commits;
	};
	const deadline = performance.now() + OP_TIMEOUT_MS;
	let last = activity();
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
		const current = activity();
		if (current === last) return;
		if (performance.now() > deadline) {
			throw new Error(`${SCOPE}: consult activity never paused for ${QUIET_MS}ms within ${OP_TIMEOUT_MS}ms after start()`);
		}
		last = current;
	}
}

/**
 * Take the background work `start()` leaves behind out of the later phases:
 *  - the 1 s self-registration timer (a `registerSelf` read, then a reconcile pass, then the
 *    reconcile interval and the 7.5-minute heartbeat) is disarmed, so none of it ever runs;
 *  - the membership-gate seed `start()` launches without awaiting is awaited;
 *  - the strand watcher's first poll, deferred 100 ms after the watcher starts, is cancelled
 *    and run explicitly, after the seed, so the two reads never interleave.
 *
 * When `start()` outlasts the watcher's 100 ms deferral, the poll has already fired and
 * cannot be awaited, so the fallback waits for consults to stop instead. The run prints
 * which path it took.
 *
 * NOTE: every measured run took `run-by-spec` (`start()` returns in ~115 ms, and the
 * watcher starts partway through it). The fallback's quiet wait is a heuristic; if a run
 * that printed `fired-inside-start` ever has a moved cold count, suspect this wait first.
 */
async function settleStart(node: CadreNode, counter: ConsultCounter): Promise<FirstPoll> {
	const internals = node as unknown as CadreNodeInternals;
	clearTimeout(internals.selfRegistrationTimer ?? undefined);
	internals.selfRegistrationTimer = null;

	const watcher = internals.strandWatcher;
	expect(watcher, 'no strand watcher after start() — there is no first poll to settle').not.toBeNull();
	const watcherTimers = watcher as unknown as StrandWatcherInternals;
	const deferred = watcherTimers.initialPollTimer !== null;
	if (deferred) {
		clearTimeout(watcherTimers.initialPollTimer ?? undefined);
		watcherTimers.initialPollTimer = null;
	}

	await internals.membershipGateDrain;
	if (!deferred) {
		await waitForQuiet(counter);
		return 'fired-inside-start';
	}
	await within('strandWatcher.forcePoll() (first poll)', OP_TIMEOUT_MS, () => watcher!.forcePoll());
	return 'run-by-spec';
}

/** Fails when a `CoordinatorRepo` this spec does not know about has consulted or committed. */
function expectNoNewRepo(counter: ConsultCounter, phase: string): void {
	expect(counter.labelUnlabeled('stray'), `a CoordinatorRepo nobody expected consulted or committed during ${phase}`).toBe(0);
}

/**
 * Run one phase from a zeroed counter and split its counts by repo. `labelNew` names the
 * repo the phase brings into being and must find exactly one; it is applied BEFORE the
 * snapshot, so the phase's own calls are charged to it. Without `labelNew`, no new repo may
 * appear.
 */
async function measurePhase(
	counter: ConsultCounter,
	runStart: number,
	phase: string,
	labelNew: 'control' | 'strand' | undefined,
	op: () => Promise<void>
): Promise<{ control: PhaseCost; strand: PhaseCost }> {
	counter.reset();
	const started = performance.now();
	await op();
	const ms = performance.now() - started;
	if (labelNew) {
		expect(counter.labelUnlabeled(labelNew), `expected exactly one new ${labelNew} CoordinatorRepo during ${phase}`).toBe(1);
	} else {
		expectNoNewRepo(counter, phase);
	}
	const atMs = started - runStart;
	return {
		control: { snapshot: counter.snapshot('control'), atMs, ms },
		strand: { snapshot: counter.snapshot('strand'), atMs, ms }
	};
}

/** Call `read` {@link PER_CALL_READS} times back to back, one control-repo snapshot per call. */
async function measurePerCall(
	counter: ConsultCounter,
	runStart: number,
	label: string,
	read: () => Promise<void>
): Promise<PerCallCost> {
	const atMs = performance.now() - runStart;
	const calls: ConsultSnapshot[] = [];
	let strandConsults = 0;
	for (let i = 0; i < PER_CALL_READS; i++) {
		counter.reset();
		await within(`${label}[${i}]`, OP_TIMEOUT_MS, read);
		expectNoNewRepo(counter, `${label}[${i}]`);
		calls.push(counter.snapshot('control'));
		strandConsults += counter.snapshot('strand').consults;
	}
	return { calls, strandConsults, atMs };
}

/**
 * Stand up a solo `CadreNode`, found a party and a strand on it, and measure every phase.
 * The node is torn down before returning.
 */
async function measureFounding(counter: ConsultCounter): Promise<FoundingRun> {
	const node = new CadreNode({
		...controlNodeConfig({
			partyId: freshPartyId(SCOPE),
			profile: 'transaction',
			keyStore: new InMemoryKeyStore(),
			storage: memoryStorageProvider(),
			// Belt and braces: disarming self-registration already leaves the interval unarmed.
			controlCohort: { reconcileMs: IDLE_TIMER_MS }
		}),
		strandWatchInterval: IDLE_TIMER_MS
	});

	const runStart = performance.now();
	try {
		let firstPoll: FirstPoll = 'run-by-spec';
		const cold = await measurePhase(counter, runStart, 'start()', 'control', async () => {
			await within('start() (cold)', LIFECYCLE_TIMEOUT_MS, () => node.start());
			firstPoll = await settleStart(node, counter);
		});

		const db = node.getControlDatabase();
		expect(db).not.toBeNull();
		const ownerPublicKey = node.getIdentityOwnerKey().publicKeyB64;
		const genesis = await measurePhase(counter, runStart, 'genesis', undefined, async () => {
			expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(ownerPublicKey))).toBe(true);
		});

		const strandId = `${SCOPE}-${Math.random().toString(36).slice(2)}`;
		const founding = await measurePhase(counter, runStart, 'foundStrand()', 'strand', async () => {
			const { instance, founded } = await within('foundStrand()', LIFECYCLE_TIMEOUT_MS,
				() => node.foundStrand({ strandId, type: 'o', sAppConfig: signedSApp() }));
			expect(instance.status).toBe('active');
			expect(founded).toBe(true);
			// Strands run on the network transactor; a local one would consult nobody and read as a saving.
			expect(instance.database!.getTransactor()).toBe('network');
		});

		// The empty results are what make these the missing-table reads the budgets describe.
		const revokedStamps = await measurePerCall(counter, runStart, 'queryRevokedStamps(CadrePeer)', async () => {
			expect(await db!.queryRevokedStamps('CadrePeer')).toEqual(new Set());
		});
		const cadrePeers = await measurePerCall(counter, runStart, 'queryCadrePeers()', async () => {
			expect(await db!.queryCadrePeers()).toEqual([]);
		});

		const reconcile = await measurePhase(counter, runStart, 'reconcileControlCohort()', undefined, () =>
			within('reconcileControlCohort() (idle)', OP_TIMEOUT_MS, () => node.reconcileControlCohort()));

		return {
			firstPoll,
			cold: cold.control,
			genesis: genesis.control,
			foundingControl: founding.control,
			foundingStrand: founding.strand,
			revokedStamps,
			cadrePeers,
			reconcileControl: reconcile.control,
			reconcileStrand: reconcile.strand
		};
	} finally {
		await within('stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
	}
}

function printPhase(phase: string, cost: PhaseCost): void {
	console.log(`${formatConsultSnapshot(SCOPE, phase, cost.snapshot)} — ${Math.round(cost.ms)}ms at +${Math.round(cost.atMs)}ms`);
}

function printPerCall(read: string, cost: PerCallCost): void {
	const commits = cost.calls.reduce((sum, call) => sum + call.commits, 0);
	console.log(`[${SCOPE}] ${read} per call (control): consults=[${cost.calls.map((call) => call.consults).join(', ')}] `
		+ `commits=${commits} strandConsults=${cost.strandConsults} at +${Math.round(cost.atMs)}ms`);
	cost.calls.forEach((call, i) => console.log(`[${SCOPE}]   ${read}[${i}]: ${formatPerBlock(call)}`));
}

/**
 * Assert one phase against its budget. Two-sided, for the storage budget's reasons: the
 * ceilings are the regression guard; the FLOOR (half the measured count, where one was
 * measured) is the anti-vacuity guard — if the counter stops seeing the path (an upstream
 * method still present but no longer called, a repo attributed to the wrong label) the
 * count collapses and a ceiling alone would pass while measuring nothing. A genuine
 * improvement trips the same floor, which is the prompt to re-measure and tighten.
 */
function expectWithinBudget(phase: string, cost: PhaseCost, budget: Budget, note = ''): void {
	const { snapshot } = cost;
	const context = `(measured ${budget.consults} consults over ${budget.blocks} blocks and ${budget.commits} commits on ${MEASURED_ON}; `
		+ `this phase began ${Math.round(cost.atMs)}ms into the run and took ${Math.round(cost.ms)}ms — a held block is `
		+ `re-consulted once ${READ_REPAIR_WINDOW_MS}ms pass, so a run that slow adds consults${note}). `
		+ `This run's consults per block: ${formatPerBlock(snapshot)}.`;
	const growth = 'A consult is Optimystic asking a block\'s cohort for its latest revision — on a multi-machine party, a '
		+ 'round trip to every other member. A block consulted on every read is usually one this node does not hold. ';

	expect(snapshot.consults, `${phase} issued ${snapshot.consults} cohort consults, over the budget of ${budget.consultBudget} ${context} ${growth}`)
		.toBeLessThanOrEqual(budget.consultBudget);
	expect(snapshot.distinctBlocks, `${phase} consulted ${snapshot.distinctBlocks} distinct blocks, over the budget of ${budget.blockBudget} `
		+ `${context} More distinct blocks means new structures on the path, not more re-reads — check what was added.`)
		.toBeLessThanOrEqual(budget.blockBudget);
	expect(snapshot.commits, `${phase} issued ${snapshot.commits} commits, over the budget of ${budget.commitBudget} ${context}`)
		.toBeLessThanOrEqual(budget.commitBudget);

	const vacuity = 'Either the counter no longer sees this path (a renamed or bypassed CoordinatorRepo method, or a repo '
		+ 'attributed to the wrong label), or the cost genuinely improved — in which case re-measure and TIGHTEN the budget.';
	if (budget.consults > 0) {
		expect(snapshot.consults, `${phase} issued only ${snapshot.consults} cohort consults, far below ${context} ${vacuity}`)
			.toBeGreaterThan(Math.floor(budget.consults / 2));
	}
	if (budget.commits > 0) {
		expect(snapshot.commits, `${phase} issued only ${snapshot.commits} commits, far below ${context} ${vacuity}`)
			.toBeGreaterThan(Math.floor(budget.commits / 2));
	}
}

/**
 * Per-call reads are pinned EXACTLY, not under a ceiling, because their shape is the signal:
 * a missing block costs the same consults on every call, forever, and a total under a
 * ceiling cannot tell six calls of 2 from one call of 12. Six back-to-back reads with no
 * background work running have no noise source, so any difference, in either direction, is
 * a behaviour change to re-measure — a drop to 0 after the first call is what a held
 * `Revocation` looks like.
 */
function expectPerCall(read: string, cost: PerCallCost, measured: number[]): void {
	const actual = cost.calls.map((call) => call.consults);
	const detail = cost.calls.map((call, i) => `[${i}] ${formatPerBlock(call)}`).join('; ');
	expect(actual, `${read}: per-call consults moved from [${measured.join(', ')}] (measured ${MEASURED_ON}) to [${actual.join(', ')}]. `
		+ `The calls began ${Math.round(cost.atMs)}ms into the run (held blocks are re-consulted after ${READ_REPAIR_WINDOW_MS}ms). `
		+ `Consults per block, per call: ${detail}`).toEqual(measured);
	expect(cost.calls.reduce((sum, call) => sum + call.commits, 0), `${read} issued commits; a read should issue none`).toBe(0);
	expect(cost.strandConsults, `${read} charged consults to the strand's repo; a control read should reach only the control network`).toBe(0);
}

describe('control database founding, cohort consult and commit budget', () => {
	it('stays within its consult and commit budgets from cold start through an idle reconcile pass', async () => {
		const counter = installConsultCounter();
		let run: FoundingRun;
		try {
			run = await measureFounding(counter);
		} finally {
			counter.restore();
		}

		console.log(`[${SCOPE}] strand watcher first poll: ${run.firstPoll}`);
		printPhase('cold start (control)', run.cold);
		printPhase('genesis (control)', run.genesis);
		printPhase('foundStrand (control)', run.foundingControl);
		printPhase('foundStrand (strand)', run.foundingStrand);
		printPerCall(`queryRevokedStamps('CadrePeer')`, run.revokedStamps);
		printPerCall('queryCadrePeers()', run.cadrePeers);
		printPhase('reconcileControlCohort (control)', run.reconcileControl);
		printPhase('reconcileControlCohort (strand)', run.reconcileStrand);

		expectWithinBudget('cold start', run.cold, COLD, `; the watcher's first poll was ${run.firstPoll}`);
		expectWithinBudget('genesis', run.genesis, GENESIS);
		expectWithinBudget('foundStrand on the control network', run.foundingControl, FOUNDING_CONTROL);
		expectWithinBudget('foundStrand on the strand', run.foundingStrand, FOUNDING_STRAND);
		expectPerCall(`queryRevokedStamps('CadrePeer')`, run.revokedStamps, REVOKED_STAMPS_PER_CALL);
		expectPerCall('queryCadrePeers()', run.cadrePeers, CADRE_PEERS_PER_CALL);
		expectWithinBudget('idle reconcileControlCohort on the control network', run.reconcileControl, RECONCILE);
		expectWithinBudget('idle reconcileControlCohort on the strand', run.reconcileStrand, RECONCILE_STRAND);
	}, 180_000);
});
