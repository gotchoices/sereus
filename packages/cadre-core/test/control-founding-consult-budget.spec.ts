import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import type { StrandWatcher } from '../src/strand-watcher.js';
import { controlNodeConfig, freshPartyId, memoryStorageProvider, scopedWithin } from './control-db-node-helpers.js';
import { signedSApp } from './signed-sapp.js';
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
 * reads it first — the "every call costs the same" shape pinned below. The Revocation ledger
 * marker (`ControlDatabase.openRevocationLedger`) ends that, but only the reconcile pass's
 * connected-only step files it, so a solo node never does and the founding figures below
 * are the marker-less ones. If they move, find out why before re-pinning. The second test
 * files the marker directly and pins what it buys.
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
const MEASURED_ON = '2026-09-17';
/**
 * The `../optimystic` commit these figures were measured against. Quote it, not just the date,
 * when the next reader asks whether a count grew or the dependency changed underneath. Two
 * upstream changes on 2026-09-17 moved the counts, neither the commit counts:
 *  - at `03ffadc4` every consult count fell roughly by half on the read paths, when that repo
 *    stopped re-fetching a block it had already fetched during one refresh and made a refresh
 *    of an unchanged collection cost a single request;
 *  - at `13586033`, an ancestor of the commit named here, a default-mode commit that touches two or more
 *    trees — a table and its indexes — became one coordinator batch that pends every tree and
 *    then commits them all. The per-tree sweep it replaced refreshed each staged tree twice
 *    before flushing it (a pre-flight refresh, then `sync()`'s own), and each refresh of a
 *    missing block is a consult; the batch does not refresh before its first attempt. So every
 *    tree such a commit touched lost exactly 2 consults: genesis 7 → 3, `foundStrand`'s control
 *    side 13 → 7. Single-tree commits still go through `sync()` and did not move.
 */
const BASELINE_UPSTREAM = 'optimystic 8a0b48c7';

/**
 * Cold: `start()` against empty storage, plus the membership-gate seed and the strand
 * watcher's first poll it leaves running. 26 consults over 19 blocks, 2 commits. Every
 * control table and index block is consulted once as the schema is applied (all missing),
 * the schema catalog (`optimystic/schema`) 5 times, and three never-written tables once
 * more each: `CadrePeer` and `Revocation` by the gate seed's `queryCadrePeers`, `Strand` by
 * the watcher's `queryStrands`. 15 + 5 + 3×2 = 26. History: 24 over 18 blocks in the trace
 * that motivated this spec (snapshotted at `start()`'s return, before the seed and the poll),
 * 30 on 2026-09-15, 25 over 18 at optimystic `03ffadc4` — the catalog went 7 → 5 and each of
 * the three never-written tables 3 → 2 — and 26 over 19 once Sereus re-declared the
 * `FormationUsageByToken` index (`restore-formation-usage-token-index`), one more block
 * consulted once as the schema is applied.
 */
const COLD: Budget = { consults: 26, blocks: 19, commits: 2, consultBudget: 30, blockBudget: 22, commitBudget: 3 };
/**
 * Genesis: `ensureOwnerKey` on the fresh party. 3 consults over 3 blocks, 4 commits:
 * `OwnerKey` ×1 and its unique stamp index ×1, both missing until the insert commits, and
 * the never-written `Revocation` ×1. History: 14 over the same 3 blocks in the motivating
 * trace and on 2026-09-15 (×6, ×6, ×2), exactly halved to 7 (×3, ×3, ×1) at optimystic
 * `03ffadc4`, then 3 at {@link BASELINE_UPSTREAM} — the insert's commit touches both
 * `OwnerKey` trees and no longer refreshes them twice before flushing.
 */
