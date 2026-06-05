---
description: COMPLETE — Active reconciliation in ClusterMember for committed-but-under-replicated blocks. A member that reaches commit-consensus without the matching pend (cohort drift) now (a) classifies propagate-vs-tolerate off CommitResult (missing-pend throw or `success:false`+`missing` ⇒ divergence/tolerate; bare `reason` ⇒ genuine fault/propagate) and (b) on a "behind" divergence actively pulls the committed revision from a cohort peer and restores it locally via an injected, awaited, timeout-bounded, never-rethrowing `reconcileBlock` callback. Wired in libp2p-node-base (SyncClient fetch + saveReplicatedBlock) and mesh-harness. Reviewed: build clean (tsc exit 0), full db-p2p suite 507 passing / 9 pending / 0 failing (added 1 safety-invariant test for swallowed reconcile failures). E2E Phase 4 deferred to human/CI (not agent-runnable).
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/testing/mesh-harness.ts, ../optimystic/packages/db-p2p/test/cluster-consensus-divergence.spec.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-integration.spec.ts, ../optimystic/docs/internals.md, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-p2p/src/storage/block-storage.ts, ../optimystic/packages/db-p2p/src/sync/client.ts
---

## What shipped

Active reconciliation plus the CommitResult-based propagate-vs-tolerate split for
`ClusterMember`'s consensus-execution commit branch. See the implement-stage
handoff (commit `9d526c1`) for the full design narrative. Net behavior:

- **behind** (missing-pend throw, `isMissingPendingActionError`) ⇒ tolerate **and
  actively reconcile** — pull the committed rev from a cohort peer (self excluded)
  via the injected `reconcileBlock` callback and `saveReplicatedBlock` it locally.
- **ahead/stale** (`success:false` with `missing`) ⇒ tolerate, **no reconcile**
  (member already holds ≥ the rev; never reconcile downward — monotonic).
- **genuine fault** (`success:false` with bare `reason`, no `missing`) ⇒ **propagate**
  so `handleConsensus` rolls back the executed marker and rethrows.
- Reconciliation is awaited but bounded (`ReconcileTimeoutMs = 5000`); every
  per-block failure/timeout is logged and **swallowed** — a throw here would
  reintroduce the cluster-stream reset the prereq removed.

Wired transport-agnostically: `reconcileBlock` is an optional, last-positional
component (existing call sites untouched), implemented in `libp2p-node-base`
(parallel `SyncClient.requestBlock` over the commit cohort, highest archive rev
≥ committed.rev, persisted through the churn-replication funnel) and in
`mesh-harness` (sibling-store read + `saveReplicatedBlock`).

## Review findings

### Reviewed (read every touched file + the source it depends on)
- **`cluster-repo.ts` diff** — the CommitResult split, `reconcileDivergentCommit`,
  `reconcileOneBlock`, `withReconcileTimeout`, the `ReconcileBlockCallback` type and
  component wiring.
- **`storage-repo.ts` `commit()`** (read independently) to confirm the
  classification matches the real producer of `CommitResult`:
  - `missedCommits` (already-committed newer rev, different actionId) ⇒ returns
    `{success:false, missing}` ⇒ correctly classified **ahead/tolerate**.
  - `missingPends` ⇒ **throws** "Pending action … not found" ⇒ correctly the
    **behind/reconcile** signal.
  - mid-loop `internalCommit` fault ⇒ returns `{success:false, reason}` (no
    `missing`) ⇒ correctly **propagated**. The split is sound against the only
    in-repo `IRepo` implementation.
- **`block-storage.ts` `saveReplica()`** — confirmed the monotonic guard
  (`meta.latest.rev >= rev` ⇒ skip) makes reconciling an already-held or
  already-ahead block a safe no-op, so iterating *all* `commit.blockIds` (rather
  than only the specifically-diverged ones, which the thrown error does not
  enumerate) is conservative and correct.
- **`handleConsensus`** — confirmed it deletes the executed marker and rethrows on
  any propagated throw, so the new bare-reason throw behaves exactly like a thrown
  storage fault (matches the "propagates" test).
- **`libp2p-node-base.ts` wiring** — `fetchArchiveFromPeer` (per-peer 1s timeout,
  self-skip), highest-rev selection ≥ committed, `saveReplicatedBlock` persistence.
- **`mesh-harness.ts` wiring** — sibling-store analogue.
- **`docs/internals.md`** — re-read the "Consensus Execution" section; it now
  accurately describes the CommitResult split, active reconciliation, the
  best-effort/bounded contract, and the no-downward-reconcile rule. Docs reflect
  the new reality.

### Found & fixed in this pass (minor)
- **Missing coverage of the core safety invariant.** The implementer's 4 new tests
  covered behind-reconciles, ahead-no-downgrade, bare-reason-propagates, and
  cross-cohort mesh convergence — but **not** the single most load-bearing
  guarantee: that a `reconcileBlock` callback which *throws* (or times out) is
  swallowed and does **not** reset the stream. Added
  `tolerates a reconcile callback that throws (best-effort: never resets the
  stream)` to `cluster-consensus-divergence.spec.ts`: a behind member with a
  throwing reconcile callback ⇒ `member.update` does not throw, the txn is still
  marked executed, the callback fired once, and the block remains
  under-replicated (no false durability claim). Suite now **507 passing**.

