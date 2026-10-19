description: Give cadre-core one way to be told that a table changed, in the control database or a strand database, whether the change was committed on this machine or replicated in from another, so the idle pollers can wait for a change instead of re-reading on a timer (GitHub #50).
architecture: docs/architecture.md#control-network-convergence
files: packages/cadre-core/src/control-database.ts (`setMembershipChangeListener`, `notifyMembershipChanged` ~3845, the write-lock notes ~1481 and ~1746, `close`), packages/cadre-core/src/strand-database.ts (`getDatabase`, `close`), a new small module beside them (e.g. packages/cadre-core/src/table-change-watch.ts), ../quereus/packages/quereus/src/core/database.ts (`watch` ~2838, `notifyExternalChange` ~2897, read only), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (`notifyExternalChange` call ~1183, read only), ../optimystic/packages/db-p2p/src/storage/storage-repo.ts (`emitCollectionChanges` ~338, read only)
----
# One change-subscription seam for control and strand tables

## Why

Every idle poller in cadre-core re-reads tables on a fixed timer to learn whether something changed (GitHub #50; the consumers are `strand-watcher-woken-by-control-changes`, `control-reconcile-woken-by-changes-reads-once`, `pending-join-runner-woken-by-changes` and `strand-revocation-enforcer-woken-by-membership-changes`). The change they wait for is always a commit to a known table. Quereus already delivers that as an event, and Optimystic already raises it for replicated commits, so nothing upstream is missing.

What exists today, read at Quereus 4.20.3 and Optimystic 1.15.0 plus main:

- `Database.watch(scope, handler)` fires once per commit that touches the scope, after the commit. The committing call waits for the handler (`database-transaction.ts` ~287-294). Scopes are per table (`full`), or narrower via `Statement.getChangeScope(params)`.
- The Optimystic plugin calls `db.notifyExternalChange(table)` whenever this node's storage moves a collection's block forward (`StorageRepo.emitCollectionChanges`). That covers a consensus commit this node took part in as a cohort member (a commit made on another machine), a block-transfer push such as join backfill, and a read-repair landing. `watch` hears these. `onDataChange` and `onTransactionCommit` do not, because the plugin emits no row events.
- Every machine of a cadre of 16 or fewer is in every control block's cohort (`CONTROL_REPLICATION_BREADTH`), so it hears every control commit. On a strand (cluster size 4) both members of a two-party strand are in every block's cohort.
- `ControlDatabase.setMembershipChangeListener` exists, but it fires only for this machine's own writes. Replicated membership changes are picked up only by the 15 s reconcile pass, as its comment says.

## Design

A small helper that every poller uses, so there is one place that knows the delivery rules:

- `watchTables(db, tables, onChange, opts)` subscribes a `full` scope per named table and returns a disposer. Handlers never do work inline. They mark the subscription dirty and schedule one run of `onChange` (coalesced, single-flight, debounced by `opts.debounceMs`, default a few tens of ms). A run that is in flight when another change lands is followed by exactly one more run.
- `ControlDatabase.watchTables(tables, onChange)` and the strand equivalent wrap it with the right `Database` and dispose on `close()`. Quereus does not release watch subscriptions on `Database.close()` (it only logs), so the wrappers own disposal.
- Once this lands, decide whether the existing membership listener should become a subscriber on `CadrePeer` (it would then also hear replicated changes). Do that only if it removes a code path; `control-reconcile-woken-by-changes-reads-once` is the consumer that cares.

## Settled choices

- **Table-wide events, not row events.** Quereus delivers per-table invalidation for external changes; `changedKeys` is listed as future work upstream (`docs/change-scope.md` ~461). Every consumer here re-reads a small table anyway, so table granularity is enough.
- **No cohort-topic for the control database.** Optimystic's network reactivity costs one renewal and one tail read per watched collection every 30 s and tells a cohort member nothing its own storage events don't. It stays a strand option (`strand-reactivity.ts`).

## Edge cases & interactions

- **Handler under a lock.** `watch` handlers run inside the committing call, and some control writes notify with the control write lock held (comments at `control-database.ts` ~1481, ~1746). A handler that reads or writes inline would deadlock or serialize behind the lock. The helper must only schedule. Verify by inspection plus an assertion that the handler returns synchronously.
- **One local commit fires twice** (Quereus's own post-commit plus the plugin's storage event). The debounce must collapse it. Verify by the unit test below.
- **A change during `close()`.** A run scheduled after dispose must not start. Verify by inspection and in the unit test.
- **A machine outside the block's cohort** (a cadre larger than 16, a strand larger than its cluster size) learns of changes only on its next read. Consumers keep a long backstop timer for that, and for a replicated block that lands without a storage event. Each consumer ticket sets its own backstop.
- **Hibernation.** A hibernated strand has no `Database`; the strand wrapper must be re-subscribed on wake. Verify in `strand-revocation-enforcer-woken-by-membership-changes`, which owns the strand consumer.
- **Cross-platform.** Plain timers and promises, no Node-only APIs.

## Tests

One unit test over the helper with a real in-memory Quereus database: two commits in quick succession produce one run; a commit during a run produces exactly one follow-up run; nothing runs after dispose. That pins the scheduling contract every consumer relies on. Do not test that Optimystic raises replicated events; that is upstream's contract, and `message-cost-accounting`'s scenario exercises it end to end.

## TODO

- Read the cited Quereus and plugin sites and confirm the delivery rules above against the linked versions.
- Write the helper and the two wrappers; dispose on close.
- Decide (and record in the implement ticket) whether `setMembershipChangeListener` folds into it.
- Add the unit test.
- Document the seam in docs/architecture.md under "Control Network Convergence" (one short subsection: what it hears, what it does not, why consumers keep a backstop).