const GENESIS: Budget = { consults: 3, blocks: 3, commits: 4, consultBudget: 4, blockBudget: 4, commitBudget: 5 };
/**
 * `foundStrand`, control network side: the `Strand` row published. 7 consults over 5
 * blocks, 6 commits: `Strand` ×2 and its `StampId` unique index ×1 (missing until the
 * publish commits), the never-written `Revocation` ×2 and `CadrePeer` ×1, and 1 on a tree
 * block the commit created. History: 25 over 6 blocks on 2026-09-15 (×8, ×6, ×4, ×4, ×2,
 * ×1), 13 over the same 6 at optimystic `03ffadc4` (`Strand` ×4, `StampId` index ×3,
 * `MemberPrivateKey` index ×2), 7 over 5 at {@link BASELINE_UPSTREAM}: the publish's commit
 * touches all three `Strand` trees and no longer refreshes each twice before flushing, which
 * was the `MemberPrivateKey` index's only consults. Control and strand together now sum to 28
 * consults and 12 commits, against 34 and 12 at `03ffadc4`, 50 and 12 on 2026-09-15, and 47
 * and 12 in the trace taken before upstream removed the absence memo.
 */
const FOUNDING_CONTROL: Budget = { consults: 7, blocks: 5, commits: 6, consultBudget: 9, blockBudget: 7, commitBudget: 8 };
/**
 * `foundStrand`, strand side: strand node up, membership and sApp schemas applied, founder
 * bootstrap. 21 consults over 15 blocks, 6 commits: the strand's schema catalog ×5,
 * `Header` ×3, one consult on each other strand table and index as its schema is applied
 * (11, all missing), and 1 each on two tree blocks the bootstrap created. History: 25 over
 * the same 15 blocks on 2026-09-15 (catalog ×7, `Header` ×5), 21 at optimystic `03ffadc4` —
 * only the two repeatedly-read blocks moved; the 11 apply-once blocks did not — and unchanged
 * at {@link BASELINE_UPSTREAM}.
 */
const FOUNDING_STRAND: Budget = { consults: 21, blocks: 15, commits: 6, consultBudget: 26, blockBudget: 18, commitBudget: 8 };
/**
 * `reconcileControlCohort`, one idle pass on the founded solo party. 4 consults over 2
 * blocks, no commits: the pass's two `CadrePeer` reads (the gate refresh and the sibling
 * enumeration — see the NOTE in `runReconcileControlCohort`), each consulting the
 * never-written `CadrePeer` and `Revocation` once. Nothing on the strand's repo. History:
 * 8 over the same 2 blocks on 2026-09-15 (twice each), 4 at {@link BASELINE_UPSTREAM}.
 */
const RECONCILE: Budget = { consults: 4, blocks: 2, commits: 0, consultBudget: 5, blockBudget: 3, commitBudget: 0 };
/** The strand's repo during the idle reconcile pass: nothing, and nothing allowed. */
const RECONCILE_STRAND: Budget = { consults: 0, blocks: 0, commits: 0, consultBudget: 0, blockBudget: 0, commitBudget: 0 };
/**
 * `queryRevokedStamps('CadrePeer')` per call: `Revocation` ×1 on EVERY call, because a
 * never-written table is a missing block and a missing block is consulted on every read.
 * The steady per-call cost is what matters, not its size: it was 2 per call on 2026-09-15
 * and 1 at {@link BASELINE_UPSTREAM}, which is the same block consulted once per refresh
 * instead of twice. The motivating trace measured [4, 2, 2, 2, 2, 2] right after genesis
 * rather than after founding. A drop to 0 on later calls would mean the block stopped being
 * missing, which is the second test's subject.
 */
const REVOKED_STAMPS_PER_CALL = [1, 1, 1, 1, 1, 1];
/**
 * `queryCadrePeers()` per call: `CadrePeer` ×1 and `Revocation` ×1 on every call. Both are
 * never written here — self-registration, which would write this node's `CadrePeer` row, is
 * disarmed. Two missing blocks, so twice {@link REVOKED_STAMPS_PER_CALL}, and it halved with
 * it (4 per call on 2026-09-15, 2 at {@link BASELINE_UPSTREAM}). The motivating trace
 * measured 2 per call once a `CadrePeer` row existed, and 0 once `Revocation` was held too.
 */
