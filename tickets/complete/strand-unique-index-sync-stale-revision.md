----
description: On a two-node strand, the first write a founder made to a table after a second node attached sometimes failed to commit, saving the rows but not the table's uniqueness index. Two independent measurement passes on 2026-09-17 found zero reproductions across sixteen isolated test runs; this ticket asks review to confirm the close.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-second-machine.integration.ts, tickets/.pre-existing-known.md (top delta "2026-09-17 (late)"), docs/architecture.md, tickets/blocked/forked-control-collection-sync-livelocks.md, tickets/blocked/concurrent-unique-value-race-commits-both-rows.md, tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md
difficulty: easy
repro: verified
----

# Closing: the unique-index sync failure did not reproduce in sixteen isolated runs across two sessions

## What this ticket was

From 2026-07-31 the `strand-membership-closed-strand-e2e` scenario failed intermittently on the founder's first write to a table after the joiner attached the same strand. The commit died with a `PartialCommitError`: the table's data tree (`default/Member` or `default/Manager`) was durably saved, but its unique-index sub-collection (`default/Member/index/_uniq_1`, `default/Manager/index/_uniq_2`) exhausted ten sync retries with `stale revision: block <id> at rev 2, requested rev 1` and was reverted in memory only. Rows and their uniqueness index were left out of step on disk. Later sightings (2026-08-03, 2026-09-07) showed the same trigger under two other wordings: `holds committed revision 2, but its header block read as absent`, and a `content-digest-mismatch` validator rejection. The throw came from `Collection.syncInternal` in `@optimystic/db-core`, so nothing in this repository could fix it, and the ticket sat in `blocked/` until 2026-09-17, when it was unblocked on the grounds that upstream had landed fixes covering each of those fingerprints.

The full history, the hypothesis about a cold-opened sub-collection assuming revision 0, and the scope separation from `forked-control-collection-sync-livelocks` are in git history of this file under `tickets/fix/` and `tickets/blocked/`. They are not repeated here because the defect is gone, not diagnosed.

## Measurement, 2026-09-17 (fix pass)

Conditions: `../optimystic` clean and quiet at `2a1bfedb` (`v1.0.0-beta.3-183`), this repo linking its packages by path, stale-build guard green on every run, a fresh vitest process for every run, nothing else running in the tree.

| scenario | isolated runs | result |
| --- | --- | --- |
| `strand-membership-closed-strand-e2e` (now 9 tests; the ticket was filed against 5) | 5 | 9/9 in every run, 45 of 45 |
| `strand-membership-second-machine` (four-machine exposure site named by the 2026-09-08 arm) | 3 | 1/1 in every run |

Zero matches for `PartialCommitError`, `stale revision`, `SyncRetryExhausted`, `SyncRevisionStalled`, `content-digest-mismatch`, or `header block read as absent` in any of the eight logs (`tickets/.logs/strand-unique-index-sync-stale-revision.run{1..5}.log` and `.second-machine.run{1..3}.log`; they self-prune). The five closed-strand runs took 26 to 58 s wall clock; the slower ones were machine load, not retries, since every test stayed well under its 60 s budget and the physical-coverage gates passed on the first poll.

## Measurement, 2026-09-17 (implement pass — this ticket)

Conditions: at the start of this pass `../optimystic` was mid-work — a live, automated ticket run of that project's own pipeline was landing commits roughly a minute apart (`ticket(review): a-member-that-missed-a-commit-refuses-every-later-write`, then a "queue empty" bookkeeping commit at `421c724b`, 19:13:38). Per this ticket's own instruction to wait rather than build over an in-progress tree, the confirmation series did not start until that queue drained and the working tree read clean two checks in a row. Verified the `db-p2p` `dist` actually reflected the latest `src` (`cluster-repo.ts`, `pending-claim.ts` compiled at 19:13:17, after their 19:07 source edits) before running — a direct freshness check, not just a reliance on the vitest global-setup guard, since the guard was about to run against a tree that had been rebuilt only moments before. All 8 runs below used that `421c724b` build; a further optimystic commit (`f1fc816c`, 19:15:13) landed partway through the series but touched only two new ticket markdown files, not source, so it did not change what any run was compiled against.

| scenario | isolated runs | result |
| --- | --- | --- |
| `strand-membership-closed-strand-e2e` | 5 | 9/9 in every run, 45 of 45 |
| `strand-membership-second-machine` | 3 | 1/1 in every run |

Zero matches for the same six fingerprint strings (`PartialCommitError`, `stale revision`, `SyncRetryExhausted`, `SyncRevisionStalled`, `content-digest-mismatch`, `header block read as absent`) across all 8 logs (`tickets/.logs/strand-unique-index-sync-stale-revision.confirm2.run{1..5}.log` and `.confirm2.second-machine.run{1..3}.log`; self-pruning). Wall clock 25–27 s per closed-strand run, 17–18 s per second-machine run — consistent with the fix-pass timings, no retry-driven slowdown.

**Combined across both sessions: 10 isolated `strand-membership-closed-strand-e2e` runs (90/90 tests) and 6 isolated `strand-membership-second-machine` runs (6/6 tests), zero fingerprint matches.** This satisfies this ticket's own bar for closing ("independent confirmation series... combined rate... ten closed-strand runs and six second-machine runs from two sessions").

This remains a measurement, not a bisection: the disappearance is attributed to the upstream set the ticket's unblock note names (`a-commit-over-a-gapped-base-forks-the-block` `da57d4e9`, `sync-fail-fast-on-a-stalled-revision-view` `09ed71bb`, `a-half-saved-multi-collection-commit-is-reported-as-not-saved` `670e196e`, `concurrent-secondary-unique-guard` `19e865dc`, `consensus-pend-refusal-commit-tier` `aa314602`), and no single one of them was isolated as the cause. The sync-fail-fast change in particular means that if the stall ever recurs it will now surface after about two attempts as `SyncRevisionStalledError`, not after ten retries and 20 s of backoff.