### Found, judged acceptable (no change)
- **`mesh-harness.ts` `{ skipClusterFetch: true } as any`** on the sibling
  `storageRepo.get` — `StorageRepo.get` ignores its options arg entirely, so the
  cast is a redundant no-op, but it mirrors the established in-repo pattern
  (`coordinator-repo.ts` reads the flag via `(options as any)`, `service.ts` /
  `sync/service.ts` / the pre-existing `mesh-harness.ts:217` all pass it the same
  way). Left for consistency rather than diverging one call site.
- **`stateStore.markExecuted` is not unmarked when `handleConsensus` rolls back.**
  Pre-existing for *every* propagated throw (e.g. the already-shipped "unexpected
  storage fault" path); the new bare-reason propagate inherits it identically, so
  it is not a regression. Out of scope here.
- **`.unref()` on the reconcile timer is unguarded** — matches the pre-existing
  `setTimeout(...).unref()` pattern throughout `cluster-repo.ts`; a browser
  `ClusterMember` would already throw on the constructor timers. Out of scope.
- **String-matching error classifier (`isMissingPendingActionError`)** unchanged;
  fails safe (a wording change makes the error propagate, never silently swallow).

### Verified, no issue
- **No deadlock on the awaited reconcile.** No storage lock is held across the
  reconcile await (the commit critical section's latches release before the catch
  block runs; the cohort peer serves the sync request on a separate handler).
- **Latency bound** — the 5s cap applies only on the behind-divergence path; zero
  added latency on the common path. `broadcastMergedRecord` awaits members via
  `Promise.all`, so the commit waits at most `ReconcileTimeoutMs` on the slowest
  diverged member. Sane.
- **Cohort derivation** — `Object.keys(record.peers)` minus self; the
  "behind reconciles" test asserts the observed cohort includes the peer and
  excludes self.
- **Build:** `yarn workspace @optimystic/db-p2p build` (tsc) — exit 0, clean.
  Optimystic has no real ESLint configured (`"lint": "echo …"`), so tsc is the
  type/lint gate; it passes.
- **dist:** rebuilt from source (reconcile symbols present in
  `dist/src/cluster/cluster-repo.js` and `dist/src/libp2p-node-base.js`). The
  review's test-only change does not affect `dist` (tests are not compiled into it).

### Residual limitations (documented, NOT filed as tickets — gated on e2e)
- **Single-transaction-broadcast reconcile race.** In a *single* commit broadcast
  all members execute concurrently, so a behind member can read a cohort peer
  before that peer finishes its own local commit and find nothing; on a lost race
  the reconcile no-ops (logged) and the block stays under-replicated until a later
  read-repair (which now has a better chance, more cohort members holding the rev).
  The mesh test deliberately uses a *two-commit* design to make the source settle
  first. The implementer weighed a bounded reconcile **retry** and chose a single
  attempt for predictable consensus-path latency. **Disposition:** this is the
  ticket's "Secondary / conditional" escalation territory, which is explicitly
  **gated on the Phase-4 e2e result**. Since e2e was not run here, filing a fix
  ticket now would be premature — the human/CI e2e run determines whether
  convergence is actually insufficient. If the Tier-2 16/16 target
  (`cross-tab-activity` / `disconnect-mid-session` / `two-tab-convergence`) is not
  met, open fix ticket(s) for: bounded reconcile retry, pin-cohort-across-pend→commit,
  exclude ephemeral/browser peers from durable replica counting, and read-repair
  window/sample tuning.
- **`saveReplicatedBlock` persists only the materialized latest rev** (range
  `[rev, rev+1]`), not full history. Latest-rev reads converge (the goal); an
  intermediate-rev read falls back to a normal restore. Acceptable for the
  index/log read path.

### NOT run here (deferred per ticket — deferral confirmed acceptable)
- **Phase-4 e2e** (`OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web
  test:e2e`) is browser-driven and long — **not reliably agent-runnable** under the
  10-minute idle timeout. Not run. The agent-runnable proof (db-p2p suite) is green;
  the Tier-2 16/16 target must be confirmed by a human/CI run.

## Provenance — code lives in the sibling `../optimystic` repo (UNCOMMITTED)

The tess runner commits **sereus** (ticket-file moves only). The actual changes —
both the implement-stage source and this review's added test — are in the separate
**optimystic** working tree and must be committed there or they are lost:
- `packages/db-p2p/src/cluster/cluster-repo.ts` (reconcile + CommitResult split)
- `packages/db-p2p/src/libp2p-node-base.ts` (reconcileBlock wiring)
- `packages/db-p2p/src/testing/mesh-harness.ts` (mesh reconcileBlock)
- `packages/db-p2p/test/cluster-consensus-divergence.spec.ts` (+3 implement tests,
  +1 review safety test = 4 new)
- `packages/db-p2p/test/coordinator-repo-integration.spec.ts` (+1 mesh test)
- `docs/internals.md` ("Consensus Execution" updated)
- `@optimystic/db-p2p` dist rebuilt from source (tsc exit 0).

cf. the open `land-orphaned-cluster-error-envelope` backlog item for the same
uncommitted-sibling situation.
