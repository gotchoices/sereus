description: Session/consensus-mode commit+rollback composition for the optimystic vtab deferred-DML staging refactor. Two bugs fixed — (1) the coordinator's collection map was disjoint from the vtab's staged collections ("Nothing to commit" → silent drop), fixed via a shared live registry (Approach B); (2) coordinator.commit() never appended a log entry, breaking any collection with prior committed state, fixed by mirroring execute()/syncInternal post-commit bookkeeping. Real-DML session-mode spec added (7 passing, 1 POSIX-only pending). Reviewed, independently validated, accepted with no new findings; 3 orthogonal pre-existing concerns already filed as optimystic backlog tickets.
prereq:
files: ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
----

# Session-mode commit/rollback composition (optimystic vtab) — COMPLETE

Implemented in the sibling `../optimystic` workspace and committed there by
optimystic's own tess runner (the shared working tree was swept mid-run, so the
changes landed bundled into optimystic commits `0db6d95` — tree/bridge/module/spec
— and `80930c5` — coordinator/collection/spec; the commit titles name unrelated
`cohort-topic` work, a filesystem-level race artifact, not logical coupling).
Sereus commit `c448fd5` carries only the implement→review ticket move. Reviewed
here against optimystic `HEAD`.

## What the change does

The deferred-DML staging refactor makes the vtab STAGE DML into collection
trackers (`Tree.stage` → `Collection.act`) and flush at commit. The **legacy**
flush path (`tree.sync()` per dirty tree) was covered; the **session/consensus**
path (`TransactionSession` → `TransactionCoordinator`) was not — and was wired so
that a committed session-mode transaction silently dropped all staged DML.

**Bug 1 — disjoint collection maps (the ticket premise).** `coordinator.commit()`
reads transforms from its OWN `collections` map, which was disjoint from the
`Collection` instances the vtab stages into ⇒ "Nothing to commit" ⇒ silent drop.
Fixed (Approach B): the bridge owns a **live `Map<CollectionId, Collection>`**
(`getCollectionRegistry()`); the vtab registers its main table + every index tree
as they initialize (`registerCollections()` at `doInitialize`, and per-index in
`addIndex`); a host builds the coordinator from that same live map. `Tree.getCollection()`
exposes the underlying `Collection` cleanly (replacing `tree['collection']`).

**Bug 2 — coordinator.commit() never appended a log entry (deeper; found while testing).**
Unlike `execute()`/`syncInternal`, `commit()` pended raw tracker transforms
WITHOUT a fresh log entry. That only worked for a collection's pristine first
commit; it broke for any collection with prior committed state — a pre-synced
index tree ("Log tail block not found") and any second commit ("Pend failed").
Fixed in `coordinator.ts`: `commit()` now appends each collection's log entry from
`getPendingActions()` via the existing `applyActionsToCollection`, then post-consensus
folds committed transforms into each collection's read cache (`applyCommittedToCache`)
and clears pending — mirroring `syncInternal`'s post-commit bookkeeping. New
`Collection` methods: `getPendingActions`, `clearPendingActions`, `applyCommittedToCache`.

**Rollback ownership.** In session mode the coordinator is the single owner of
tracker rollback (`session.rollback()` → `coordinator.rollback()`); the bridge's
per-tree `tree.restore` now runs **legacy-only** (`if (!this.session)` in
`rollbackTransaction`), avoiding a double-restore that would clobber the
coordinator's interleaved-session replay.

## Review findings

Adversarial pass over the implement diff (read first, before the handoff), every
file the change touches, and the paths it *should* touch. Build + typecheck + full
test suites run on this Windows runner.

### Validation (run from ../optimystic, this runner)
- **db-core:** `yarn build` clean (exit 0); full suite **534 passing** (handoff
  cited 533 — one extra is the concurrently-landed cohort-topic test, not this work).
- **plugin:** `yarn build` + `yarn typecheck` clean; full suite **212 passing, 5
  pending** — includes the legacy-mode rollback specs (deferred-constraint-rollback,
  index-support), confirming the `if (!this.session)` guard did **not** regress
  legacy rollback.
- **New `test/session-mode-commit.spec.ts`: 7 passing, 1 pending** (the pending is
  the POSIX-only on-disk reopen test, correctly gated `process.platform !== 'win32'`).
- **Lint:** optimystic has no lint gate (root `lint` is a no-op; neither db-core
  nor the plugin defines a lint script). The Sereus ESLint gate does not cover
  `../optimystic`. So no lint to run — stated explicitly rather than silently skipped.

### Correctness — verified, no findings
- **coordinator.commit() vs execute()/syncInternal.** Read the rewritten `commit()`
  against `applyActionsToCollection` and `syncInternal`. Log-append + cache-fold +
  pending-clear matches the legacy/consensus contract. Rev computation is consistent
  across `applyActionsToCollection`, `pendPhase`, `commitPhase`, and the post-commit
  `actionContext` advance (all read `(actionContext?.rev ?? 0) + 1` while
  actionContext is advanced only after consensus) — identical to `execute()`.
- **Cache-before-reset ordering is safe.** `CacheSource.transformCache` deep-copies
  inserts and applies updates only to already-cached blocks, retaining no reference
  to the passed transforms; `Tracker.reset` replaces (not mutates) the transforms
  object. So `applyCommittedToCache` then `tracker.reset()` cannot corrupt the
  cache — and reset returns the old object, so the captured reference is valid
  regardless of order. The comment's "order matters" caution is conservative but
  harmless.
