---
description: REVIEW — Active reconciliation in ClusterMember for committed-but-under-replicated blocks. When a member reaches commit-consensus without the matching pend (cohort drift), it now (a) classifies propagate-vs-tolerate off CommitResult (`missing` ⇒ divergence/tolerate; bare `reason` ⇒ genuine fault/propagate) instead of throw-vs-return, and (b) on a "behind" divergence actively pulls the committed revision from a cohort peer and restores it locally via an injected reconcileBlock callback (awaited, timeout-bounded, never re-throws). Wired in libp2p-node-base (SyncClient fetch + saveReplicatedBlock) and mesh-harness. Build clean; full db-p2p suite 506 passing / 9 pending / 0 failing incl. 4 new tests; failing-first confirmed (3 fail on reverted code). E2E (Phase 4) NOT run here — deferred to human/CI per ticket.
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/testing/mesh-harness.ts, ../optimystic/packages/db-p2p/test/cluster-consensus-divergence.spec.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-integration.spec.ts, ../optimystic/docs/internals.md, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-p2p/src/sync/client.ts
---

## What was implemented

The prereq (`web-e2e-tier2-cluster-tx-stream-reset-rootcause`, complete) made
`ClusterMember` *tolerate* a divergent commit (member reaches commit-consensus
without having seen the matching pend) instead of throwing + resetting the
cluster stream. But the tolerated block was left **stale-but-present / absent**,
and lazy read-repair couldn't recover it because no reachable peer held the newer
rev (under-replication from cohort drift between the independent pend and commit
cluster-transactions). This ticket adds **active reconciliation** plus the
**CommitResult-based** propagate-vs-tolerate split the prereq review flagged.

### Change 1 — classify divergence off `CommitResult`, not throw-vs-return
`applyConsensusOperation`'s `commit` branch (`cluster-repo.ts`):
- thrown "Pending action … not found" (via `isMissingPendingActionError`) ⇒
  member is **behind** ⇒ tolerate **and reconcile**.
- `success:false` **with `missing`** ⇒ member is **ahead/stale** ⇒ tolerate, **no
  reconcile** (it already holds ≥ the rev; never reconcile downward).
- `success:false` with a **bare `reason`, no `missing`** ⇒ genuine mid-commit
  `internalCommit` fault ⇒ **propagate** (re-throw) so `handleConsensus` rolls
  back the executed marker and rethrows — same as an unexpected thrown fault.
  (Previously this was silently tolerated — the hole the prereq review noted.)

### Change 2 — active reconciliation (`reconcileBlock` injection)
- New exported `ReconcileBlockCallback` type + optional `reconcileBlock` component
  on `clusterMember(...)` / `ClusterMember` constructor (last positional arg, so
  existing call sites are untouched). Keeps `ClusterMember` transport-agnostic
  (mirrors how `CoordinatorRepo` receives `clusterLatestCallback`).
- On a **behind** divergence, `reconcileDivergentCommit(record, commit)` invokes
  the callback for each `commit.blockId` with `(blockId, {actionId,rev},
  cohortPeerIds)` where `cohortPeerIds = Object.keys(record.peers)` **minus self**.
- Awaited but **bounded** by `withReconcileTimeout` (`ReconcileTimeoutMs = 5000`);
  per-block failures/timeouts are **logged, never thrown**
  (`cluster-member:consensus-commit-reconcile-{reconciled,failed,skip}`). A throw
  here would reintroduce the stream reset the prereq removed.

### Change 3 — wiring
- `libp2p-node-base.ts`: `reconcileBlock` queries the commit cohort (self excluded)
  in parallel via `SyncClient.requestBlock` (per-peer 1s timeout), picks the
  highest archive rev `≥ committed.rev`, and persists the materialized block via
  `storageRepo.saveReplicatedBlock(blockId, block, {actionId, rev})` — the existing
  churn-replication funnel (`StorageRepo.saveReplica`, which self-seeds metadata
  and is monotonic). `fetchArchiveFromPeer` is a small sibling of the existing
  `clusterLatestCallback` SyncClient query (returns the full archive, which carries
  the materialized block, vs. only the latest ActionRev).
- `mesh-harness.ts`: analogous `reconcileBlock` that reads the block from a sibling
  mesh node's `storageRepo` and persists locally via `saveReplicatedBlock` — the
  in-memory analogue of the SyncClient path.

## Validation performed (all green)

- **Build:** `yarn workspace @optimystic/db-p2p build` (tsc) — exit 0, clean
  (re-run after restoring the failing-first revert; still 0).
- **Full suite:** `yarn workspace @optimystic/db-p2p test` —
  **506 passing / 9 pending / 0 failing** (~20s). The +4 vs the prereq's 502
  baseline are the 4 new tests below; no regressions.
- **Failing-first CONFIRMED:** temporarily reverted only the `cluster-repo.ts`
  commit-branch to the old tolerate-all/no-reconcile behavior → **3 of the 4 new
  tests fail** (the "behind reconciles", "bare-reason propagates", and mesh
  cross-cohort tests). The "ahead does not reconcile down" test passes either way
  by design (it asserts *no* reconcile). Restored after.
- **Dist rebuilt** from source so sereus `link:../optimystic/packages/db-p2p`
  (→ `dist/src`) picks up the fix; verified `reconcile*` symbols present in
  `dist/src/cluster/cluster-repo.js` and `dist/src/libp2p-node-base.js`.

