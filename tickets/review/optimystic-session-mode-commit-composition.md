description: Review the session/consensus-mode commit+rollback composition fix for the optimystic vtab deferred-DML staging refactor. The disjoint-collections silent-drop is fixed (shared live registry) AND a deeper coordinator.commit() gap (never appended a log entry) was found and fixed. Real-DML session-mode tests added. Code lives in ../optimystic (committed there by optimystic's own tess runner); 3 orthogonal pre-existing issues filed as ../optimystic backlog tickets.
prereq:
files: ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
----

# Review: session-mode commit/rollback composition (optimystic vtab)

> **Cross-repo.** All code under review lives in the sibling `../optimystic`
> workspace (linked into Sereus via `resolutions`). It was committed there by
> **optimystic's own concurrently-running tess runner**, which swept the shared
> working tree — so the changes landed bundled into optimystic commits
> `a8b9570` and `80930c5` (titled for unrelated `cohort-topic` work). That is a
> filesystem-level race artifact, not a logical coupling; `git show <sha>` will
> show both my files and cohort-topic files. optimystic `HEAD` equals the exact
> state validated below. The parallel optimystic implement ticket
> (`../optimystic/tickets/implement/optimystic-session-mode-commit-composition.md`)
> is left in place for optimystic's runner to reconcile (work is already done).

## What this was

The deferred-DML staging refactor made the vtab STAGE DML into collection
trackers (`Tree.stage`) and flush at commit via `TransactionBridge`. The
**legacy** path (`tree.sync()` per dirty tree) was covered; the
**session/consensus** path (`TransactionSession` → `TransactionCoordinator`) was
not, and the originating analysis showed it was wired so that a committed
session-mode transaction **silently dropped all staged DML**.

## Two bugs found and fixed (the second was not in the original analysis)

**Bug 1 — disjoint collections map (the ticket's premise).** `coordinator.commit()`
reads transforms from its OWN `collections` map, which was disjoint from the
`Collection` instances the vtab stages into ⇒ "Nothing to commit" ⇒ silent drop.
Fixed (Approach B): the bridge owns a **live `Map<CollectionId, Collection>`**
(`getCollectionRegistry()`); the vtab registers its main table + every index
tree into it as they initialize (`registerCollections()` in
`optimystic-module.ts`, at `doInitialize` and `addIndex`); a host builds the
`TransactionCoordinator` from that same live map. `Tree.getCollection()`
(db-core) exposes the underlying `Collection` cleanly (was reached via
`tree['collection']`). With this, PEND carries the staged transforms (verified).

**Bug 2 — coordinator.commit() never appended a log entry (deeper, discovered while testing).**
Unlike `coordinator.execute()`/`collection.sync()`, `commit()` pended raw
tracker transforms WITHOUT a fresh log entry. That only ever "worked" for a
collection's pristine first commit; it broke for any collection with prior
committed state — a **pre-synced index tree** ("Log tail block not found") and
any **second commit** ("Pend failed"). Fixed in `coordinator.ts`: `commit()` now
appends the log entry per collection from `collection.getPendingActions()` via
the existing `applyActionsToCollection`, then after consensus folds the
committed transforms into each collection's read cache
(`collection.applyCommittedToCache`) and clears pending — mirroring
`syncInternal`'s post-commit bookkeeping. New `Collection` methods:
`getPendingActions`, `clearPendingActions`, `applyCommittedToCache`.

**Rollback ownership.** In session mode the coordinator is the single owner of
tracker rollback (`session.rollback()`); the bridge's per-tree `tree.restore`
now runs **legacy-only** (`if (!this.session)` in `rollbackTransaction`). The
stale `fix/optimystic-session-mode-commit-composition` breadcrumb comment in
`txn-bridge.ts` was updated to reflect the corrected, tested state.

## Validation (run from ../optimystic)

- `yarn workspace @optimystic/db-core build` then full db-core suite:
  **533 passing**; `tsc --noEmit` clean. (db-core changed: coordinator.ts,
  collection.ts, tree.ts.)
- `yarn workspace @optimystic/quereus-plugin-optimystic build` then full suite:
  **212 passing, 5 pending**; `yarn workspace … typecheck` clean.
- New `test/session-mode-commit.spec.ts`: **7 passing, 1 pending** (the pending
  is the POSIX-only on-disk reopen test, see gaps).

## Test use cases (what the new spec asserts — the reviewer's floor, not ceiling)

Session/consensus driven through the REAL coordinator GATHER/PEND/COMMIT path on
the in-memory `test` transactor; durability checked by reading back through a
FRESH `Tree` on the same transactor (bypasses the vtab's tracker):
- insert-only across main + index commits durably (main rows + exact index entry
  count) — this is the direct silent-drop reproduction (0 vs N under the bug);
- insert+update+delete on indexed rows: main-table + index-routed-query
  correctness (NOT exact index count — see gap below);
- multiple sequential commits on the same collection (catches stale tracker /
  re-logged pending / stale read cache);
- deferred-CHECK rejection rolls back in session mode: no rows, no orphaned index
  entry (proves the deferred-constraint atomicity fix holds in session mode);
- explicit multi-statement `ROLLBACK` reverts.
- Unit gaps: `Tree.restore` is a safe no-op on never-staged + already-synced
  trees; the bridge registers the main table + each index collection.

## Honest gaps / things to scrutinize

- **db-core `coordinator.commit()` was rewritten** (consensus path). It is shared
  by `TransactionSession.commit()` generally. db-core's own 533 tests stay green,
  but the reviewer should sanity-check no regression to the `execute()` path,
  multi-session interleaved rollback, and that `applyCommittedToCache` +
  `clearPendingActions` semantics are correct (e.g. lingering pending across
  commits, the brand-new-collection initial-log-block case).
- **Index orphan on committed UPDATE/DELETE** — old secondary-index entries are
  left behind, **in BOTH legacy and session modes** (confirmed by running the
  identical multi-DML in legacy). Queries stay correct (index scan re-looks-up
  the main row and Quereus re-checks the predicate). Pre-existing + mode-
  independent ⇒ out of scope here; the spec therefore avoids asserting exact
  index counts for update/delete. Filed:
  `../optimystic/tickets/backlog/optimystic-index-orphan-on-update-delete.md`.
- **FileRawStorage colon on Windows** — db-core stamps ids `tx:`/`stamp:` and
  db-p2p-storage-fs writes `<actionId>.json`; the colon is an illegal Windows
  filename, so the consensus commit's pend→actions rename fails (EINVAL). POSIX
  is fine; legacy sync sidesteps it (base64url ids). The spec drives consensus
  over the in-memory `test` transactor and gates its single on-disk reopen test
  to `process.platform !== 'win32'` (hence the 1 pending on this Windows runner —
  it WILL run on POSIX CI). Filed:
  `../optimystic/tickets/backlog/optimystic-filestorage-colon-actionid-windows.md`.
- **Schema-hash re-entrancy** — `beginTransaction` awaits the schema-hash
  provider; `QuereusEngine.getSchemaHash()` lazily runs `select … from schema()`
  on the same db, which deadlocks if computed during an implicit BEGIN. The spec
  pre-warms the cache after DDL (the documented host contract). Filed:
  `../optimystic/tickets/backlog/optimystic-session-schemahash-reentrancy.md`.
- **Session mode is dormant** — no shipped code calls
  `TransactionBridge.configureTransactionMode()`. This fix makes it correct WHEN
  a host wires it (the test acts as that host); it does not itself wire Sereus
  into session mode. Sereus continues to run the bridge in legacy mode, which is
  unchanged.

## Suggested reviewer actions

- Read the coordinator.commit() diff against `execute()`/`applyActionsToCollection`
  and `syncInternal` to confirm the log-append + cache-fold + pending-clear
  matches the legacy/consensus contract.
- Re-run both suites from ../optimystic to confirm green on the reviewer's
  platform; on POSIX, confirm the on-disk reopen test (currently pending on
  Windows) passes.
- Decide whether any of the 3 backlog tickets should be promoted now (the index
  orphan is the most user-visible, though query results are unaffected).
