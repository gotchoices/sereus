import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { createOwnerKey } from '../src/owner-key-store.js';
import type { StrandWatcher } from '../src/strand-watcher.js';
import type { PendingJoinRunner } from '../src/pending-join-runner.js';
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
 * Before genesis every control table is a missing block, which is what the cold phase pays.
 * Genesis commits an empty collection for every control table
 * (`ControlDatabase.commitEmptyControlCollections`), so after it no control read on this party
 * reads a missing block, and the membership reads every flow repeats are answered from the
 * membership rows view (`membership-view.ts`) until a table changes. So the per-call phases and
 * the idle reconcile pass measure 0: a consult there means a control read reached a block this
 * node does not hold. If any figure moves, find out why before re-pinning.
 *
 * **Phases**, on one solo `CadreNode` (`profile: 'transaction'`, one `MemoryRawStorage`
 * per storage id), each measured from a zeroed counter: cold `start()`; genesis
 * (`ensureOwnerKey` with a generated owner key and `useOwnerSigner` to wire it, the
 * production calls); `foundStrand`, with the
 * control network's and the strand's consults reported separately by which
 * `CoordinatorRepo` issued them; six back-to-back calls each of
 * `queryRevokedStamps('CadrePeer')` and `queryCadrePeers()`; one idle
 * `reconcileControlCohort()` pass.
 *
 * **Background work is taken out of the phases, not budgeted around.** See
 * {@link settleStart}: the self-registration timer and the pending-join retry loop are
 * disarmed, and the two reads `start()` leaves running are awaited and charged to the cold
 * phase, since every start pays them. The one background reader left is the membership gate
 * watch, which refreshes the gate 50 ms after a membership table changes; the two phases that
 * write such a table wait for it ({@link settleGateWatch}) and are charged its reads.
 *
 * **Timing.** Missing-block consults do not depend on time; held-block consults do. The
 * whole run measured under 1 s (the per-call reads began 843–864 ms in, over three runs on
 * 2026-10-20), far inside one 10 s window, and every count below assumes the
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

/** The strand watcher's backstop and the reconcile pass's backstop, pushed past any run. */
const IDLE_TIMER_MS = 3_600_000;

/**
 * Twice the gate watch's coalescing window (`TABLE_CHANGE_COALESCE_MS`, 50 ms): long enough
 * for the refresh a membership write earns to have started.
 */
