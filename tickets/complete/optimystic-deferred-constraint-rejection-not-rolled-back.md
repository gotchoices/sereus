description: Deferred-constraint atomicity fix for the optimystic vtab transactor. DML now STAGES into the collection tracker at DML time and flushes to storage only at commit, restoring a pre-stage snapshot on rollback. A deferred (subquery-bearing) CHECK that throws at commit now leaves the violating row absent (in-session AND after reopen). Reviewed, validated, and accepted with two minor in-pass fixes.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts, ../optimystic/packages/quereus-plugin-optimystic/test/deferred-constraint-rollback.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts
----

# Deferred-constraint rejection now rolls back atomically (COMPLETE)

Implemented under `tickets/implement/optimystic-deferred-constraint-rejection-not-rolled-back.md`
(sereus commit `b9da849`) and reviewed here.

## What the change does

`Tree.replace()` used to fuse stage (`act`) + flush (`updateAndSync`), so every
vtab insert/update/delete persisted at DML time. Quereus evaluates deferred
(subquery-bearing) CHECK constraints at **commit**, after the row was already
written, so a rejection left the violating row committed in storage. The fix:

- **db-core (additive):** `Collection.snapshotPending()`/`restorePending()` +
  `CollectionSnapshot<TAction>`; `Tree.stage()`/`sync()`/`snapshot()`/`restore()`.
  `Tree.replace` semantics untouched (still used by SchemaManager DDL + addIndex
  bootstrap).
- **plugin:** `TransactionBridge` keeps a `Map<DirtyTree, snapshot>`; `markDirty`
  snapshots a tree's pre-stage state the first time it is marked; legacy-mode
  commit flushes every dirty tree via `tree.sync()`; rollback restores every
  dirty tree from its snapshot (both modes). `OptimysticVirtualTable.update()`
  stages (not replaces) and calls `markDirtyTrees()` **before** staging in all
  three branches. `IndexManager` insert/update/delete now `stage`; `addIndex`
  bootstrap stages then explicitly `sync()`s.
- **sereus:** `strand-schema.e2e.spec.ts` rejection cases now assert the table is
  unchanged; the KNOWN-GAP comments are gone.

The key subtlety — snapshot **before** the first stage rather than reset-to-empty
on rollback — is correct: a never-synced collection's header/root live in the
tracker until first sync, so a blanket reset would make it unreadable. Verified
the snapshot is taken pre-stage in all three `update()` branches, and that
`markDirty` only snapshots on first mark (so a multi-statement txn rolls back to
its starting state). Confirmed `Collection.syncInternal` calls `tracker.reset()`
on success, so post-commit trackers are empty — snapshots stay cheap and the
`dirtyTrees` map is cleared on both commit and rollback (no stale-restore risk).

## Review findings

**Scope reviewed:** the full implement diff in the `../optimystic` working tree
(collection.ts, tree.ts, txn-bridge.ts, optimystic-module.ts, index-manager.ts)
plus the sereus e2e diff; the snapshot/restore wiring against `Tracker.reset` /
`copyTransforms`; the commit/rollback/clear lifecycle; and all DML/DDL write
paths. Aspect sweep (SPP, DRY, modularity, error handling, resource cleanup, type
safety, performance) below.

- **Correctness / atomicity — PASS.** Snapshot is taken before staging in every
  `update()` branch (insert/update/delete), index trees are pre-created at
  `initialize()` (no lazy tree escapes the snapshot), and `restorePending` deep-
  clones via `copyTransforms` so the snapshot is independent of later mutations.
  `tree.reset(newTransform = emptyTransforms())` accepts the restored transforms.
- **Write-path coverage — PASS.** Only `SchemaManager` still uses `tree.replace`
  (DDL — schema writes committed immediately, not subject to deferred CHECKs).
  `addIndex` stages-then-syncs because it runs outside the DML commit. No DML
  path bypasses staging.
- **Type safety — PASS.** `DirtyTree.snapshot(): unknown` / `restore(unknown)` is
  a deliberate opaque-token boundary so the bridge can hold main + index trees in
  one map without generic friction; the round-trip is type-safe at each `Tree`.
- **Minor (fixed inline):** stale `{@link discardChanges}` JSDoc reference in
  `tree.ts:61` (method was renamed to snapshot/restore) → repointed to
  `{@link snapshot}/{@link restore}`. No other dangling references to the removed
  `discardPending`/`discardChanges` remain in source.
- **Test gaps the ticket flagged (added inline, both PASS):**
  - *btree split during staging then rollback* — stage 70 rows (> NodeCapacity 64)
    in one rejected transaction so the btree splits mid-stage; confirms the
    snapshot/restore reverts the entire split (in-session + reopen → 0 rows).
  - *multi-row single INSERT* where one row trips a deferred CHECK — confirms the
    whole statement rolls back (none of the staged rows survive).
  The deferred-constraint spec is now **8 passing** (6 original + 2 added).
- **Documentation — PASS.** The touched JSDoc reflects the staging/commit/rollback
  reality; no external design doc referenced `Tree.replace` semantics or the vtab
  DML flush timing, so nothing else needed updating.
- **Known gaps — accepted, owned elsewhere.** (1) Session/distributed-consensus
  mode is not exercised with staging and may double-restore on rollback —
  investigation + follow-up filed as `optimystic-session-mode-commit-composition`
  in the optimystic workflow. (2) Legacy multi-tree commit is not atomic across
  trees on a mid-loop storage error (pre-existing; in-memory re-converges on next
  read). (3) Multi-connection commit relies on the pre-existing re-begin guard
  (covered indirectly by the passing shared-transaction-state spec). (4) The
  index-integrity test is white-box because the SQL read path self-heals an
  orphaned index entry. None block this ticket.
- **No security, resource-leak, or performance regressions found.** Snapshots are
  taken against an empty (post-sync) tracker in the normal path, so the deep-clone
  cost is negligible; `dirtyTrees` is cleared on begin/commit/rollback.

## Note on the cross-repo layout

The functional code lives in the sibling `../optimystic` repo, consumed by sereus
via root `resolutions` links. Those changes are present in the optimystic working
tree (alongside unrelated in-flight cohort-topic work) and are NOT committed by
the tess runner, which commits only the sereus repo (the e2e test + this ticket
move). This is the established pattern for this workspace. The index-manager
`stage` methods and the new spec file were committed within optimystic's own
ticket history; the staging core (collection/tree/txn-bridge/module) sits
uncommitted in the optimystic working tree.

## Validation performed (all green, re-run during review)

- db-core: `yarn build` + `yarn test` → **533 passing**.
- plugin: `yarn build` + `yarn typecheck` + `yarn test` → **203 passing, 4 pending**.
- deferred-constraint spec → **8 passing** (after adding the two adversarial tests).
- sereus: `vitest run --project e2e strand-schema` → **6 passing**.
- `eslint` on the changed sereus e2e file → clean. (optimystic packages gate on
  `tsc` typecheck, which passed; they ship no eslint script.)

## No pre-existing failures

No `tickets/.pre-existing-error.md` was written — every suite passed from a clean
state; nothing unrelated was broken or worked around.

## How to re-run

- `cd ../optimystic/packages/db-core && yarn build && yarn test`
- `cd ../optimystic/packages/quereus-plugin-optimystic && yarn build && yarn typecheck && yarn test`
  (single spec: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/deferred-constraint-rollback.spec.ts" --reporter spec --exit`)
- `cd packages/quereus-plugin-sereus && yarn vitest run --project e2e strand-schema`
- Rebuild order: db-core (tsc) → plugin (tsup) → sereus (consumes the plugin's
  built `dist` via root `resolutions`).