## New regression tests (the floor — extend as you see fit)

`test/cluster-consensus-divergence.spec.ts` (drives a real `ClusterMember` +
real `StorageRepo`):
- **behind reconciles**: commit-consensus for an unpended action with a stub
  `reconcileBlock` serving from a sibling store → asserts member ends holding
  `latest.rev === 1` (was `undefined`), `reconcileCalls === 1`, and the observed
  cohort **includes `other`, excludes `self`**.
- **ahead does not reconcile down**: local rev 2, stale commit rev 1 →
  `reconcileCalls === 0`, local rev unchanged (2).
- **bare-reason propagates**: a repo whose `commit` returns
  `{success:false, reason}` (no `missing`, no throw) → `member.update` throws,
  executed-marker rolled back, `reconcileCalls === 0`.

`test/coordinator-repo-integration.spec.ts` (mesh harness, `createMesh(3, K=3)`):
- **cross-cohort convergence**: laggard unreachable during a full pend+commit
  (nodes 0/1 stably commit rev 1), then re-commit the same `(actionId, rev)` with
  the laggard reachable → laggard tolerates the divergence and reconciles, ending
  with `latest.rev === 1, actionId === 'a-xc'`.

## For the reviewer — suggested adversarial angles & KNOWN GAPS

Treat the tests as a floor. Specific things worth poking at:

1. **Single-transaction broadcast race (production timing, NOT covered by tests).**
   The mesh test deliberately uses a *two-commit* design: in a single commit
   broadcast, all members (including the behind one) execute **concurrently**, so
   the behind member's reconcile can read a cohort peer *before* that peer has
   finished its own local commit, finding nothing. The two-commit test sidesteps
   this by settling nodes 0/1 first. In production the reconcile is a `SyncClient`
   round-trip (≥ ms of dial/RTT) while peers commit locally (fast), so the peer
   has almost always committed by the time it serves the sync request — but it is
   **not guaranteed**. On a lost race the reconcile no-ops (logged) and the block
   stays under-replicated until a later read-repair (which now has a *better*
   chance, since more cohort members hold the rev). Consider whether a bounded
   reconcile **retry** (still within `ReconcileTimeoutMs`) is worth adding; I left
   it as a single attempt to keep the consensus-path latency predictable.

2. **`saveReplicatedBlock` persists only the materialized latest rev**, not the
   full revision history (it writes range `[rev, rev+1]`). Reads of the latest rev
   converge (the goal); a later read of an *intermediate* rev would attempt a
   normal restore. Confirm that's acceptable for the index/log block read path.

3. **Awaited reconcile extends commit latency on the divergence path** (bounded by
   `ReconcileTimeoutMs = 5000`, only when a member is behind; zero added latency on
   the common path). `broadcastMergedRecord` awaits member `update()` via
   `Promise.all`, so the coordinator's commit waits for the slowest member's
   reconcile. Verify 5s is a sane cap; check there's no deadlock (there isn't —
   no storage lock is held across the reconcile await; the cohort peer serves the
   sync request on a separate stream/handler).

4. **`.unref()` on the timeout timer is unguarded**, matching the pre-existing
   `setTimeout/​setInterval(...).unref()` pattern throughout `cluster-repo.ts`. If
   `ClusterMember` is ever instantiated in a browser context (where `setTimeout`
   returns a number with no `.unref`), this — like the existing constructor timers
   — would throw; out of scope here, flagged for awareness.

5. **String-matching error classifier (`isMissingPendingActionError`)** is
   unchanged and still the "behind" signal; it fails safe (a wording change makes
   the error propagate, not silently swallow). Same caveat the prereq review noted.

## NOT done here (deferred per ticket — verify the deferral is acceptable)

- **Phase 4 e2e (`OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web
  test:e2e`)** is **NOT reliably agent-runnable** (browser-driven, long) and was
  **not run**. The agent-runnable proof (db-p2p suite) is green; the Tier-2 16/16
  target across `cross-tab-activity` / `disconnect-mid-session` /
  `two-tab-convergence` must be confirmed by a human/CI run. If e2e still falls
  short, the ticket's **"Secondary / conditional"** escalations remain open and
  should become their own fix ticket(s): pin the cohort across pend→commit,
  exclude ephemeral/browser peers from durable replica counting, and read-repair
  window/sample tuning.

## Provenance — code lives in the sibling `../optimystic` repo (UNCOMMITTED)

The tess runner commits **sereus** (ticket-file moves only). The actual changes
are in the separate **optimystic** working tree and must be committed there or the
fix is lost:
- `packages/db-p2p/src/cluster/cluster-repo.ts` (reconcile + CommitResult split)
- `packages/db-p2p/src/libp2p-node-base.ts` (reconcileBlock wiring)
- `packages/db-p2p/src/testing/mesh-harness.ts` (mesh reconcileBlock)
- `packages/db-p2p/test/cluster-consensus-divergence.spec.ts` (+3 tests)
- `packages/db-p2p/test/coordinator-repo-integration.spec.ts` (+1 test)
- `docs/internals.md` ("Consensus Execution" updated)
- `@optimystic/db-p2p` dist rebuilt from source (tsc exit 0).

cf. the open `land-orphaned-cluster-error-envelope` backlog item for the same
uncommitted-sibling situation.