const GATE_WATCH_SETTLE_MS = 100;

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
const MEASURED_ON = '2026-10-25';
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
 *
 * One upstream change on 2026-09-20 halved every commit count and moved no consult count: at
 * `e6e84aa1` a commit whose blocks one coordinator covers sends the log tail and the data blocks
 * in one commit, where it used to commit the tail first and then the rest. Cold 2 → 1, genesis
 * 4 → 2, `foundStrand` 6 → 3 on each side, the marker's filing 2 → 1.
 *
 * Re-measured whole at `461a01bc` on 2026-10-01 (its working tree then carried uncommitted
 * dial-deadline edits): no figure moved from `cadcb919` except the cold start, whose growth is
 * the two control tables Sereus added since (see {@link COLD}).
 *
 * Re-measured whole at `5a5661b0` on 2026-10-06 (clean tree): no figure moved except the cold
 * start, whose growth is the two cadre-invitation tables (see {@link COLD}).
 *
 * Re-measured whole at `ff150e0f` on 2026-10-07 (clean tree): the only figures that moved are
 * the marker test's "before" counts for `authorizePeer` and the idle reconcile, each up by one
 * `Revocation` consult, and the cause is on this side, not upstream: the trusted-owner anchor
 * sync (`CadreNode.syncOwnerAnchor`, ticket `owner-anchor-derivation`) now reads the tombstone
 * list at the head of every membership refresh, and both paths trigger a refresh.
 *
 * Re-measured whole at `ff150e0f` on 2026-10-16 (clean tree): no figure moved except the cold
 * start, whose growth is the two owner-grant tables (see {@link COLD}).
 *
 * Re-measured whole at `ff150e0f` on 2026-10-07, later the same day, after every owner lookup in
 * the control schema gained its live-owner clause (`removed-owner-still-authorizes-where-its-row-survives`):
 * each owner-gated write's check now reads `Revocation` once more, so `foundStrand`'s control
 * side 7 → 8, the marker test's `authorizePeer` before the marker 4 → 5 and the marker's own
 * filing 2 → 3. After the marker nothing moved: the block is held and inside its window. The
 * idle reconcile before the marker measured 6 both before and after that change: the 5 the
 * previous paragraph recorded predates the review pass of that ticket, which reworked the anchor
 * sync, and the table below now says 6.
 *
 * Re-measured whole at `28e6e044` on 2026-10-17, with the working tree carrying
 * `strand-founder-commits-every-table-collection`: the strand side of `foundStrand` moved, from
 * this side (see {@link FOUNDING_STRAND}). Two control-side figures also differ from what was
 * recorded, and measure the same with that ticket's founding step disabled, so it did not move
 * them; neither has been attributed. The idle reconcile is 5 (`Revocation` ×3, `CadrePeer` ×2)
 * where {@link RECONCILE} recorded 4, and the marker test's idle reconcile before the marker is
 * 5 where its table recorded 6.
 *
 * The marker test these paragraphs mention was removed by `control-collections-created-at-cadre-founding`,
 * since genesis now gives `Revocation` its collection and the marker no longer changes what a read costs;
 * the marker's filing path went with `revocation-ledger-marker-removed`.
 *
 * Re-measured whole at `009bbee0` on 2026-10-20 (clean tree), three runs identical, with three
 * changes from this side in the tree, each attributed by measuring with the other two disabled:
 *  - `control-collections-created-at-cadre-founding`: genesis commits an empty collection for
 *    every control table, so genesis 3 → 20 consults and 2 → 34 commits (see {@link GENESIS}),
 *    and no later phase reads a missing block: `foundStrand`'s control side 7 → 4, the per-call
 *    phases and the idle reconcile to 0.
 *  - `control-membership-rows-cached-until-changed`: membership reads are answered from the
 *    membership rows view. Alone it takes `foundStrand`'s control side 7 → 5 (one `Revocation`
 *    and the `CadrePeer` read served from the view) and the per-call phases and the idle
 *    reconcile to 0. With the collections present it moves nothing further here: on a solo party
 *    every block it saves a read of is held and inside its window. It is measured on two machines
 *    by `message-cost-accounting`.
 *  - `strand-founding-control-writes-in-one-transaction`: `foundStrand` reads the `Strand` row
 *    once, not twice, so its control side 8 → 7 with neither of the others.
 * With the first two disabled every other figure measured what `28e6e044` did, so neither the
 * optimystic commits since nor `strand-watcher-woken-by-control-changes` moved this spec.
 *
 * Re-measured whole at `b7d70516` on 2026-10-20, three runs identical: only `foundStrand`'s
 * strand side moved, from this side (`strand-founding-writes-batched`, see {@link FOUNDING_STRAND});
 * every other figure equals the `009bbee0` measurement.
 *
 * Re-measured whole at `de8cbb54` on 2026-10-20, later the same day, three runs identical
 * (`control-reconcile-woken-by-changes-reads-once`): genesis 20 → 24 consults over 19 → 23
 * blocks and `foundStrand`'s control side 4 → 1 over 4 → 1; nothing else moved. Three causes,
 * split by measuring once more with the gate watch not taken:
 *  - the gate watch `CadreNode.start` now takes on the membership tables refreshes the gate
 *    50 ms after genesis's `OwnerKey` insert, and that refresh loads the three membership views
 *    (the refresh the membership listener runs inside the write reads through the committed-read
 *    path and keeps nothing), so the first consult of two tree blocks that `foundStrand`'s
 *    membership reads used to pay is paid at genesis: +2 / −2;
 *  - the spec now waits for that refresh inside the genesis phase ({@link settleGateWatch}), and
 *    the strand watcher's run after genesis's empty `Strand` / `JoinedStrand` commits lands
 *    inside that wait instead of inside `foundStrand`: +1 / −1;
 *  - one tree block more is consulted once at genesis with the gate watch not taken too (22 over
 *    21 then, against the 20 over 19 recorded), so it is not that ticket's. Unattributed; the
 *    one cadre-core change between the two measurements is
 *    `control-invitation-and-grant-chains-cached-until-changed`.
 * The optimystic tree carried an uncommitted edit to `coordinator-repo.ts` whose `dist` was
 * built before it; the stale-build guard refused every run after these three.
 *
 * Re-measured whole at `00fa26b0` on 2026-10-25, a descendant of the 1.19.0 release (`f1f774ea`),
 * three runs identical; its working tree carried uncommitted promise-shortfall edits to db-core
 * and db-p2p that do not touch the commit path. Only commit counts moved, all from upstream:
 * Optimystic 1.19.0 commits a transaction's collections as one consensus record (GitHub #42,
 * `CoordinatorRepo.commitMany`), so a write touching a table and its indexes is one commit, not
 * one per tree. Genesis 34 → 33 (the owner key insert's 2 → 1) and `foundStrand`'s control side
 * 3 → 1; no consult count moved. `cohort-consult-counter.ts` now counts `commitMany`, which
 * `commit` delegates to; counting `commit` alone missed every multi-collection commit.
 */
const BASELINE_UPSTREAM = 'optimystic 00fa26b0';

/**
 * Cold: `start()` against empty storage, plus the membership-gate seed and the strand
 * watcher's first poll it leaves running. 41 consults over 33 blocks, 1 commit. Every
 * control table and index block is consulted once as the schema is applied (all missing),
 * the schema catalog (`optimystic/schema`) 5 times, and four never-written tables once
 * more each: `CadrePeer` and `Revocation` by the gate seed's `queryCadrePeers`, `Strand` and
 * `JoinedStrand` by the watcher's `queryStrands` / `queryJoinedStrands`. 32 + 5 + 4 = 41.
 * History: 24 over 18 blocks in the trace that motivated this spec (snapshotted at `start()`'s
 * return, before the seed and the poll), 30 on 2026-09-15, 25 over 18 at optimystic
 * `03ffadc4` — the catalog went 7 → 5 and each of the three never-written tables 3 → 2 — 26
 * over 19 once Sereus re-declared the `FormationUsageByToken` index
 * (`restore-formation-usage-token-index`), one more block consulted once as the schema is
 * applied, then 31 over 23 with `JoinedStrand` (its table and stamp index, and the watcher's
 * read: +3 over 2 blocks) and `PendingJoin` (its table and stamp index, read by nothing at
 * start: +2 over 2 blocks), 33 over 25 once `PendingJoin` became `JoinRequest` with its two
 * index-less outcome tables (`JoinSuccess`, `JoinFailure`: +2 over 2, recorded here late),
 * then 37 over 29 with `CadreInvite` (its table and stamp index) and `CadreInviteUsage` (its
 * table and the `CadreInviteUsageByInvite` index), read by nothing at start: +4 over 4, then
 * 41 over 33 with `OwnerGrant` (its table and stamp index) and `OwnerGrantUsage` (its table
 * and the `OwnerGrantUsageByGrant` index), read by nothing at start: +4 over 4.
 */
const COLD: Budget = { consults: 41, blocks: 33, commits: 1, consultBudget: 45, blockBudget: 36, commitBudget: 2 };
/**
 * Genesis: `ensureOwnerKey` on the fresh party, wiring the owner signer (no read), then the
 * membership gate refresh the insert earns ({@link settleGateWatch}). 24 consults over 23
 * blocks, 34 commits: each of the 17 control tables' main block ×1, `OwnerKey`'s once more,
 * and 1 each on six tree blocks — the insert's two, two the gate refresh's view loads read
 * first, one the strand watcher's run reads, and one unattributed (see
 * {@link BASELINE_UPSTREAM}). The 33 commits are the 32 empty collections genesis commits (17
 * tables, 3 indexes, 12 unique stamp trees) and the owner key insert's 1, which carries both
 * `OwnerKey` trees. History: 14 over 3
 * blocks in the motivating trace and on 2026-09-15 (`OwnerKey` ×6, its stamp index ×6, the
 * never-written `Revocation` ×2), exactly halved to 7 (×3, ×3, ×1) at optimystic `03ffadc4`,
 * then 3 with 2 commits at `8a0b48c7` — the insert's commit touches both `OwnerKey` trees and
 * no longer refreshes them twice before flushing — then 20 with 34 commits once genesis
 * committed every control table's collection (`control-collections-created-at-cadre-founding`),
 * then 24 once the gate watch's refresh and the strand watcher's run were settled inside this
 * phase (`control-reconcile-woken-by-changes-reads-once`), then 33 commits once the insert's two
 * trees committed as one record (Optimystic 1.19.0, GitHub #42).
 */
const GENESIS: Budget = { consults: 24, blocks: 23, commits: 33, consultBudget: 27, blockBudget: 25, commitBudget: 34 };
/**
 * `foundStrand`, control network side: the `Strand` row published. 1 consult over 1 block,
 * 1 commit, carrying all three `Strand` trees (3 commits, one per tree, before Optimystic
 * 1.19.0, GitHub #42). The consult is one tree block of the publish's own commit, none on a
 * table's main block, since genesis committed every control table's collection, and none for
 * its membership reads, whose views the gate watch's refresh loaded at genesis. History: 25 over 6 blocks on 2026-09-15 (×8,
 * ×6, ×4, ×4, ×2, ×1), 13 over the same 6 at optimystic `03ffadc4` (`Strand` ×4, `StampId`
 * index ×3, `MemberPrivateKey` index ×2), 7 over 5 at `8a0b48c7`: the publish's commit
 * touches all three `Strand` trees and no longer refreshes each twice before flushing, which
 * was the `MemberPrivateKey` index's only consults; 8 over 5 once every owner lookup read
 * `Revocation` (2026-10-07): `Strand` ×2, its `StampId` index ×1, the never-written
 * `Revocation` ×3 (the publish's `NotRevoked`, the live-owner clause on its owner lookup, and
 * the membership read beside `CadrePeer` ×1) and a tree block ×1; then 4 over 4 on 2026-10-20
 * (three causes, see {@link BASELINE_UPSTREAM}), then 1 over 1 later that day once the gate
 * watch's refresh at genesis loaded the views (`control-reconcile-woken-by-changes-reads-once`).
 * Control and strand together now sum to 30 consults and 15 commits, against 30 and 17 before
 * Optimystic 1.19.0, 33 and 17 before that, 34 and 18 before the founder's strand rows landed in one
 * transaction (`strand-founding-writes-batched`), 38 and 18 before genesis committed the control collections,
 * 29 and 6 before the founder committed every declared table's collection (see
 * {@link FOUNDING_STRAND}), 28 and 6 before the live-owner clause, 28 and 12 at `8a0b48c7`, 34
 * and 12 at `03ffadc4`, 50 and 12 on 2026-09-15, and 47 and 12 in the trace taken before
 * upstream removed the absence memo.
 */
const FOUNDING_CONTROL: Budget = { consults: 1, blocks: 1, commits: 1, consultBudget: 2, blockBudget: 2, commitBudget: 2 };
/**
 * `foundStrand`, strand side: strand node up, membership and sApp schemas applied, founder
 * bootstrap. 29 consults over 15 blocks, 14 commits: the strand's schema catalog ×5,
 * `Header` ×3, each other strand table and `App.Note` ×2 (once as its schema is applied, all
 * missing, and once as the founder commits its empty collection), each of the three unique
 * stamp indexes ×1, and 1 each on two tree blocks the bootstrap created. The 14 commits are
 * the 11 empty collections (the 7 strand tables other than `Header`, the 3 stamp indexes,
 * `App.Note`), the 2 schema applies' catalog commits, and the open strand's founding
 * transaction, whose `Header` insert creates that table's collection. All of it is local: nothing else holds the strand at founding.
 * History: 25 over 15 blocks on 2026-09-15 (catalog ×7, `Header` ×5), 21 over 15 with 3
 * commits at optimystic `03ffadc4` (only the two repeatedly-read blocks moved; the 11
 * apply-once blocks did not), then 30 over 16 with 15 commits once the founder committed every
 * declared table's collection before its Header (`strand-founder-commits-every-table-collection`):
 * +1 consult on each of the 8 tables, +1 on a tree block, +12 commits; then 29 over 15 with 14
 * commits once the founding transaction's own tables were left out of the empty commits
 * (`strand-founding-writes-batched`): `Header`'s empty commit and one tree block's consult went.
 */
const FOUNDING_STRAND: Budget = { consults: 29, blocks: 15, commits: 14, consultBudget: 34, blockBudget: 18, commitBudget: 15 };
/**
 * `reconcileControlCohort`, one idle pass on the founded solo party: nothing, and nothing
 * allowed. Its membership reads are answered by the view, and the blocks behind them are held
 * and inside their window. History: 8 over 2 blocks on 2026-09-15 (`CadrePeer` and
 * `Revocation`, both never written, twice each), 4 since `03ffadc4`, 5 when re-measured on
 * 2026-10-17 (a third `Revocation` consult, never attributed), 0 on 2026-10-20 (either of two
 * causes alone, see {@link BASELINE_UPSTREAM}).
 */
const RECONCILE: Budget = { consults: 0, blocks: 0, commits: 0, consultBudget: 0, blockBudget: 0, commitBudget: 0 };
/** The strand's repo during the idle reconcile pass: nothing, and nothing allowed. */
const RECONCILE_STRAND: Budget = { consults: 0, blocks: 0, commits: 0, consultBudget: 0, blockBudget: 0, commitBudget: 0 };
/**
 * `queryRevokedStamps('CadrePeer')` per call: nothing on any call. The `Revocation` rows come
 * from the membership rows view, loaded earlier in the run, and the block behind it is held
 * (genesis committed its collection) and inside its window; either alone measures 0 (see
 * {@link BASELINE_UPSTREAM}), so this pin cannot tell them apart, and `membership-view.spec.ts`
 * covers the view. History: `Revocation` ×1 on every call while the table was a missing block,
 * which is consulted on every read: 2 per call on 2026-09-15, 1 from optimystic `03ffadc4`
 * (the same block consulted once per refresh instead of twice) until 2026-10-17. The motivating
 * trace measured [4, 2, 2, 2, 2, 2] right after genesis rather than after founding.
 */
const REVOKED_STAMPS_PER_CALL = [0, 0, 0, 0, 0, 0];
/**
 * `queryCadrePeers()` per call: nothing on any call, for {@link REVOKED_STAMPS_PER_CALL}'s
 * reasons. History: `CadrePeer` ×1 and `Revocation` ×1 on every call while both were missing
 * blocks (self-registration, which would write this node's `CadrePeer` row, is disarmed): 4 per
 * call on 2026-09-15, 2 from `03ffadc4` until 2026-10-17. The motivating trace measured 2 per
 * call once a `CadrePeer` row existed, and 0 once `Revocation` was held too.
 */
const CADRE_PEERS_PER_CALL = [0, 0, 0, 0, 0, 0];

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
	pendingJoinRunner: PendingJoinRunner | null;
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
 *  - the 1 s self-registration timer (a `registerSelf` read, then the reconcile schedule
 *    with its eager pass and backstop, and the 7.5-minute heartbeat) is disarmed, so none of
 *    it ever runs: every reconcile pass in this run is one the spec calls;
 *  - the pending-join retry loop is stopped: wiring the owner signer at genesis kicks a pass,
 *    which reads the never-written join tables at whatever phase it lands in;
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
	internals.pendingJoinRunner?.stop();

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

/**
 * Wait for the membership gate refresh a phase's membership-table write earns: the gate
 * watch (`CadreNode.start`, through `ControlDatabase.watchMembershipTables`) runs it 50 ms after the commit, and
 * it would otherwise land inside whatever phase is measured next. The reconcile schedule it
 * would also trigger is never built here (the self-registration timer is disarmed), so the
 * refresh is all it starts. Called inside the phase, so the refresh's reads are charged to
 * the write that caused them; served from the membership rows view, they cost no consult.
 */
async function settleGateWatch(node: CadreNode): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, GATE_WATCH_SETTLE_MS));
	await (node as unknown as CadreNodeInternals).membershipGateDrain;
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
 * backstop pushed past any run. Not started.
 */
function soloNode(): CadreNode {
	return new CadreNode({
		...controlNodeConfig({
			partyId: freshPartyId(SCOPE),
			profile: 'transaction',
			keyStore: new InMemoryKeyStore(),
			storage: memoryStorageProvider(),
			// Belt and braces: disarming self-registration already leaves the schedule unbuilt.
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
		const owner = await createOwnerKey(new InMemoryKeyStore());
		const genesis = await measurePhase(counter, runStart, 'genesis', undefined, async () => {
			expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(owner.publicKey))).toBe(true);
			await within('useOwnerSigner() (genesis)', OP_TIMEOUT_MS, () => node.useOwnerSigner(owner));
			// The `OwnerKey` insert is a membership-table change.
			await settleGateWatch(node);
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
			// Founding writes no membership table, so this settles nothing; it keeps the per-call
			// phases free of a refresh should founding ever write one.
			await settleGateWatch(node);
		});

		// Empty: nothing is revoked, and self-registration, which would write this node's row, is disarmed.
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
	// below skips it. Today that is safe only because the two such phases (RECONCILE and
	// RECONCILE_STRAND) also carry a ceiling of 0, and a 0 ceiling pins it exactly. If a re-baseline ever
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
 * a behaviour change to re-measure.
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
