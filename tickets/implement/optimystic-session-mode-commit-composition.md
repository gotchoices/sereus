description: Verify + repair distributed-consensus SESSION-mode commit/rollback composition for the optimystic vtab deferred-DML staging refactor. Session-mode commit currently reads an empty/disjoint coordinator collection map and silently drops all staged DML; the bridge's per-tree rollback also double-owns tracker rollback once the wiring is correct. Add real-DML session-mode tests (commit persists, rollback reverts, indexes consistent) and fix the disjoint-collections wiring.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts, ../optimystic/packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/db-core/src/transaction/session.ts, ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/quereus-plugin-optimystic/test/deferred-constraint-rollback.spec.ts, ../optimystic/packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts, ../optimystic/packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
----

# Repair session-mode commit/rollback composition for the staging-DML refactor

> The code under test lives in the sibling `../optimystic` workspace (linked into
> Sereus via `resolutions`). A parallel implement ticket with the same analysis
> already exists in the optimystic repo's own pipeline at
> `../optimystic/tickets/implement/optimystic-session-mode-commit-composition.md`;
> if that lands first, reconcile rather than duplicate. This ticket exists because
> the bug was surfaced by the Sereus-driven fix
> `optimystic-deferred-constraint-rejection-not-rolled-back` and Sereus depends on
> the optimystic vtab path being correct.

## Origin

The deferred-constraint atomicity fix (`optimystic-deferred-constraint-rejection-not-rolled-back`,
commits `b9da849`/`ee6e404`) changed the vtab DML path so `insert`/`update`/`delete`
**stage** into the collection tracker (`Tree.stage` = `Collection.act` with no sync)
instead of persisting inline (the old `Tree.replace` = `act` + `updateAndSync`). The
flush is now driven by `TransactionBridge`:

- **commit** (`txn-bridge.ts:144-184`): **legacy mode** (`session === null`) flushes every
  staged tree via `tree.sync()`. **Session mode** was left unchanged — it calls
  `session.commit()` and deliberately does NOT call `tree.sync()`.
- **rollback** (`txn-bridge.ts:191-228`): **both** modes restore each dirty tree from a
  per-tree pre-stage snapshot (`tree.restore(snapshot)`), plus `session.rollback()` when a
  session is present.

The legacy path is covered (`deferred-constraint-rollback.spec.ts`, `index-support.spec.ts`).
The **session/consensus** path is not — and the research below shows it is not merely
untested but **wired incorrectly**.

## Verified research — the actual bug

Independently confirmed by tracing the code (June 2026):

1. **Engine returns no actions.** `QuereusEngine.execute()` runs `db.exec(sql)` and always
   returns `actions: []` (`quereus-engine.ts:74,90-93`). The real mutations are staged by
   `OptimysticVirtualTable.update()` into `Tree`/`Collection` instances obtained from
   `CollectionFactory` (`optimystic-module.ts:709,740,746,772` via `this.collection.stage(...)`
   and `indexManager.*IndexEntries`).

2. **Bridge feeds the session empty actions.** `TransactionBridge.addStatement` calls
   `void this.session.execute(statement, [])` (`txn-bridge.ts:287`) → `session.execute`
   takes the provided `actions` branch (`session.ts:80-81`) → `coordinator.applyActions([], stampId)`
   (`session.ts:98`). With an empty batch the coordinator tracks nothing meaningful.

3. **Coordinator reads its own, disjoint collection map.** `coordinator.commit(transaction)`
   collects transforms by iterating its **own** `this.collections` map (`coordinator.ts:111-121`),
   the `Map<CollectionId, Collection>` passed to its constructor. The vtab's `this.collection`
   and lazily-created index trees come from `CollectionFactory` — a disjoint instance set. Index
   trees are created at DML time with a throwaway txnState, so they can never be pre-registered
   into a coordinator map built earlier. Empty/disjoint map ⇒
   `collectionData.length === 0 → return` ("Nothing to commit", `coordinator.ts:123-125`).