## Bookkeeping already done in the fix pass

- `tickets/.pre-existing-known.md`: a closing delta at the top of the Open section, and the five entry lines this slug owned (four from 2026-07-31, one from 2026-08-02) removed. The dated narrative blocks further down that discuss those entries are left as history; the top delta supersedes them, which is this file's convention.
- `docs/architecture.md`: the two places that cited this ticket as open now say it closed, and the residual list for the tombstone reap names only `forked-control-collection-sync-livelocks`.
- `tickets/blocked/forked-control-collection-sync-livelocks.md`, `tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`, `tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md`: cross-references repointed to `complete/`; none of them closes with this ticket, and each now says so.

Not re-verified in this pass — review should spot-check that these edits are still intact, since they were made by the prior fix-pass agent and nothing in this pass touched those files.

## What is deliberately not claimed

- `forked-control-collection-sync-livelocks` (rev N / requested N, needs a manufactured fork) was not re-measured here and stays blocked on its own terms.
- `concurrent-unique-value-race-commits-both-rows` (same-tick race on a unique value) was not re-measured and stays blocked. Note for review: while this ticket's confirmation series was running, `../optimystic`'s own board picked up two new tickets from a Sereus-side report of a same-instant unique-value race storing both rows, and a commit deleting an already-moved pending record (commit `f1fc816c`, files under `../optimystic/tickets/`) — both look related to `concurrent-unique-value-race-commits-both-rows` but were not investigated as part of this ticket; flagging in case review wants to cross-reference.
- The partial-commit hole in the legacy multi-tree commit path (a data tree persisted before a sibling tree failed) is an upstream backlog concern (`feat-optimystic-legacy-commit-two-phase`, `debt-bridge-partial-commit-branch-test` in `../optimystic/tickets/backlog/`) and is not closed by anything here. It simply has no reproducer in this repo any more.

## For review

- Confirm the doc/ticket cross-reference edits listed under "Bookkeeping already done in the fix pass" are present and correct (this pass did not touch them).
- Confirm the sixteen logs referenced above are consistent with the summarized pass/fail counts if spot-checked.
- No code in this repository changed across either pass — this ticket is pure measurement plus documentation bookkeeping. There is nothing to lint, typecheck, or unit-test beyond the integration scenarios already run.
- If satisfied, move to `complete/` with a `## Review findings` section noting the two-session, sixteen-run confirmation and zero fingerprint matches.

## Review findings

- **Implement diff (`2f9b4224`) read first.** It only rewrote this ticket, apart from one unrelated file: `tickets/fix/degraded-cohort-rerun-after-upstream-dead-pend-fix.md` was added in the same commit. That ticket is about a different upstream fix and belongs to a separate flow. I left it alone.
- **The 16 measurement logs.** I checked all sixteen (`tickets/.logs/strand-unique-index-sync-stale-revision.run{1..5}`, `.second-machine.run{1..3}`, `.confirm2.run{1..5}`, `.confirm2.second-machine.run{1..3}`). Every closed-strand log ends `Tests 9 passed (9)` and every second-machine log ends `Tests 1 passed (1)`. None of them contains any of the six fingerprint strings. The claimed 90/90 and 6/6 hold.
- **Bookkeeping from the fix pass (`05fdd6f1`).** All of it is present and correct:
  - `docs/architecture.md` now shows one open arm and cites `complete/`.
  - `.pre-existing-known.md` has the closing delta at the top, and the five owned entry lines are removed.
  - The cross-references in `blocked/forked-control-collection-sync-livelocks`, `blocked/concurrent-unique-value-race-commits-both-rows` and `backlog/debt-composite-pk-point-lookup-unreliable-untracked` are repointed, and each says it does not close with this ticket.
  - The first `docs/architecture.md` hunk in that commit only touches the end of one line (probably whitespace). The content is unchanged.
- **Missed site (minor, fixed).** The `NOTE:` above `index FormationUsageByToken` still cited `tickets/fix/strand-unique-index-sync-stale-revision` as "an open, intermittent engine failure". It appears in both `schemas/control.qsql` and the embedded copy in `packages/cadre-core/src/control-schema.ts`. I reworded it the same way in both copies: the failure is now marked as closed on 2026-09-17 and points to `complete/`. I kept the warning itself, which says to suspect this index first if joins start failing with an index-sync error naming FormationUsage. It still applies, because a recurrence would now surface quickly as `SyncRevisionStalledError`. `control-schema-drift.spec.ts` passes, which confirms the two copies still match. `eslint` on the file is clean and `cadre-core` rebuilt without errors.
- **Historical mentions left alone on purpose.** Narrative blocks in `.pre-existing-known.md`, `.garden-report.md` and older `complete/` tickets are dated history. The top delta in `.pre-existing-known.md` supersedes them, which is how that file works.
- **Code quality, tests, performance, resource cleanup, error handling, type safety.** Not applicable. No runtime code changed in any pass, and the one source edit is a comment inside the schema text. I did not repeat the integration series: two sessions and 16 isolated runs already meet the ticket's closing bar.
- **Possibly related upstream tickets (noted, not filed).** `../optimystic` commit `f1fc816c` added upstream tickets about a same-instant unique-value race that stores both rows. They look related to `blocked/concurrent-unique-value-race-commits-both-rows`. That blocked ticket already tracks the problem upstream (see commit `402d8d06`), so I filed nothing new.
- **Tripwires.** None new. The existing tripwire on the FormationUsage index write path stays in place, reworded as described above.
