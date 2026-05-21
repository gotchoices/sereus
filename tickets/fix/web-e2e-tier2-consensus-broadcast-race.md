---
description: 3 of 16 Tier 2 distributed e2e specs (`two-tab-convergence`, `cross-tab-activity`, `disconnect-mid-session`) intermittently fail with `cluster-tx:consensus-broadcast-error` after the supermajority fix landed. Coordinator reaches commit-majority, then broadcast of the merged commit record to all 3 peers throws on at least one peer; `scheduleCommitRetry` schedules a 2 s retry, but tab B can sample the peer that missed the broadcast inside that window and not see the message. Mechanism is documented; the right fix (retry tuning, eager re-dial, coordinator-driven read repair, …) is open.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts
---

## Symptom

With `cluster-size 3` and `super-majority-threshold 0.51`
(commit-majority = 2-of-3), three Tier 2 specs fail intermittently:

- `e2e/distributed/two-tab-convergence.spec.ts`
- `e2e/distributed/cross-tab-activity.spec.ts`
- `e2e/distributed/disconnect-mid-session.spec.ts`

The supermajority-failed bug this followed (`cluster-tx:supermajority-failed`)
is fully fixed — the implementer's debug trace found zero occurrences in
two re-runs. Instead these runs surface `cluster-tx:consensus-broadcast-error`
on the post-majority broadcast.

## Mechanism (from implement-stage debug trace)

`ClusterCoordinator.executeClusterTransaction` reaches the commit-majority
threshold, merges signed commits, then broadcasts the merged commit record
back to **all** cluster members (`cluster-coordinator.ts` around the
`cluster-tx:consensus-broadcast` log site at line 537). At least one
per-peer broadcast throws (`'cluster-tx:consensus-broadcast-error'`). The
coordinator calls `scheduleCommitRetry(messageHash, record, broadcastFailures)`
at line 553 / 560, which queues a retry on an initial 2 s interval with
exponential backoff (`scheduleCommitRetry`, line 584 → `retryCommits`,
line 621).

In the 2 s window between failure and retry success, the other browser
tab can query the cluster member that missed the broadcast, get a stale
view, and the spec's polling assertion times out.

## Observations from the debug trace

- The same peers had returned successful per-peer `:commit-response`
  earlier in the same transaction, so the post-majority re-broadcast
  must be re-dialling and losing the connection between the two phases.
- The browser's `NetworkTransactor.get:retry` path fires frequently in
  the same trace — reads are also flapping. Worth checking whether the
  browser's circuit-relay reservation is being recycled mid-transaction.
- One spec (`two-tab-convergence`) failed at the **local optimistic
  write** in tab A, which doesn't touch the network at all. That points
  at a `MessageApp` / Svelte reactivity race triggered by concurrent
  cluster-tx work — possibly a re-entrant refresh dropping the local
  mutation. Worth a `localExecuted` / `executedTransactions` audit on
  the cluster-repo side.

## Design questions for the fix-stage

- **Retry timing.** Initial 2 s + exponential backoff vs. the e2e
  polls (20–30 s) leaves a wide visible inconsistency window even on a
  successful retry. Should the first retry be more aggressive
  (~100–250 ms) so reads almost never observe the gap?
- **Re-dial vs. piggyback.** If the per-peer broadcast loses its
  connection between commit-response and the merged-commit broadcast,
  the cheap fix is to reuse the open connection from the earlier
  commit-response phase rather than re-dial.
- **Coordinator-driven read repair.** Alternatively, when a query lands
  on a peer that doesn't yet have the merged-commit record, the peer
  could ask the coordinator for the latest committed record before
  responding. This trades a round-trip for correctness; may be cleaner
  than tuning retries.
- **Circuit-relay reservation lifetime.** Confirm whether the browser's
  `RelayDiscovery` reservation is being recycled inside the transaction
  window. If so, the broadcast path may be observing a "fresh" connection
  that hasn't fully re-handshaked.

## Reproducing

```powershell
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"
# or, with cluster-tx debug trace:
$env:OPTIMYSTIC_E2E_DEBUG = "1"
yarn workspace @serfab/reference-app-web test:e2e --grep "two-tab convergence"
```

Failure rate at time of filing: ~3 of 16 specs per run; same three
specs each time. Debug trace recipe and search terms are noted in the
completed `web-e2e-tier2-cluster-supermajority` ticket.

## Acceptance

- All 16 Tier 2 distributed specs pass three runs in a row locally.
- `cluster-tx:consensus-broadcast-error` either does not appear or, if
  it does, the recovery is fast enough that no spec observes the gap.