4. **Bridge skips the flush in session mode.** Because `txn-bridge.ts:150-161` deliberately
   omits `tree.sync()`, the staged trees never reach the transactor either.

   **Net result: a committed session-mode transaction persists nothing — accepted DML is
   silently dropped.** (Before the staging refactor, session mode "worked" only by accident:
   the vtab's inline `updateAndSync` persisted at DML time regardless of the blind coordinator.)

5. **The path is dormant.** No production code calls `TransactionBridge.configureTransactionMode()`
   anywhere in optimystic OR Sereus (`grep` confirms: only one detection test in
   `adapter-integration.spec.ts:443-451` passing `{} as any` mocks, which never commits real DML;
   `quereus-validator.ts:52` builds a `QuereusEngine` for the separate re-execution/validation
   path, not the live session-commit wiring). Sereus bootstrap/local and networked modes both run
   the bridge in legacy mode. This is why the silent drop has never bitten anyone — but it is a
   live correctness landmine the moment session mode is wired up.

### Rollback composition (second concern)

`rollbackTransaction` (`txn-bridge.ts:191-228`) in session mode calls BOTH:
- `session.rollback()` → `coordinator.rollback(stampId)` (`coordinator.ts:202-245`), which
  restores the coordinator's own trackers to its pre-session snapshot and replays later sessions'
  batches to preserve their transforms; AND
- `tree.restore(snapshot)` per dirty tree (the bridge's per-tree pre-stage snapshot).

Today these operate on **disjoint** instances, so `coordinator.rollback` is effectively a no-op on
the vtab's real trackers and only `tree.restore` reverts anything — no conflict, but fragile. Once
the commit fix (Approach B) makes the coordinator and vtab share the same `Collection` instances,
the double-restore becomes a genuine conflict: the coordinator owns correct multi-session replay,
then the bridge's blind `tree.restore` would clobber it. **A single owner of tracker rollback in
session mode must be chosen** — recommended: the coordinator owns it in session mode (it handles
multi-session interleaving/replay); the bridge's per-tree `tree.restore` is the legacy-only path.

## Design for the fix

Two candidate approaches; **Approach B is recommended** — it is the documented intent
(`../optimystic/docs/transactions.md`, `docs/optimystic.md` §"Transactions Across Collections")
and preserves the consensus/validation guarantees session mode exists for.

- **Approach A (reject as the real fix; acceptable only as a documented stopgap):** in session
  mode also flush `dirtyTrees` via `tree.sync()` like legacy. This persists, but bypasses the
  coordinator's GATHER/PEND/COMMIT consensus, cross-collection atomic commit, and schema
  validation — defeating the purpose of session mode.

- **Approach B (recommended): make the coordinator operate on the same `Collection` instances the
  vtab stages into**, so `coordinator.commit()` reads the staged transforms and the deliberate
  no-`tree.sync()` in session mode is then correct. Concretely:
  - Add a minimal package-internal accessor to obtain the underlying `Collection` from a `Tree`
    (currently `private` on `Tree`, `tree.ts:9-13`) rather than reaching through `['collection']`.
  - Give the coordinator (lazy) collection registration — either a
    `TransactionCoordinator.registerCollection(id, collection)` method, or have the plugin pass a
    **live shared `Map`** that both the factory-backed vtab and the coordinator reference, so a
    tree created mid-transaction lands in the coordinator's view before commit. The main-table
    collection and each touched index collection must be present.
  - Decide the owner of coordinator construction in the plugin's session-mode wiring (today nobody
    constructs one for the live path). Either `configureTransactionMode` accepts a coordinator whose
    collection map the plugin keeps populated, or the plugin builds the coordinator from its
    `CollectionFactory`. Keep `QuereusEngine.execute` returning `[]` — the fix is about *where the
    trackers live*, not making the engine return actions.
  - In session-mode rollback, make the coordinator the single owner: skip the bridge's per-tree
    `tree.restore` when a session is present (keep it for legacy mode), OR conversely keep the
    per-tree restore and have the session NOT also restore — but the coordinator path is the only
    one that correctly handles multi-session replay, so prefer it.

Consensus runs in-process without libp2p: single-collection commits skip GATHER (`coordinator.ts:608`);
a main-table + index transaction is multi-collection, so GATHER runs but the `local`/`test`
transactor exposes no `queryClusterNominees` and the coordinator degrades to single-collection
consensus (`coordinator.ts:613-616`). PEND/COMMIT then run through the `local`/`test` transactor's
`StorageRepo`, so a real-DML session test drives genuine consensus in-process.

### Escalation valve (honest-gap handoff)

If completing Approach B requires a larger db-core API change or a product decision about
session-mode ownership that exceeds a focused implement pass: land the reproduction + Phase 3 green,
convert the session-mode commit/rollback assertions to a clearly-commented `it.skip` (or an `it`
documenting the expected-fail) that pins the silent-drop, file a `tickets/backlog/` ticket capturing
the open design question, and be explicit about it in the review/ handoff. **Do not leave the suite
red, and do not ship Approach A silently as if it were the real fix.**

## Reference points (verified line numbers)

- Bridge commit/rollback + `markDirty`: `txn-bridge.ts:144-184` (commit), `191-228` (rollback), `258-262` (markDirty).
- Empty-action session execute: `txn-bridge.ts:283-288`, `session.ts:69-110`.
- Coordinator "nothing to commit" gate + reset: `coordinator.ts:105-191` (esp. `111-125`, `176-191`); rollback/replay: `coordinator.ts:202-245`.
- Engine returns `[]`: `quereus-engine.ts:72-100`.
- Vtab staging + `markDirtyTrees`: `optimystic-module.ts:648-782`.
- Tree stage/sync/snapshot/restore: `tree.ts:59-87`.
- Index staging: `index-manager.ts:100-171`.
- Legacy-mode test template (real `local` transactor + `FileRawStorage`, reopen + index counts): `deferred-constraint-rollback.spec.ts` (`createDb` helper, `selectCount`, `expectThrows`).
- Detection-only session test (mocks, no real DML): `adapter-integration.spec.ts:437-458`.

## TODO

### Phase 1 — Reproduce session-mode commit composition (real DML)
- Add `session-mode-commit.spec.ts` (or extend `adapter-integration.spec.ts`) that wires a REAL
  `TransactionCoordinator` + `QuereusEngine` and calls
  `plugin.txnBridge.configureTransactionMode(...)` the way a host would, against the `local`
  transactor + `FileRawStorage` (mirror the `createDb` helper in `deferred-constraint-rollback.spec.ts`;
  a 1-node path is sufficient — `mesh-test`/`distributed-quereus.spec.ts` show fuller wiring if needed).
- Drive `BEGIN; INSERT/UPDATE/DELETE across the main table AND at least one index; COMMIT;` and
  assert rows + index entries are durably present **in-session and after reopen** (reuse
  `selectCount`/reopen patterns). With the bug present this FAILS (silent drop) — it is the
  reproduction.

### Phase 2 — Fix session-mode wiring (Approach B) and make Phase 1 pass
- Implement the shared-collection wiring so `coordinator.commit()` reads the vtab's staged
  trackers: Tree→Collection accessor in db-core, coordinator collection registration (main table +
  each touched index), and a clear owner for coordinator construction in the plugin. Keep the
  bridge's no-`tree.sync()` in session mode.
- Resolve the rollback double-restore: make the coordinator the single owner of tracker rollback in
  session mode (skip the bridge's per-tree `tree.restore` when a session is present; keep it for
  legacy). Add a session-mode **rollback** test: a subquery-bearing CHECK rejection (or explicit
  ROLLBACK) leaves storage untouched — no staged rows, no orphaned index entries — proving the
  deferred-constraint atomicity fix holds in session mode too.
- Update the now-stale comment in `txn-bridge.ts:150-161` (drop the
  `fix/optimystic-session-mode-commit-composition` breadcrumb; make it reflect the now-tested,
  corrected state).

### Phase 3 — Fill the remaining named gaps (cheap, lands green independently)
- Add a focused unit test asserting `Tree.restore(snapshot)` (`Collection.restorePending`) /
  any `discardChanges`/`discardPending` equivalent is a safe no-op on (a) a never-staged tree and
  (b) an already-synced tree — covering the "restore of an empty tracker is a no-op" claim the
  immediate-CHECK regression test does NOT reach.
- Optionally add an explicit assertion that `markDirtyTrees()` registers index trees (documents the
  throwaway-txnState intent beyond the implicit insert-then-query flush proof).

### Validation
- Build first (tests import from `dist/`):
  `yarn workspace @optimystic/quereus-plugin-optimystic build`, then
  `yarn workspace @optimystic/quereus-plugin-optimystic test` (stream with `tee`, never silent
  redirect). This package is NOT in the root test fan-out — run it directly.
- If Phase 2 touches `coordinator.ts`/`tree.ts`/`collection.ts`, also run
  `yarn workspace @optimystic/db-core test`.
- Keep `quereus-plugin-optimystic` green. If a failure is plainly pre-existing and outside this
  diff, follow the pre-existing-error protocol (`tickets/.pre-existing-error.md`).
