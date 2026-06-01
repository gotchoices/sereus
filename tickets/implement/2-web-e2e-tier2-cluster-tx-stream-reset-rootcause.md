---
description: With the cluster-tx error now surfaced as a real message (see prereq), fix the underlying `ClusterMember.update` throw that resets the stream during 2-phase commit under the sequential Tier-2 e2e sweep, so `cross-tab-activity`, `disconnect-mid-session`, and `two-tab-convergence` pass alongside the other 13 specs. The throw is state-dependent: it appears only after several specs have run against the shared 3-service-peer fixture and never in isolation, which points at accumulated in-memory transaction/keyspace state on the cluster members rather than a transport fault.
prereq: web-e2e-tier2-cluster-tx-error-surface
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/cluster/client.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/_helpers.ts
---

## Background

This is the root-cause half of `web-e2e-tier2-cluster-tx-stream-reset`. The
prereq (`web-e2e-tier2-cluster-tx-error-surface`) removed the masking layers:
the cluster service now returns a structured error instead of aborting the
stream, the dead `/db-p2p/cluster/1.0.0` fallback is gone, and the spawned
service peers log to the Playwright stdout. So the coordinator's
`cluster-tx:promise-response` / `consensus-broadcast-error` lines now carry
the **real** server-side reason instead of an opaque `StreamResetError`.

Topology recap (established during the fix investigation): the **browser tab
is the coordinator**, running the 2-phase commit against the three
service-peer cluster members over **direct ws** dials (not relayed). A member
resets the stream because `ClusterMember.processUpdate`
(`cluster/cluster-repo.ts:169-333`) threw. The failure is load- and
order-dependent: it surfaces only after several specs have run against the
shared fixture (`global-setup.ts` spawns the mesh once and reuses it), and
each spec adds a fresh pair of browser-tab peer-ids that are never pruned
from the service peers' peerStore / FRET keyspace for the mesh lifetime.

## Where the throw most likely lives (confirm against the real message first)

`processUpdate` and its validation helpers have several throw sites. In
priority order, weighted by "explains state-accumulation across specs":

  1. **`mergeRecords` field-mismatch throws** (`cluster-repo.ts:339-356`):
     `'Peers mismatch'`, `'Message content mismatch'`, `'Message hash
     mismatch'`. A member keys `activeTransactions` by `messageHash`. If a
     stale entry from an earlier spec collides with a new transaction — or if
     the coordinator's `findCluster` returns a *different* `peers` set across
     phases of the same transaction because the keyspace drifted mid-flight —
     the merge throws and the stream resets. `getClusterForBlock`
     (`repo/cluster-coordinator.ts:87-98`) is called once per
     `executeClusterTransaction`, so within one coordinator the `peers` set
     is stable; cross-spec keyspace drift between *different* browser
     coordinators transacting overlapping block ids is the suspect.

  2. **Accumulated `activeTransactions` / `executedTransactions` /
     `pendingUpdates` maps** (`cluster-repo.ts:78-84`). Entries are cleaned
     on a 1 s `cleanupInterval` and a 10-min executed-TTL, and
     `pendingUpdates` serializes same-hash updates with a 100 ms delete
     delay. Check for a stale-entry path where a late retry
     (`scheduleCommitRetry`, `repo/cluster-coordinator.ts:624-709`, backoff
     up to 8 s × 5 attempts) for a *prior* spec's transaction lands after the
     member cleared/expired it and re-enters a phase that throws.

  3. **`validateSignatures`** (`cluster-repo.ts:442+`) — a signature that
     fails to verify after a cross-spec key/peerStore change. Lower
     likelihood (signatures travel inside the record) but the real message
     will say so directly.

  4. **`handleConsensus` execution against `storageRepo`** — if executing the
     transform throws on already-applied/conflicting block state when a
     duplicate broadcast/retry arrives. The `wasTransactionExecutedAsync`
     dedup (`cluster-repo.ts:258,270`) should guard this; verify it holds
     across the executed-TTL window and post-cleanup.

### Secondary mechanisms to keep in view

  - **`maxInboundStreams: 32` on the cluster service** (`cluster/service.ts:59`).
    Streams are short-lived (request/response, both sides close), so 32
    concurrent inbound cluster streams on one ws connection is unlikely with
    a 3-peer cluster — but background retry timers from several specs firing
    concurrently could spike it. If the real "error" turns out to be a
    muxer-level reset with *no* `db-p2p:cluster` handler log on the service
    side, this (or yamux per-stream window backpressure, hypothesis #2) is
    the surface, not an application throw. Disambiguate using the prereq's
    service-peer logs: handler-log present ⇒ application throw (cases 1-4);
    absent ⇒ muxer/flow-control.

  - **Per-spec teardown does not evict browser-tab peer-ids from the service
    peers** (hypothesis #3). If keyspace drift (case 1) is confirmed,
    consider having teardown signal the service peers to drop the
    disconnected tab peer-ids, or making the coordinator's `findCluster`
    membership deterministic/stable for a given block id regardless of
    transient browser-tab churn.

## Acceptance

  - Full Tier-2 sweep passes **16/16 consistently across 3 consecutive
    runs** (`OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`,
    single worker).
  - `StreamResetError` is no longer observed in the e2e capture for
    `cross-tab-activity`, `disconnect-mid-session`, `two-tab-convergence`.
  - The fix is targeted at the confirmed throw site — not a blanket
    swallow-the-error in `ClusterMember`. Any newly-tolerated condition is
    justified in a code comment.
  - `@optimystic/db-p2p` build + tests pass; new regression coverage for the
    accumulated-state condition (prefer a `mesh-harness`-based or
    `cluster-repo`-level unit test over relying on the browser e2e) is added.

## TODO

### Phase 1 — pin the real cause
- [ ] Rebuild optimystic dist (`yarn workspace @optimystic/db-p2p build &&
      yarn workspace @optimystic/reference-peer build`) so the e2e fixture
      runs the prereq's changes.
- [ ] Run the full sweep streaming output:
      `OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e 2>&1 | tee /tmp/e2e-sweep.log`.
      If the browser-driven sweep is too heavy/flaky to run here, reproduce
      the accumulated-state condition with a `db-p2p` `mesh-harness` test
      that runs several sequential transactions over a reused 3-member mesh
      while injecting fresh transient peer-ids between rounds.
- [ ] Read the now-meaningful error from the coordinator
      (`cluster-tx:promise-response` / `consensus-broadcast-error`) and the
      service-peer `db-p2p:cluster` handler log; identify the exact throw
      site among cases 1-4 (or confirm a muxer-level reset).

### Phase 2 — fix
- [ ] Correct the confirmed throw site. If keyspace drift (case 1): make
      cluster membership for a given block id stable across a transaction's
      phases and tolerant of transient browser-tab churn, and/or fix the
      stale-`activeTransactions` collision. If a late-retry re-entry
      (case 2): ensure expired/cleared transactions are handled idempotently
      rather than throwing.
- [ ] If disambiguation shows a muxer/flow-control reset instead: address
      hypothesis #2 (yamux window / `maxInboundStreams` headroom) and/or
      per-spec peer-id eviction (hypothesis #3) in `_helpers.ts` teardown.

### Phase 3 — regression coverage + validate
- [ ] Add a `db-p2p` test reproducing the accumulated-state failure and
      asserting it no longer throws.
- [ ] `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`.
- [ ] Re-run the full Tier-2 sweep 3× to confirm 16/16 stability
      (stream each run's output via `tee`). If a single sweep's wall-clock
      routinely exceeds ~10 min, run one sweep here to confirm green and
      hand the 3× stability confirmation to CI, documenting the deferral.
