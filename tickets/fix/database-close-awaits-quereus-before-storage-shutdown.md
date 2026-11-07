description: ControlDatabase and StrandDatabase shut their storage down first and then start `db.close()` without awaiting it, so under Quereus 5.0.0 a statement still running can read or write storage that is already gone, and `close()` returns before Quereus has stopped.
architecture: docs/architecture.md
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-database.ts
repro: static
----
# Database close awaits Quereus before shutting storage down

## Why now

Quereus 5.0.0 changed `db.close()`: it stops running statements at their next row, stops open iterators, refuses queued work with `Database is closed`, and resolves only once nothing is reading or writing (`../quereus/docs/usage.md` § `db.close()`). Optimystic 1.26.0's notes give the order for a host: `await db.close()`, then dispose the plugin.

## What the code does

- `ControlDatabase.close()` (`control-database.ts`, near the end): awaits `writeQueue`, then `collectionFactory.shutdown()`, then `void this.db.close()`.
- `StrandDatabase.close()` (`strand-database.ts`): awaits `shutdownStrand()`, then `void this.db.close()`.

The `void` came in with the lint sweep `build-health-eslint` (commit `e402f6c3`), which marked an already-unawaited call; no ticket chose it. So a statement in flight when `close()` starts meets a shut-down collection factory, and `close()` resolves while Quereus is still unwinding it. Callers that close raw storage after `close()` (cadre-node stop, the edge node, the reference apps) can then close it under a running statement.

## Expected behaviour

`close()` resolves only after Quereus has stopped every statement and then storage has shut down: `await this.db.close()` before the collection-factory / strand shutdown, with the second `tableWatches.disposeAll()` and the membership-view invalidation kept after every await.

## Points to check

- **Called from inside a statement?** `await db.close()` from code running inside a statement never resolves (Quereus docs). Confirm no path reaches `ControlDatabase.close()` / `StrandDatabase.close()` from a module hook, a UDF or a commit hook. Table-change watch handlers are synchronous (`table-change-watch.ts`, `handleChange`), so a watch is not such a path, but an `onInvalidate` callback that ends in a stop would be.
- **A statement stuck in a network wait** reaches no row boundary until the call returns, so `close()` would wait on it. The existing `NOTE:` on `ControlDatabase.close()` already accepts waiting on a stuck write; decide whether the same holds for a strand read waiting on an unreachable cohort, and whether shutting the factory first is what currently unsticks such a wait. If it is, the fix may need an abort for in-flight collection work before `db.close()`, not a plain reorder.
- **Rejection.** Decide whether a rejected `db.close()` is logged or propagated; it must not be dropped silently.

## Test

A cadre-core spec per database: start a long read (an iterator left open, or a statement held at a row), call `close()`, and assert the statement fails with `Database is closed` and that storage shutdown runs only after it. Run the integration scenarios that stop and restart nodes (`strand-relay-only-restart-reconverges`, the offline-mode and quiesce/resume scenarios) to see that stops still finish.
