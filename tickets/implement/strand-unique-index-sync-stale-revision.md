----
description: On a two-node strand, the first write a founder made to a table after a second node attached sometimes failed to commit, saving the rows but not the table's uniqueness index. Measured on 2026-09-17 it no longer happens; this pass confirms that with a second independent series and closes the ticket.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-second-machine.integration.ts, tickets/.pre-existing-known.md (top delta "2026-09-17 (late)"), docs/architecture.md, tickets/blocked/forked-control-collection-sync-livelocks.md, tickets/blocked/concurrent-unique-value-race-commits-both-rows.md, tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md
difficulty: easy
repro: verified
----

# Closing: the unique-index sync failure did not reproduce in eight isolated runs

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

This clears the bar the ticket set for itself ("at least 5 isolated runs with a rate attached"). It is still a measurement, not a bisection: the disappearance is attributed to the upstream set the ticket's unblock note names (`a-commit-over-a-gapped-base-forks-the-block` `da57d4e9`, `sync-fail-fast-on-a-stalled-revision-view` `09ed71bb`, `a-half-saved-multi-collection-commit-is-reported-as-not-saved` `670e196e`, `concurrent-secondary-unique-guard` `19e865dc`, `consensus-pend-refusal-commit-tier` `aa314602`), and no single one of them was isolated as the cause. The sync-fail-fast change in particular means that if the stall ever recurs it will now surface after about two attempts as `SyncRevisionStalledError`, not after ten retries and 20 s of backoff.

## Bookkeeping already done in the fix pass

- `tickets/.pre-existing-known.md`: a closing delta at the top of the Open section, and the five entry lines this slug owned (four from 2026-07-31, one from 2026-08-02) removed. The dated narrative blocks further down that discuss those entries are left as history; the top delta supersedes them, which is this file's convention.
- `docs/architecture.md`: the two places that cited this ticket as open now say it closed, and the residual list for the tombstone reap names only `forked-control-collection-sync-livelocks`.
- `tickets/blocked/forked-control-collection-sync-livelocks.md`, `tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`, `tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md`: cross-references repointed to `complete/`; none of them closes with this ticket, and each now says so.

## What is deliberately not claimed

- `forked-control-collection-sync-livelocks` (rev N / requested N, needs a manufactured fork) was not re-measured here and stays blocked on its own terms.
- `concurrent-unique-value-race-commits-both-rows` (same-tick race on a unique value) was not re-measured and stays blocked.
- The partial-commit hole in the legacy multi-tree commit path (a data tree persisted before a sibling tree failed) is an upstream backlog concern (`feat-optimystic-legacy-commit-two-phase`, `debt-bridge-partial-commit-branch-test` in `../optimystic/tickets/backlog/`) and is not closed by anything here. It simply has no reproducer in this repo any more.

## TODO

- Run an independent confirmation series in a fresh session: `strand-membership-closed-strand-e2e` five times and `strand-membership-second-machine` three times, each in isolation from `packages/integration-tests` with `yarn vitest run <file> --reporter=verbose`, tee'd into `tickets/.logs/`. Confirm `../optimystic` is clean and the stale-build guard is green first; if it is mid-work, wait rather than building over it.
- Grep every log for the six fingerprint strings listed above. All must be absent.
- If any run is red with one of those fingerprints: re-run once with `DEBUG='optimystic:db-core:collection,optimystic:db-p2p:*'`, file the trace as a new ticket in `../optimystic/tickets/fix/` (no upstream ticket for this defect has ever existed), re-add the failing test(s) to `tickets/.pre-existing-known.md` pointing at that upstream slug, and move this ticket to `blocked/` behind it instead of onward.
- If all green: hand to `review/` with the combined rate (this pass's 5+3 plus yours) recorded in the measurement table, so the record that lands in `complete/` carries ten closed-strand runs and six second-machine runs from two sessions.
