description: A deferred (subquery-bearing) CHECK constraint that fails on a write throws correctly, but the optimystic local/bootstrap transactor does NOT roll back the violating row — it stays committed in storage. RBAC enforcement is therefore non-atomic for any cross-table constraint. Fix: stage vtab DML in the collection's tracker at DML time and only flush to storage at transaction commit, discarding staged mutations on rollback.
prereq:
files: ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts
----

## Root cause (confirmed by code trace)

`Tree.replace()` (`../optimystic/packages/db-core/src/collections/tree/tree.ts:54-57`) does two
things back-to-back:

```ts
async replace(data) {
    await this.collection.act({ type: "replace", data });   // stage in tracker + pending (in-memory)
    await this.collection.updateAndSync();                   // FLUSH to transactor/storage NOW
}
```

The `updateAndSync()` immediately pushes the staged mutation to the transactor — i.e. **every
vtab `insert`/`update`/`delete` is persisted to storage at DML time**, before the statement's
transaction is asked to commit.

The Quereus side is correct. `TransactionManager.commitTransaction()`
(`../quereus/packages/quereus/src/core/database-transaction.ts:234-241`) runs
`runDeferredRowConstraints()` **before** calling `connection.commit()`. A deferred CHECK that
fails throws there; the catch (`database-transaction.ts:266-270`) calls `connection.rollback()`
on every vtab connection and rethrows.

But the optimystic rollback can't undo the write. `connection.rollback()`
(`vtab-connection.ts:45-47`) → `txnBridge.rollbackTransaction()`
(`txn-bridge.ts:149-174`) only clears local bookkeeping (`currentTransaction.collections.clear()`,
`isActive = false`). It never reverts the `updateAndSync()` that already landed the row in
storage. So the violating row stays committed — in-session and after reopen.

**Why immediate constraints look fine:** Quereus evaluates non-deferred CHECKs at row time in
`constraint-check.ts` (`checkCheckConstraints`, `../quereus/packages/quereus/src/runtime/emit/constraint-check.ts:341`),
which throws *before* the row reaches the DML executor and thus before `vtab.update()` →
`collection.replace()` is ever called. No `replace()` ⇒ nothing persisted ⇒ table unchanged.
Deferred CHECKs (subquery / `committed.*`, flagged `needsDeferred`) are queued
(`constraint-check.ts:341-354` → `_queueDeferredConstraintRow`) and evaluated at commit, long
after `replace()` already synced the row.

Every cross-table authorization constraint is deferred (subquery-gated), so the entire `Strand`
membership schema and the control schema leak rejected rows in bootstrap mode.

## Fix strategy: stage at DML time, flush at commit, discard on rollback

The `Collection` already cleanly separates `act()` (stage into the in-memory `tracker` + `pending`,
visible to subsequent reads through the same collection instance) from `sync()` (push pending to
the transactor). `Tree.replace()` merely fuses the two. The fix is to let the vtab DML path stage
without syncing, and drive the actual sync/discard from the transaction lifecycle:

```
vtab.update()  ──▶ tree.stage(data)        // act() only — NO updateAndSync
                   bridge.markDirty(tree)  // remember every tree touched this txn

commitTransaction (deferred constraints already passed):
   legacy mode  ──▶ for each dirty tree: await tree.sync()     // flush now
   session mode ──▶ session.commit() (consensus) — see Phase 4 investigation

rollbackTransaction (deferred constraint threw, or explicit ROLLBACK):
   any mode     ──▶ for each dirty tree: tree.discardChanges()  // drop pending + reset tracker
```

Because deferred constraints throw *before* `connection.commit()`, the dirty trees are still in
the staged (un-synced) state when rollback runs; discarding them leaves storage untouched. That is
the actual bug fix. The commit-time `sync()` is the necessary counterpart that keeps accepted
writes persisting.

### Critical constraints on the change

- **DO NOT change `Tree.replace()`'s existing semantics.** `SchemaManager.storeStoredSchema` /
  `deleteSchema` (`../optimystic/packages/quereus-plugin-optimystic/src/schema/schema-manager.ts:93,134`)
  and `addIndex`'s index-bootstrap population call `tree.replace()` **outside** any data
  transaction and rely on it persisting immediately. Add NEW methods (`stage`, `sync`,
  `discardChanges`) and only the vtab DML path uses `stage`; everything else keeps `replace`.
