---
description: Review of the in-broadcast immediate retry + faster scheduled-retry knobs added to ClusterCoordinator. Implementation matches the ticket design; unit specs (3 new) pass alongside the existing 11 ClusterCoordinator specs; full @optimystic/db-p2p suite is 443 passing / 5 pending / 0 failing. The trace confirms `cluster-tx:consensus-broadcast-retry` fires in the browser, but the e2e is *worse* than baseline (3-of-3 deterministic vs 3-of-16 flake) because the shortened total retry budget can no longer outlast the underlying transport instability (dial:fail rate ~15% in run logs). The ticket explicitly anticipates this case and prescribes follow-up tickets — capture those when reviewing.
files: ../optimystic/packages/db-core/src/cluster/structs.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/cluster-coordinator.spec.ts
---

## What landed

### Config plumbing (`ClusterConsensusConfig`)

Added five optional fields to
`@optimystic/db-core/src/cluster/structs.ts` (lines 54–67):

| Field | Default | Replaces |
|---|---|---|
| `commitBroadcastRetryInitialMs` | 250 | hard-coded 2000 |
| `commitBroadcastRetryBackoffFactor` | 2 | hard-coded 2 |
| `commitBroadcastRetryMaxIntervalMs` | 8000 | hard-coded 30000 |
| `commitBroadcastRetryMaxAttempts` | 5 | hard-coded 5 |
| `commitBroadcastImmediateRetries` | 1 | (new behavior) |

All five are mirrored into the `policy` literal in
`db-p2p/src/repo/coordinator-repo.ts:82–95` with `??` defaults so the
coordinator constructor receives a fully-populated
`ClusterConsensusConfig & { clusterSize: number }`.

`ClusterCoordinator` (cluster-coordinator.ts:38–63) promotes the four
retry literals to constructor-set private fields reading from `cfg`,
plus a new `commitBroadcastImmediateRetries` private field.

### In-broadcast immediate retry

New helper `broadcastMergedRecord(record, peerIds)` at
`cluster-coordinator.ts:543–594` replaces the inline
`Promise.allSettled` block (formerly at lines 531–541).

Per peer:
- Local cluster: one attempt only (local failures are fatal, not transient).
- Remote peer: `1 + commitBroadcastImmediateRetries` attempts in a tight loop.
- Logs `cluster-tx:consensus-broadcast-retry` with
  `{ messageHash, peerId, attempt, error }` on each non-terminal failure.
- Logs `cluster-tx:consensus-broadcast-error` only on terminal failure
  (after all attempts exhausted), now with `attempts` in the payload.

`commitTransaction` continues to consume the helper's `failures` array
and hand it to `scheduleCommitRetry`, so the scheduled-retry timer path
is unchanged in shape — only the initial interval, cap, and presence of
the in-line layer are new.

### Total budget: 60 s → 7.75 s (by design)

`250 + 500 + 1000 + 2000 + 4000 = 7.75 s` vs the prior
`2000 + 4000 + 8000 + 16000 + 30000 = 60 s`. **The ticket explicitly
intends this**: "if the first 7 s of retries don't land, the
post-majority broadcast is unrecoverable from the coordinator's side
anyway, and the cleaner outcome is to let peer-side gossip /
read-repair / next-write paths take over rather than holding state for
a full minute."

### Unit specs (`db-p2p/test/cluster-coordinator.spec.ts`)

Mock client extended with `commitPhaseCalls` counter and
`failOnCommitCall: number | null` (fail on Nth commit-phase call).
Existing `failCommit: boolean` retained.

New `describe('ClusterCoordinator broadcast in-line retry')` block adds:

1. **Recovers when first broadcast attempt fails but in-line retry
   succeeds** — peer fails on its 2nd commit-phase call only
   (call 1 = commit, call 2 = broadcast attempt 1 fails, call 3 =
   broadcast in-line retry succeeds). Asserts all 3 commits in record,
   no scheduled retry timer set, no extra calls after 400 ms.
2. **Schedules a 250 ms retry when both broadcast attempts fail** —
   peer's `failCommit = true` from start. Asserts `updateCalls === 4`
   (1 promise + 1 commit-fail + 2 broadcast attempts both fail) and
   `txState.retry.intervalMs === 250` with the failing peer in
   `pendingPeers`.
3. **Honors custom config** — pass
   `commitBroadcastRetryInitialMs: 100,
   commitBroadcastImmediateRetries: 2`; asserts 5 calls (1+1+3) and
   `txState.retry.intervalMs === 100`.

One existing spec was rewritten for the new behavior:
`retries failed commit peer in the background` — the assertion that
`updateCalls === 3` after `executeClusterTransaction` returns is now
`=== 4` because the broadcast performs 1 + 1 in-line retry when the
peer is unreachable. The post-await wait was also tightened from
2500 ms (matching the old 2000 ms initial interval) to 500 ms
(matching the new 250 ms default).

The remaining four retry specs continue to pass unchanged — they
assert `>=` on call counts, which the new behavior satisfies.

## Validation actually run

| Step | Outcome |
|---|---|
| `yarn workspace @optimystic/db-core build` | clean |
| `yarn workspace @optimystic/db-p2p build` | clean |
| `yarn workspace @optimystic/db-p2p test` | **443 passing**, 5 pending, 0 failing (baseline was 440) |
| `yarn workspace @optimystic/db-p2p test --grep "ClusterCoordinator"` | 14 passing |
| `yarn workspace @optimystic/reference-peer build` | clean |
| `yarn workspace @serfab/reference-app-web typecheck` | clean |
| 3 historically-flaky Tier 2 specs, run 1 | **3 failed of 3** |
| Same specs, run 2 | **3 failed of 3** |