const CADRE_PEERS_PER_CALL = [2, 2, 2, 2, 2, 2];

/**
 * **The second test: what the Revocation ledger marker buys.** Same node shape and counter. One
 * `CadrePeer` row is seated first, so `CadrePeer` is a held block and `Revocation` is the only
 * missing block on these paths. The hot paths are measured, the marker is filed directly (a solo
 * node never takes the reconcile pass's connected-only step), and the same paths are measured
 * again. The "before" side is pinned as well, so the "after" zeros cannot pass on a counter that
 * has stopped seeing the path. Measured on {@link MEASURED_ON}:
 *
 * | path | before the marker | after |
 * |---|---|---|
 * | `queryRevokedStamps('CadrePeer')` per call | `Revocation` ×1, every call | 1 on the first call, then 0 |
 * | `queryCadrePeers()` per call | `Revocation` ×1, every call | 0 |
 * | `authorizePeer` of a new member | 3: `Revocation` ×2, 1 on a tree block | 0 |
 * | idle `reconcileControlCohort` | 4: `Revocation` ×4 | 0 |
 *
 * The one consult after is on the tree block the marker's own commit created, paid by whichever
 * read runs first. Filing the marker cost 2 consults (`Revocation` ×2) and 2 commits. The reconcile
 * pass is asserted by its busiest block (more than once before, at most once after) rather than
 * pinned, so an unrelated read added to the pass does not read as a marker regression.
 *
 * Only the "before" column moved at optimystic `03ffadc4`: every repeated consult of the
 * missing `Revocation` block halved (per call 2 → 1, `authorizePeer` 5 → 3, reconcile 8 → 4,
 * filing 4 → 2). The "after" column was already zero and is unchanged, so what this test proves
 * — that the marker removes the repeats entirely — is measured against a smaller "before" than
 * on 2026-09-15 but the same contrast. Nothing here moved at {@link BASELINE_UPSTREAM}: the
 * `authorizePeer` commit touches only the held `CadrePeer` trees, whose refreshes inside the
 * read-repair window never consulted, so dropping them saved nothing.
 */
const MARKER_BEFORE_PER_CALL = [1, 1, 1, 1, 1, 1];
const MARKER_BEFORE_AUTHORIZE = 3;
/** The first read after the marker pays one consult on the block its commit created. */
const MARKER_AFTER_REVOKED_STAMPS = [1, 0, 0, 0, 0, 0];
const MARKER_AFTER_CADRE_PEERS = [0, 0, 0, 0, 0, 0];
const MARKER_AFTER_AUTHORIZE = 0;

/** The four hot paths, measured on one side of the marker. */
interface MarkerSide {
	revokedStamps: PerCallCost;
	cadrePeers: PerCallCost;
	/** One `authorizePeer` of a new member: a guarded control-plane insert. */
	authorize: PhaseCost;
	/** One idle `reconcileControlCohort` pass, with address-less siblings it cannot dial. */
	reconcile: PhaseCost;
}

interface MarkerRun {
	before: MarkerSide;
	filing: PhaseCost;
	after: MarkerSide;
}

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
	op: () => Promise<unknown>
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
 * A solo `CadreNode` on in-memory storage, with the strand watcher's poll and the reconcile
 * interval pushed past any run. Not started.
 */