- **In-transaction reads must still see staged rows.** After `act()` with no `sync()`, reads
  through the *same* collection instance see the staged mutation via the tracker. The vtab holds a
  single long-lived `this.collection` (set in `doInitialize`) and reuses it for both reads and
  writes, so this holds. Index trees likewise live in `IndexManager.indexTrees`. Note: the
  deferred-constraint subqueries (e.g. `(select count(1) from Member) <= 1`) must see the staged
  NEW row at eval time — they do today (row is synced) and will continue to (row is staged in the
  same Member collection). Verify `executeTableScan`/`executePointLookup`'s `collection.update()`
  call does not drop staged pending: `Collection.updateInternal` only resets/replays on *conflict*,
  and a single-node local transactor with no concurrent writer produces none.
- **Index trees must join the dirty set.** Index entries are written via
  `IndexManager.insert/update/deleteIndexEntries` → `tree.replace(...)` on each index tree
  (`index-manager.ts:105,126,155`). These trees are created with a throwaway `txnState`
  (`optimystic-module.ts:243`, `collections: new Map()`), so they are NOT in
  `currentTransaction.collections`. They must be staged (not replaced) and registered dirty too,
  or rollback will leak orphaned index entries even after the main row is discarded.

### Dirty-tree tracking

`currentTransaction.collections` is unreliable for this (main `this.collection` is long-lived and
created before the txn; index trees use a throwaway txnState). Add an explicit dirty set on the
bridge instead:

