---
description: Cross-tab convergence fails because committed blocks are under-replicated. A cluster member that reaches commit-consensus without having seen the matching pend (cohort drift between the independent pend and commit cluster-transactions) tolerates the divergence (post stream-reset fix) but never applies or fetches the committed block, leaving it stale-but-present. Lazy read-repair cannot recover it because no reachable peer holds the newer rev. Fix: active reconciliation in ClusterMember — when it tolerates a divergent commit it pulls the committed revision from a cohort peer and restores it locally — plus switch the propagate-vs-tolerate split to key off CommitResult (missing ⇒ divergence/reconcile; bare reason ⇒ genuine failure ⇒ propagate) instead of throw-vs-return.
prereq: web-e2e-tier2-cluster-tx-stream-reset-rootcause
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/sync/client.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-p2p/src/testing/mesh-harness.ts, ../optimystic/packages/db-p2p/test/cluster-consensus-divergence.spec.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts
---

## Problem (confirmed)

The prereq (`web-e2e-tier2-cluster-tx-stream-reset-rootcause`, now in complete/)
stopped `ClusterMember.handleConsensus` from **throwing** when a member reaches
consensus on a commit/pend it cannot apply locally. Writes now succeed, but the
three multi-tab e2e specs still fail on **convergence**: tab B never sees tab A's
freshly-committed row within the budget.

Root cause is **under-replication**, not transport:

- `CoordinatorRepo.pend` and `CoordinatorRepo.commit` are **independent cluster
  transactions** — each calls `coordinator.executeClusterTransaction` →
  `getClusterForBlock` → `keyNetwork.findCluster(blockId)` *freshly*
  (`coordinator-repo.ts:327-370` / `:402-448`, `cluster-coordinator.ts:87-98`,
  `:133-205`). The cohort selected for the commit need not equal the cohort that
  ran the pend.
- In production the cohort drifts: `findCluster` (`libp2p-key-network.ts:466-520`)
  assembles a FRET-keyspace cohort and **always includes `self`**, and browser-tab
  peer-ids are never pruned from the service peers' FRET keyspace for the mesh
  lifetime. So ~25–36% of member consensus-executions land on a member that is in
  the **commit** cohort but missed the **pend** — the
  `cluster-member:consensus-*-diverged` logs from the debug run.
- Post-prereq-fix that member **tolerates** the miss in
  `ClusterMember.applyConsensusOperation` (`cluster-repo.ts:731-780`): the `commit`
  branch swallows the thrown "Pending action … not found" via
  `isMissingPendingActionError`, logs `consensus-commit-diverged`, and **returns
  without applying**. The block is left absent/stale on that member.
- Cross-tab reads then go through `CoordinatorRepo.get` (`coordinator-repo.ts:170-224`).
  The legacy "missing ⇒ cluster-fetch" trigger never fires (`get:missing` = 0 — the
  index/log block is *present* at an older rev, not absent). Lazy read-repair
  (`shouldReadRepair` / `fetchBlockFromCluster`, `:226-292`) can fire, but
  `cluster-fetch:synced` = 0 because **no reachable peer holds the newer rev**
  (the only "replicas" that got it are the coordinator and an ephemeral browser
  tab whose storage no other tab can read).

### Reproduced (unit level, this run)

A standalone spec driving a real `ClusterMember` + real `StorageRepo` to
commit-consensus for an action it never pended confirms the gap: after
`member.update(record)`, `wasTransactionExecuted` is `true` but
`storage.get({blockIds:['block-1']}).state.latest` is **`undefined`** — the
member reached consensus yet holds no revision of the block. (Temp repro removed;
the durable version is the regression test below.) This is the under-replication
the e2e specs trip over once tab B's cohort for the index block excludes every
peer that actually committed it.

## Fix design (recommended)

### Primary: active reconciliation in `ClusterMember`

When a member tolerates a **divergent commit because it is behind** (missing
pend ⇒ today the thrown "not found"; equivalently a future `CommitResult` with
`missing` populated), it must **actively fetch the committed revision from a
cohort peer that holds it and restore it locally**, instead of only logging and
deferring to a read-repair that has nothing to pull from.

All the pieces already exist and are reused, not invented:

- The committed `(actionId, rev, blockIds)` are on the operation
  (`operation.commit`).
