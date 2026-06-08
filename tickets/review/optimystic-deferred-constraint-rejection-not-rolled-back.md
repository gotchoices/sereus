description: Implemented the deferred-constraint atomicity fix for the optimystic local/bootstrap (and networked) transactor. The vtab DML path now STAGES insert/update/delete into the collection tracker at DML time and only flushes to storage at transaction commit, rolling back staged mutations (via a pre-stage snapshot/restore) on rollback. A deferred (subquery-bearing) CHECK that throws at commit now leaves the violating row absent — in-session AND after reopen — instead of leaking a committed row. Review the staging/commit/rollback wiring, the snapshot-timing subtlety, and the honestly-flagged gaps below.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/test/deferred-constraint-rollback.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts
----

## What was wrong

`Tree.replace()` fused stage (`act`) + flush (`updateAndSync`), so every vtab
`insert`/`update`/`delete` persisted to storage at DML time. Quereus evaluates
deferred (subquery-bearing) CHECK constraints at **commit**, after the row was
already persisted. When a deferred CHECK threw, the optimystic rollback only
cleared local bookkeeping — the violating row stayed committed in storage
(in-session and after reopen). Every cross-table authorization constraint in the
Strand membership/RBAC schema is subquery-gated, so RBAC enforcement was
non-atomic.

## What changed (stage → flush-at-commit → snapshot/restore-on-rollback)

**db-core (additive — `Tree.replace` semantics untouched, still used by the
SchemaManager and addIndex bootstrap):**
- `Collection.snapshotPending()` / `restorePending()` (`collection/collection.ts`)
  capture/restore the tracker transforms **and** the pending action queue
  (deep-cloned via `copyTransforms`). New `CollectionSnapshot<TAction>` type.
- `Tree.stage()` (act, no sync), `Tree.sync()` (updateAndSync), `Tree.snapshot()`
  / `Tree.restore()` (`collections/tree/tree.ts`).

**plugin:**
- `TransactionBridge` (`optimystic-adapter/txn-bridge.ts`): `markDirty(tree)`
  snapshots a tree's pre-stage state the first time it is marked; `commitTransaction`
  legacy branch flushes every dirty tree via `tree.sync()`; `rollbackTransaction`
  restores every dirty tree from its snapshot (in BOTH modes). `dirtyTrees` is a
  `Map<DirtyTree, snapshot>` cleared on begin/commit/rollback.
- `OptimysticVirtualTable.update()` (`optimystic-module.ts`): stages instead of
  replacing, and calls `markDirtyTrees()` (main collection + all index trees)
  **before** staging. `addIndex()` bootstrap now stages then explicitly
  `sync()`s the index trees (it runs outside the DML commit).
- `IndexManager` (`schema/index-manager.ts`): insert/update/delete now `stage`;
  added `getIndexTrees()`.
- Removed the dead no-op `CollectionFactory.syncCollection` placeholder.

**sereus:** tightened `strand-schema.e2e.spec.ts` — the two rejection cases now
assert the table is unchanged (count before == after / == 0) and the KNOWN GAP
comments are gone.

## THE subtlety a reviewer must scrutinize: snapshot timing

The first (obvious) implementation reset the tracker to empty on rollback. That
**broke never-synced collections**: a collection's header/root blocks live in the
tracker (uncommitted) until the first sync, so a table whose only operation is a
rejected insert (e.g. `Invite`) became unreadable afterward (`Missing block
(default/Invite)`). The fix is to snapshot the tracker+pending BEFORE the first
stage and restore that snapshot on rollback — which preserves header/root for
never-synced collections and reduces to "reset to empty" for already-synced ones.
**This is why `markDirtyTrees()` must run before `stage()`** (verify the ordering
in all three `update()` branches) and why `markDirty` only snapshots on first mark
(so a multi-statement transaction rolls back to its *starting* state).

## Validation performed (all green)

- db-core: `yarn build` (tsc) + `yarn test` → **533 passing**.
- plugin: `yarn build` (tsup) + `yarn typecheck` + `yarn test` → **203 passing, 4
  pending** (includes the real-libp2p distributed/mesh specs → the staging+
  commit-sync path works for the **networked** transactor too, in legacy bridge
  mode).
- New plugin spec `deferred-constraint-rollback.spec.ts` (local transactor +
  real `FileRawStorage`) → **6 passing**: insert/update/PK-update rejection
  (in-session + reopen), staged-DELETE discarded by a deferred failure in a txn,
  no orphaned secondary-index entry, immediate-CHECK regression.
- Sereus: `vitest --project e2e` → **15 passing** (bootstrap + networked +
  strand-schema, incl. the tightened assertions); `--project unit` → **45
  passing**; plugin `typecheck` + `eslint` on the changed e2e file clean.

These tests are the floor, not the ceiling. Suggested adversarial follow-ups for
the reviewer:
- **btree split during staging then rollback**: stage > `NodeCapacity` (64) rows
  in one rejected statement/txn so the btree splits mid-stage, then confirm the
  snapshot/restore reverts the split cleanly (in-session + reopen). Not covered.
- **multi-row single INSERT** where one row violates a deferred CHECK — confirm
  the whole statement rolls back (my insert tests use single-row statements).
- **multi-table explicit transaction** with a deferred failure spanning >1 table
  (relies on the shared `dirtyTrees` map + the connection.commit re-begin guard —
  see gaps).

## Known gaps / honest caveats

1. **Session (distributed-consensus) mode is NOT verified with staging.** The
   commit-time `tree.sync()` is gated to legacy mode; the session branch is
   unchanged and relies on `coordinator.commit()` reading the (now non-empty)
   trackers. Session mode is unused by Sereus and not exercised by real DML in
   optimystic tests. Investigation + a follow-up are filed:
   `tickets/fix/optimystic-session-mode-commit-composition.md`. Rollback restore
   runs in both modes and may double-restore with `coordinator.rollback()` in
   session mode (also covered by the follow-up).
2. **Legacy multi-tree commit is not atomic across trees** (pre-existing). If
   `tree.sync()` fails mid-commit-loop, already-synced trees stay in storage while
   the catch→rollback restores all in-memory trackers; in-memory re-converges to
   storage on the next read's `update()`, but a partial multi-tree write is still
   possible on a storage error. Out of scope for this ticket.
3. **Multi-connection commit** depends on the pre-existing
   `OptimysticVirtualTableConnection.commit()` re-begin guard: the first
   connection's `commitTransaction()` flushes ALL dirty trees (the map is shared
   on the bridge); later connections re-begin an empty txn and no-op. Verified
   indirectly by the passing "share transaction state across multiple tables"
   plugin spec — worth a direct look.
4. The index-integrity test inspects the index **tree** directly (white-box via
   `collectionFactory`) because the SQL read path self-heals an orphaned index
   entry by re-fetching the (absent) row from the main table, so a SQL query can't
   observe a leaked orphan without PK reuse.

## How to re-run

- `cd ../optimystic/packages/db-core && yarn build && yarn test`
- `cd ../optimystic/packages/quereus-plugin-optimystic && yarn build && yarn test`
  (single spec: append `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/deferred-constraint-rollback.spec.ts" --reporter spec --exit`)
- `cd packages/quereus-plugin-sereus && yarn vitest run --project e2e strand-schema`
- Rebuild order matters: db-core (tsc) then plugin (tsup) before Sereus tests —
  Sereus consumes the plugin's built `dist` via root `resolutions` link.

## No pre-existing failures

No `tickets/.pre-existing-error.md` was written — every suite above passed from a
clean state; nothing unrelated was broken or worked around.