- `TransactionBridge.markDirty(tree: Tree<...>)` — adds to a `Set<Tree>` scoped to the current txn.
- `commitTransaction()` (legacy branch): replace the no-op `syncCollection` loop
  (`collection-factory.ts:446-453` is a documented placeholder that does nothing — that is why the
  legacy commit currently relies on `replace`'s inline sync) with `for (const t of dirty) await
  t.sync()`. Then clear the dirty set.
- `rollbackTransaction()`: `for (const t of dirty) t.discardChanges()` (in addition to the existing
  `session.rollback()`), then clear the dirty set. Run the discard in BOTH modes — it is safe and
  is what fixes the bug regardless of transactor.

The vtab `update()` registers `this.collection` plus every touched index tree
(expose `IndexManager.getIndexTrees(): Tree[]`) via `bridge.markDirty(...)` after staging.

### New db-core primitives

- `Collection.discardPending()`: `this.pending = []; this.tracker.reset();` (Tracker.reset clears
  in-memory transforms — `../optimystic/packages/db-core/src/transform/tracker.ts:64`). After this,
  reads through the collection see committed source state again.
- `Tree.stage(data)`: `await this.collection.act({ type: "replace", data });` (no sync).
- `Tree.sync()`: `await this.collection.updateAndSync();` (the same call `replace` makes today).
- `Tree.discardChanges()`: `this.collection.discardPending();`.

## Acceptance tests

Focused bootstrap-mode reproduction. The simplest deferred CHECK is a self-referential subquery
(`needsDeferred = containsSubquery(...)`), e.g. a table with `check ((select count(*) from T) <= 1)`:
the 2nd insert stages, the count subquery sees 2 at commit, the deferred CHECK throws, and the row
must be gone afterward.

- **Bootstrap, deferred CHECK, insert:** after a rejected `insert`, `select count(*)` is unchanged
  **in-session** AND **after reopening** the same `FileRawStorage` dir. (Today: count grows and
  persists.)
- **Bootstrap, deferred CHECK, update + delete:** a rejected `update` / `delete` leaves the row set
  unchanged (in-session + reopen). UPDATE that changes the PK exercises the delete-old/insert-new
  staging path (`optimystic-module.ts:709-718`); confirm both index halves discard.
- **Index integrity:** after a rejected insert on a table with a secondary index, an index-driven
  query returns no orphaned hit for the discarded row.
- **Regression guard:** an *immediate* (no-subquery) CHECK rejection still leaves no row (already
  works — don't break it).
- **Tighten the existing e2e:** `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`
  currently documents this gap (lines ~214-219 and ~243-245) and asserts only that the write
  throws. After the fix, change the two rejection cases to ALSO assert the table is unchanged
  (`select count(*)` before == after), and delete the "KNOWN GAP" comments.

## Build / wiring notes

- optimystic and Sereus are separate repos linked via root `package.json` `resolutions`
  (`@optimystic/db-core` and `@optimystic/quereus-plugin-optimystic` → `link:../optimystic/...`).
  The Sereus e2e and the plugin's own mocha specs import the plugin's **built `dist`**, so after
  editing optimystic source you must rebuild: `yarn build` in `../optimystic/packages/db-core`
  then in `../optimystic/packages/quereus-plugin-optimystic` (tsup), before running Sereus tests.
- Plugin specs: `cd ../optimystic/packages/quereus-plugin-optimystic && npm run build && npm test`
  (mocha + chai; `local-transactor-storage.spec.ts` is the template for a local-transactor +
  `rawStorageFactory` harness). Stream output with `| tee` per tess long-validation rules.
- Sereus e2e: run the strand schema suite from `packages/quereus-plugin-sereus` (vitest).

## Network/session-mode investigation (required, but bootstrap is the acceptance bar)

The desired behavior names both transactors, but all acceptance tests are bootstrap/local. In
session mode (`txn-bridge.ts:120-125`) commit goes through `session.commit()` for consensus, while
the btree blocks are staged in the collection tracker. Confirm that with the DML path now staging
(not syncing inline), accepted writes still persist in session mode — i.e. that `session.commit()`
incorporates the collection transforms, or that the dirty-tree `sync()` must also run in session
mode (and in what order relative to `session.commit()`). The rollback-discard step is mode-agnostic
and must run in both. If session-mode persistence regresses and the correct composition isn't
obvious, gate the commit-time `sync()` so legacy mode is fixed now and file a follow-up
`fix/` ticket for session-mode commit composition rather than destabilizing consensus commit.

## TODO

### Phase 1 — db-core primitives
- Add `Collection.discardPending()` (`collection/collection.ts`): clear `pending`, `tracker.reset()`.
- Add `Tree.stage(data)`, `Tree.sync()`, `Tree.discardChanges()` (`collections/tree/tree.ts`);
  leave `Tree.replace()` unchanged.

### Phase 2 — plugin DML staging + dirty tracking
- Add `TransactionBridge.markDirty(tree)` + a per-transaction dirty `Set<Tree>`; clear it in both
  commit and rollback (`optimystic-adapter/txn-bridge.ts`).
- In `OptimysticVirtualTable.update()` (`optimystic-module.ts:651-759`): replace
  `this.collection.replace(...)` with `this.collection.stage(...)` and `markDirty(this.collection)`.
- In `IndexManager` (`schema/index-manager.ts`): stage index mutations (add `tree.stage` calls or
  switch the `replace` calls), expose `getIndexTrees(): Tree[]`, and have the vtab `markDirty` each
  touched index tree after staging.

### Phase 3 — commit/rollback lifecycle
- `commitTransaction()` legacy branch: sync all dirty trees instead of the no-op
  `syncCollection` (`txn-bridge.ts:126-131`; the placeholder lives in
  `collection-factory.ts:446-453`).
- `rollbackTransaction()`: `discardChanges()` on all dirty trees (both modes), alongside the
  existing session rollback (`txn-bridge.ts:149-174`).

### Phase 4 — verify & test
- Verify in-transaction reads still observe staged rows (constraint subqueries must see the staged
  NEW row at deferred-eval time; reads after `collection.update()` must not drop pending).
- Add the focused bootstrap reproduction spec in the plugin (insert/update/delete + index +
  immediate regression; in-session and reopen via `FileRawStorage`).
- Tighten `strand-schema.e2e.spec.ts` rejection cases to assert table-unchanged; remove the
  KNOWN GAP comments.
- Run the network/session investigation above; document the outcome (and file a follow-up if
  session-mode commit composition needs separate work).
- Rebuild db-core + plugin dist, then run plugin mocha specs and the Sereus strand e2e (stream
  output). Honest handoff: note any pre-existing failures via `tickets/.pre-existing-error.md`.