- The cohort peer-ids are in `record.peers` (exclude `self`).
- The production fetch+restore pattern already lives in
  `libp2p-node-base.ts:413-443` (the `clusterLatestCallback`): a `SyncClient`
  (`sync/client.ts`) pulls the block archive from a peer, and
  `storageRepo.get({ blockIds:[id], context:{ committed:[rev], rev } })` triggers
  the restore/promotion path in `storage-repo.ts:84-153`.

**Keep `ClusterMember` transport-agnostic** by injecting a reconciliation
callback (mirroring how `CoordinatorRepo` receives `clusterLatestCallback`)
rather than constructing `SyncClient` inside `ClusterMember` — this keeps the
existing `cluster-consensus-divergence.spec.ts` (which uses a `MockPeerNetwork`
returning `{}`) and the new regression test able to stub reconciliation with a
sibling node's storage.

Suggested shape (final naming at implementer's discretion):

```
// New optional component on ClusterMemberComponents
reconcileBlock?: (blockId: BlockId, committed: ActionRev, cohortPeerIds: string[]) => Promise<void>;
```

- Wired in `libp2p-node-base.ts` next to `clusterLatestCallback`: query the
  given cohort peers (excluding self) via `SyncClient.requestBlock`, pick the
  max rev ≥ `committed.rev`, then `storageRepo.get({ blockIds:[blockId],
  context:{ committed:[latest], rev: latest.rev } })` to restore locally.
  (Largely a refactor/extraction of the existing `clusterLatestCallback` +
  `CoordinatorRepo.fetchBlockFromCluster` logic so it can be shared.)
- Invoked from `applyConsensusOperation` after a divergent **commit** is
  tolerated (the "behind"/`missing` case only — NOT the "ahead"/stale case,
  where the member already has a newer rev). Fire it such that a failure to
  reconcile is itself tolerated/logged (never re-throw — that reintroduces the
  stream reset the prereq removed). Reconciliation may run as an awaited step or
  scheduled microtask; if awaited, guard with a short timeout so a slow/unreachable
  cohort peer can't stall consensus.

### Also: classify divergence off `CommitResult`, not throw-vs-return

(Carried over from the prereq review — see complete/ ticket "Review findings".)
In `applyConsensusOperation`'s `commit` branch, the propagate-vs-tolerate
decision currently keys off **throw vs return**: a thrown "pending action not
found" is tolerated, but a genuine `internalCommit` fault that surfaces as
`CommitResult { success:false, reason }` (no `missing`) is *also* silently
tolerated. `CommitResult` already distinguishes the cases
(`storage-repo.ts:350-356` returns `missing` for stale/ahead divergence;
`:404` returns a bare `reason` for a genuine mid-commit fault). Switch the logic
to:

- `result.missing` present (or thrown "pending action not found") ⇒ divergence
  ⇒ tolerate **and trigger reconciliation** (behind) / no-op (ahead).
- bare `result.reason`, no `missing` ⇒ genuine failure ⇒ **propagate** (let
  `handleConsensus` roll back the executed marker and rethrow, exactly as the
  unexpected-fault path does today).

Keep the thrown-error classifier (`isMissingPendingActionError`) as the "behind"
signal until/unless `StorageRepo.commit` is changed to return rather than throw;
do not widen it.

### Secondary / conditional (only if reconciliation alone misses 16/16)

These address root-cause #2/#3 and are documented as escalation, not committed
work. Add them — or spin them into their own fix ticket — only if, after the
primary fix, the e2e sweep still does not reach 16/16 and traces show the
remaining gap is cohort drift rather than reconciliation:

- **Pin the cohort across pend→commit** so the same members handle both phases
  (deterministic `findCluster` membership for a given block id across the
  pend→commit window, robust to transient browser-tab churn). Reduces divergence
  at the source. Larger/riskier change to `findCluster`/coordinator.
- **Exclude ephemeral/browser peers from durable replica counting**, and/or evict
  disconnected browser-tab peer-ids on per-spec teardown
  (`packages/reference-app-web/e2e/distributed/_helpers.ts`).
- **Read-repair tuning** for the multi-tab read path (window/sample) so a
  present-but-stale index block refreshes within the test budget — only useful
  once a peer actually holds the newer rev (i.e. after reconciliation lands).

## Regression coverage (acceptance)

Agent-runnable proof lives at the `db-p2p` level (the e2e sweep is browser-driven
and not reliably agent-runnable — see "Validation" below):

- Extend `test/cluster-consensus-divergence.spec.ts` (or a sibling spec): drive a
  `ClusterMember` to commit-consensus for an action it never pended, with a stub
  `reconcileBlock` that serves the block from a sibling store, and assert the
  member **holds the committed rev** afterward (the failing-first assertion is the
  repro above: `latest?.rev === 1`). Add a companion asserting the "ahead"/stale
  case does **not** spuriously reconcile downward, and that a genuine
  `CommitResult { success:false, reason }` (no `missing`) still **propagates**.
- Extend `test/coordinator-repo-integration.spec.ts` using `createMesh`
  (`src/testing/mesh-harness.ts`): construct a cross-cohort pend→commit (e.g.
  toggle `mesh.failures.failingPeers` between the pend and commit phases, or vary
  `responsibilityK`, so a member lands in the commit cohort having missed the
  pend) and assert that member ends up holding the committed revision — i.e.
  replication is restored and a cross-cohort transaction converges. The harness's
  `clusterLatestCallback` already simulates SyncClient data-sync
  (`mesh-harness.ts:192-219`); add the analogous `reconcileBlock` wiring there.

## Provenance note

Per the prereq's complete/ ticket: the actual code lives in the **sibling
`../optimystic` working tree** (uncommitted there). The tess runner commits only
sereus (ticket-file moves). Build the `@optimystic/db-p2p` dist from source so
the linked `resolutions` pick it up.

## TODO

### Phase 1 — primary fix (required)
- [ ] Add a `reconcileBlock`-style optional component to `ClusterMemberComponents`
      + `clusterMember(...)` factory + constructor in `cluster-repo.ts`.
- [ ] In `applyConsensusOperation`'s `commit` branch, switch propagate-vs-tolerate
      to key off `CommitResult` (`missing` ⇒ divergence; bare `reason` ⇒ propagate),
      keeping the thrown-"not found" classifier as the behind signal.
- [ ] On a tolerated **behind** divergence (missing pend), invoke `reconcileBlock`
      for the committed `(blockId, actionId, rev)` against `record.peers` (minus
      self). Tolerate/log reconcile failures; never re-throw (no stream reset).
      Guard any awaited reconcile with a short timeout.
- [ ] Wire `reconcileBlock` in `libp2p-node-base.ts` by extracting/sharing the
      existing `SyncClient` fetch + `storageRepo.get(context:{committed})` restore
      logic (currently in `clusterLatestCallback` / `CoordinatorRepo.fetchBlockFromCluster`).
- [ ] Wire the same callback into `src/testing/mesh-harness.ts` (analogous to its
      existing `clusterLatestCallback` data-sync simulation).

### Phase 2 — regression tests (required)
- [ ] Divergence-spec: member-behind reconciles and holds the committed rev;
      member-ahead does not reconcile down; genuine `success:false`+`reason`
      (no `missing`) still propagates (executed-marker rolled back).
- [ ] Mesh integration spec: cross-cohort pend→commit converges and the
      pend-missing member ends up holding the committed revision.

### Phase 3 — validate
- [ ] `yarn workspace @optimystic/db-p2p build` (tsc exit 0).
- [ ] `yarn workspace @optimystic/db-p2p test` (full suite green; stream-output
      with `2>&1 | tee` — the suite is ~500 tests). Confirm failing-first on the
      new assertions by stashing the `cluster-repo.ts` change.
- [ ] Rebuild the `@optimystic/db-p2p` dist from source so sereus `resolutions`
      pick up the fix.

### Phase 4 — e2e (NOT reliably agent-runnable; run via human/CI, document result)
- [ ] `OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`
      (single worker). Target: Tier-2 16/16 with `cross-tab-activity`,
      `disconnect-mid-session`, `two-tab-convergence` green, stable across repeats.
      If still short, escalate to the Phase-secondary directions above (and split
      into a follow-up fix ticket if cohort-pinning is required).
- [ ] If the e2e surfaces a failure outside this diff, write
      `tickets/.pre-existing-error.md` per the workflow rules rather than chasing it.

## References
- Root-cause prereq: `tickets/complete/2-web-e2e-tier2-cluster-tx-stream-reset-rootcause.md`
- Tolerate-don't-throw guard + CAVEAT: `cluster-repo.ts:696-780`
- Existing fetch+restore pattern to share: `libp2p-node-base.ts:413-443`,
  `coordinator-repo.ts:264-325`
- Restore trigger via context: `storage-repo.ts:84-153`
- Sync protocol: `sync/client.ts`, `sync/protocol.ts`, `sync/service.ts`
- Mesh harness: `src/testing/mesh-harness.ts`