- **execute() path not regressed.** `execute()` is untouched; only `commit()`
  changed and `Collection` gained three additive methods. db-core's 534 tests
  (which exercise `execute()`) stay green.
- **Rollback actually works (handoff asserted it; I traced *why*).** The vtab DML
  path stages via `tree.stage` and forwards only EMPTY actions to the session
  (`addStatement` → `void session.execute(stmt, [])`). The coordinator's rollback
  snapshot is taken inside `applyActions([], stampId)` — and its snapshot portion
  (`structuredClone` of every registered collection's `tracker.transforms`) runs
  **synchronously**, before the first await, during the `addStatement` call at
  `update()` line 718 — i.e. BEFORE `markDirtyTrees`/`stage` at lines 735-738. So
  the pre-snapshot is genuinely pre-stage and clean, covering main + all index
  collections in the registry. `applyActions` snapshots only on the first call per
  stampId, so a multi-statement transaction correctly rolls back to its starting
  state. The deferred-CHECK and explicit-ROLLBACK specs confirm this observationally
  (no rows, no orphaned index entry); my trace confirms it is not passing for the
  wrong reason (e.g. read-time re-sync masking an un-reverted tracker).
- **Sereus impact: none.** Sereus references none of the changed/new APIs
  (`configureTransactionMode`, `getCollectionRegistry`, `registerCollection`,
  `getPendingActions`, `applyCommittedToCache`, `TransactionCoordinator`) — verified
  by grep over `packages`. Session mode is dormant (no shipped code wires it); Sereus
  runs the bridge in legacy mode, which is unchanged. Changes are purely additive
  (no signatures removed/altered), so no Sereus build/type break is possible — full
  Sereus suite deliberately not re-run (it would only exercise unrelated code).

### Test coverage assessment — adequate for the fix
The new spec drives the REAL coordinator GATHER/PEND/COMMIT path over the in-memory
`test` transactor and verifies durability by reading through a FRESH `Tree` on the
same transactor (bypassing the committing tracker — a legitimate persistence proof
even with the on-disk reopen test gated off on Windows). Covers: insert-only across
main+index with exact durable counts (the direct silent-drop repro: 0 vs N under the
bug); insert+update+delete query correctness; multiple sequential commits on one
collection (stale-tracker / re-logged-pending / stale-cache regression); deferred-CHECK
rejection rollback in session mode; explicit multi-statement ROLLBACK; plus unit gaps
(`Tree.restore` no-op on never-staged/already-synced trees, registry registration of
main + each index). Happy path, edge, error, regression, and main↔index interaction
are all represented. No additional cases warranted at this layer.

### Minor observations — not actioned (justified)
- **tree.ts `getCollection` body indentation** (3 tabs vs the file's nominal 2) —
  matches the adjacent `restore()` method's existing indentation, optimystic has no
  lint gate, and the file is in a sibling repo already committed by optimystic's
  runner (a Sereus-side edit would be orphaned). Cosmetic; left as-is.
- **`void session.execute(stmt, [])` swallows any rejection** — pre-existing
  fire-and-forget pattern, not introduced here, and `applyActions([])` cannot
  meaningfully fail. Out of scope.

### Deferred concerns — already filed as optimystic backlog tickets (verified present)
- `../optimystic/tickets/backlog/optimystic-index-orphan-on-update-delete.md` —
  committed UPDATE/DELETE leave stale secondary-index entries in BOTH legacy and
  session modes (mode-independent, pre-existing). Queries stay correct (index scan
  re-looks-up the main row and Quereus re-checks the predicate); the spec therefore
  avoids asserting exact index counts for update/delete. Most user-visible of the
  three; a candidate for promotion.
- `../optimystic/tickets/backlog/optimystic-filestorage-colon-actionid-windows.md` —
  db-core stamps `tx:`/`stamp:` ids and db-p2p-storage-fs writes `<actionId>.json`;
  the colon is an illegal Windows filename (EINVAL on the consensus pend→actions
  rename). POSIX-safe; the on-disk reopen test is gated to non-win32 (the single
  Windows-pending in the new spec — it WILL run on POSIX CI).
- `../optimystic/tickets/backlog/optimystic-session-schemahash-reentrancy.md` —
  `beginTransaction` awaits the schema-hash provider; `getSchemaHash()` lazily runs
  `select … from schema()` on the same db, deadlocking if computed during an implicit
  BEGIN. The spec pre-warms the cache after DDL (the documented host contract).

### Empty categories (stated, not silent)
- **No MAJOR findings** ⇒ no new fix/plan tickets spawned by this review.
- **No minor findings fixed in-pass** — the only minor observations are cosmetic/
  pre-existing and live in the sibling optimystic repo, where a Sereus-runner edit
  would not be committed; documented above instead.
- **No docs out of date** — the change is internal to optimystic's transaction
  layer; no Sereus `docs/` describe the optimystic coordinator commit/rollback
  internals, and the optimystic-side code comments (bridge, coordinator, collection,
  spec header) were updated to reflect the corrected, tested state (read and verified).

## Disposition

Accepted. The two bugs are fixed and validated; the session/consensus commit+rollback
path now correctly persists and reverts staged DML across main + index collections.
Session mode remains dormant (unwired in shipped code); this makes it correct WHEN a
host wires it. The three deferred concerns are orthogonal, pre-existing, and tracked
as optimystic backlog tickets. The optimystic-side implement ticket is left in place
for optimystic's runner to reconcile (work already landed).