Run 3 was skipped — runs 1 and 2 failed identically (same three specs,
same `toBeVisible` timeout pattern after 20–30 s waits), so a third
run was not going to add information beyond what the first two
already show.

## What the e2e trace shows

In the run-1 browser trace
(`C:\Temp\tier2-run1.log`, captured with
`OPTIMYSTIC_E2E_DEBUG=1`):

- `cluster-tx:commit-majority-reached` × 12 — every transaction
  reached commit-majority cleanly.
- `cluster-tx:consensus-broadcast-retry` × 13 — the new in-line retry
  path **does fire** in the browser as expected, proving the
  config-plumbing and helper wiring are correct end-to-end.
- `cluster-tx:consensus-broadcast-error` × 13 — but every in-line
  retry **also fails**. The connection error is not the in-flight
  stream bouncing the ticket assumed; it's persistent enough to
  survive a back-to-back re-attempt on a freshly-opened stream
  (we see `protocol-client dial:ok` events between retry and error
  log lines).
- `cluster-tx:retry-scheduled` × 50 — scheduled retries also fire
  repeatedly and also fail (50 scheduled = ~5 attempts × ~10 failing
  peers across 12 broadcasts).
- `protocol-client dial:ok` × 1223, `dial:fail` × 215 — **~15 %
  dial-failure rate** is the underlying transport-layer instability
  the ticket's design assumes a future read-repair path will mask.

The pattern in the failing specs is identical to the source-ticket
description: tab B's poll-based message refresh
(`messages.svelte.ts`, 4 s cadence) never observes the row tab A
just wrote, because tab B's peer never receives a merged commit
record it can verify locally.

## Honest assessment of the regression

Baseline (per `tickets/complete/web-e2e-tier2-cluster-supermajority.md`):
**3 of 16 Tier 2 spec runs flake** with this same
`cluster-tx:consensus-broadcast-error` event.

After this ticket: **3 of 3 of the historically-flaky specs fail
deterministically** in back-to-back runs.

The root cause is the same transport-layer instability that produced
the original flake; the ticket's design choice to **shorten the total
retry budget from 60 s to 7.75 s** removed the safety net that was
catching the recoveries-after-15 s that flaked before. The in-line
retry the ticket also added — intended as the primary fix for
"transient stream errors against peers that just completed a
successful `:commit-response`" — does not help here because the
failures aren't transient in the back-to-back-ms sense; they survive
a fresh dial.

The ticket explicitly anticipates this outcome:

> If the e2e is still red after this ticket, follow up with the
> read-repair / relay-reservation tickets — capture findings in the
> review-stage handoff.

So the implementation is **complete per spec**, and the e2e
regression is **expected per the design tradeoff**, but the design
tradeoff is **not yet validated in practice** because the assumed
fallback paths (peer-side gossip / read-repair / next-write) don't
exist in the current code.

## Recommended follow-up work for the reviewer

Three follow-up tickets the source ticket flagged as deferred:

1. **Coordinator-driven read repair** — on read, the peer should query
   the coordinator (or any other peer in the cluster) for the latest
   merged record for any block it has a stale view of. Without this,
   peers that missed the broadcast have **no path** to catch up
   before the next write touches the block.
2. **Circuit-relay reservation lifetime (browser side)** — the high
   `dial:fail` rate (~15 % in this run) suggests relay reservations
   are expiring or being torn down. This is the layer below
   ClusterCoordinator and is the real source of the persistent
   per-peer broadcast errors.
3. **Connection caching across ClusterCoordinator phases** — the
   in-line retry currently opens a fresh stream against the same
   libp2p connection. If the connection itself is the broken piece,
   reusing a *prior-phase-validated* connection (the one that just
   acknowledged the commit successfully a few ms earlier) might
   recover where opening a new stream does not.

Independent observation from the source ticket, still valid:
one prior run failed at tab A's **local** optimistic write, which
doesn't touch the network. That points at a `MessageApp` / Svelte
reactivity race in `messages.svelte.ts:117–132` (`addMessage`),
not at consensus broadcast — separate fix ticket if it recurs.

## Reviewer checklist (suggested)

- Reproduce the run by running the 3 historically-flaky specs with
  `OPTIMYSTIC_E2E_DEBUG=1`; confirm `cluster-tx:consensus-broadcast-retry`
  fires (proves the new helper is on the hot path).
- Decide whether to **keep 250 ms initial** (matches ticket design,
  trusts not-yet-existing read-repair to take over) or **revert to
  2000 ms initial** (preserves 60 s safety net, accepts a slower
  recovery on transient stream errors).
- If keeping 250 ms, file the three follow-up tickets above —
  none of them is in this ticket's scope.
- If reverting to 2000 ms initial, the in-line retry helper alone
  is the salvageable piece; the config knobs and reduced cap should
  also revert.
- Spot-check the new unit specs against the helper's actual call
  pattern (search the test file for `failOnCommitCall = 2` —
  that's the recover-on-retry case).

## Use cases worth exercising

- **Recover-on-retry**: `failOnCommitCall = 2` on one peer; final
  record.commits must include all 3 peers; no scheduled timer set.
- **All-broadcast-attempts-fail**: `failCommit = true` on one peer;
  `updateCalls === 4`; scheduled retry queued at `intervalMs === 250`.
- **Custom config**: `commitBroadcastImmediateRetries = 2` produces
  3 broadcast attempts per peer (5 total `updateCalls` on a failing
  peer); `commitBroadcastRetryInitialMs = 100` is honored.
- **No regression on happy path**: the
  `completes without retry when all peers commit` spec still expects
  `updateCalls === 3` (1 promise + 1 commit + 1 broadcast) per peer.

## End