function soloNode(): CadreNode {
	return new CadreNode({
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
}

/**
 * Stand up a solo `CadreNode`, found a party and a strand on it, and measure every phase.
 * The node is torn down before returning.
 */
async function measureFounding(counter: ConsultCounter): Promise<FoundingRun> {
	const node = soloNode();

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
								// `realtime` turns hibernation off, so no idle timer can fire mid-measurement.
				() => node.foundStrand({ strandId, type: 'o', sAppConfig: signedSApp({ latencyHint: 'realtime' }) }));
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
	const context = `(measured ${budget.consults} consults over ${budget.blocks} blocks and ${budget.commits} commits on ${MEASURED_ON} at ${BASELINE_UPSTREAM}; `
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
	// NOTE: a phase measured at 0 gets NO floor here — `> 0` can never pass, so the guard
	// below skips it. Today that is safe only because the one such phase (RECONCILE_STRAND)
	// also carries a ceiling of 0, and a 0 ceiling pins it exactly. If a re-baseline ever
	// takes a phase to 0 while leaving a non-zero ceiling, that phase asserts nothing in
	// either direction: give it a 0 ceiling, or pin it the way `strand-solo-write-budget.spec.ts`
	// pins its select phase (`expectPinnedAtZero`).
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
	expect(actual, `${read}: per-call consults moved from [${measured.join(', ')}] (measured ${MEASURED_ON} at ${BASELINE_UPSTREAM}) to [${actual.join(', ')}]. `
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

/** A real Ed25519 peer id: `authorizePeer` derives the row's public key from it. */
async function freshPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/**
 * Measure the four hot paths once: both membership reads per call, one `authorizePeer` of
 * `newMember`, and one idle reconcile pass. `members` is the `CadrePeer` set the reads must return
 * before `newMember` joins it.
 */
async function measureHotPaths(
	counter: ConsultCounter,
	runStart: number,
	node: CadreNode,
	side: 'before' | 'after',
	members: readonly string[],
	newMember: string
): Promise<MarkerSide> {
	const db = node.getControlDatabase()!;
	// The marker is not a CadrePeer stamp, so the retired set is empty on both sides.
	const revokedStamps = await measurePerCall(counter, runStart, `${side} queryRevokedStamps(CadrePeer)`, async () => {
		expect(await db.queryRevokedStamps('CadrePeer')).toEqual(new Set());
	});
	const cadrePeers = await measurePerCall(counter, runStart, `${side} queryCadrePeers()`, async () => {
		expect((await db.queryCadrePeers()).map((row) => row.peerId).sort()).toEqual([...members].sort());
	});
	const authorize = await measurePhase(counter, runStart, `${side} authorizePeer()`, undefined, () =>
		within(`${side} authorizePeer()`, OP_TIMEOUT_MS, () => node.authorizePeer(newMember)));
	const reconcile = await measurePhase(counter, runStart, `${side} reconcileControlCohort()`, undefined, () =>
		within(`${side} reconcileControlCohort()`, OP_TIMEOUT_MS, () => node.reconcileControlCohort()));
	return { revokedStamps, cadrePeers, authorize: authorize.control, reconcile: reconcile.control };
}

/**
 * Stand up a solo `CadreNode`, found its party and seat one `CadrePeer` row, then measure the hot
 * paths before and after filing the Revocation ledger marker directly. The node is torn down
 * before returning.
 */
async function measureMarker(counter: ConsultCounter): Promise<MarkerRun> {
	const node = soloNode();
	const runStart = performance.now();
	try {
		await measurePhase(counter, runStart, 'start()', 'control', async () => {
			await within('start() (cold)', LIFECYCLE_TIMEOUT_MS, () => node.start());
			await settleStart(node, counter);
		});
		const db = node.getControlDatabase();
		expect(db).not.toBeNull();
		const owner = node.getIdentityOwnerKey();
		expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(owner.publicKeyB64))).toBe(true);
		node.initializeSeedBootstrap(owner.privateKeyB64);
		const first = await freshPeerId();
		await within('authorizePeer() (first member)', OP_TIMEOUT_MS, () => node.authorizePeer(first));

		const second = await freshPeerId();
		const before = await measureHotPaths(counter, runStart, node, 'before', [first], second);

		const filing = await measurePhase(counter, runStart, 'openRevocationLedger()', undefined, async () => {
			expect(await within('openRevocationLedger()', OP_TIMEOUT_MS,
				() => node.getSeedBootstrapService()!.openRevocationLedger())).toBe('opened');
		});

		const third = await freshPeerId();
		const after = await measureHotPaths(counter, runStart, node, 'after', [first, second], third);
		return { before, filing: filing.control, after };
	} finally {
		await within('stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
	}
}

function printMarkerSide(side: string, cost: MarkerSide): void {
	printPerCall(`${side}: queryRevokedStamps('CadrePeer')`, cost.revokedStamps);
	printPerCall(`${side}: queryCadrePeers()`, cost.cadrePeers);
	printPhase(`${side}: authorizePeer (control)`, cost.authorize);
	printPhase(`${side}: reconcileControlCohort (control)`, cost.reconcile);
}

/** Consults on a phase's busiest block; 0 when the phase consulted nothing. */
function busiestBlock(cost: PhaseCost): number {
	return Math.max(0, ...cost.snapshot.perBlock.values());
}

/** One write's consults, pinned exactly, with the per-block breakdown in the message. */
function expectConsults(label: string, cost: PhaseCost, measured: number): void {
	expect(cost.snapshot.consults, `${label}: ${cost.snapshot.consults} cohort consults, measured ${measured} on ${MEASURED_ON} at ${BASELINE_UPSTREAM}. `
		+ `It began ${Math.round(cost.atMs)}ms into the run (held blocks are re-consulted after ${READ_REPAIR_WINDOW_MS}ms). `
		+ `Consults per block: ${formatPerBlock(cost.snapshot)}`).toBe(measured);
}

describe('Revocation ledger marker, cohort consult budget', () => {
	it('once the marker is filed, the membership reads, a control insert and a reconcile pass stop re-consulting', async () => {
		const counter = installConsultCounter();
		let run: MarkerRun;
		try {
			run = await measureMarker(counter);
		} finally {
			counter.restore();
		}

		printMarkerSide('before the marker', run.before);
		printPhase('openRevocationLedger (control)', run.filing);
		printMarkerSide('after the marker', run.after);

		// Before: the missing Revocation block is consulted on every read.
		expectPerCall(`before the marker, queryRevokedStamps('CadrePeer')`, run.before.revokedStamps, MARKER_BEFORE_PER_CALL);
		expectPerCall('before the marker, queryCadrePeers()', run.before.cadrePeers, MARKER_BEFORE_PER_CALL);
		expectConsults('before the marker, authorizePeer', run.before.authorize, MARKER_BEFORE_AUTHORIZE);
		expect(busiestBlock(run.before.reconcile), 'before the marker, a reconcile pass should consult the missing Revocation block '
			+ `on every read of it. Consults per block: ${formatPerBlock(run.before.reconcile.snapshot)}`).toBeGreaterThan(1);
		expect(run.filing.snapshot.commits, 'openRevocationLedger issued no commit — the marker did not land').toBeGreaterThan(0);

		// After: every block on these paths is held and inside its read-repair window.
		expectPerCall(`after the marker, queryRevokedStamps('CadrePeer')`, run.after.revokedStamps, MARKER_AFTER_REVOKED_STAMPS);
		expectPerCall('after the marker, queryCadrePeers()', run.after.cadrePeers, MARKER_AFTER_CADRE_PEERS);
		expectConsults('after the marker, authorizePeer', run.after.authorize, MARKER_AFTER_AUTHORIZE);
		expect(busiestBlock(run.after.reconcile), 'after the marker, a reconcile pass consulted a control block more than once. '
			+ `It began ${Math.round(run.after.reconcile.atMs)}ms into the run. Consults per block: ${formatPerBlock(run.after.reconcile.snapshot)}`)
			.toBeLessThanOrEqual(1);
	}, 180_000);
});
