description: When a control or strand database closes, it shuts its storage down first and only then starts closing the query engine, without waiting for it. A query still running can then touch storage that is already gone, and close returns before the engine has stopped. Close the engine first, wait for it, then shut storage down.
architecture: docs/architecture.md
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-database.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts
repro: static
----
# Database close awaits Quereus before shutting storage down

## The defect

Quereus 5.0.0's `db.close()` stops running statements at their next row, stops open iterators, refuses queued work with `Database is closed`, and resolves only once nothing is reading or writing (`../quereus/docs/usage.md` § `db.close()`; implementation `../quereus/packages/quereus/src/core/database.ts`, `closeAfterRunningWork`). Optimystic's collection factory says to dispose it *after* `db.close()` (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`, doc on `dispose()`), and Optimystic 1.26.0's notes give the host order as `await db.close()`, then dispose the plugin.

Both cadre-core databases do the reverse and do not wait:

- `ControlDatabase.close()` (`control-database.ts`, near line 6083): `tableWatches.disposeAll()`, `await writeQueue`, `await collectionFactory.shutdown()`, then `void this.db.close()`.
- `StrandDatabase.close()` (`strand-database.ts`, near line 459): releases listeners and reports, `tableWatches.disposeAll()`, `await shutdownStrand()`, then `void this.db.close()`.

The `void` was added by the lint sweep (commit `e402f6c3`) to mark a call that was already unawaited; nothing chose it. So a statement in flight when `close()` starts runs against a shut-down collection factory, and `close()` resolves while Quereus is still unwinding it. Callers that close raw storage or stop libp2p after `close()` (`CadreNode` stop, `StrandInstanceManager.releaseRuntime`, the edge node, the reference apps) can then do so under a running statement.

`packages/quereus-plugin-sereus/src/compose-strand.ts` (`releaseOptimysticPlugin`) already carries a `NOTE:` saying a write begun on the `Database` after the plugin is released re-subscribes the transaction bridge's follower and leaks, "close the `Database` before releasing" — this fix is that.

## Required behaviour

`close()` on either database resolves only after Quereus has stopped every statement and torn down, and only then shuts storage down:

- **ControlDatabase:** `disposeAll()`; `await writeQueue`; `await db.close()`; `await collectionFactory.shutdown()`; null `txnBridge`; `disposeAll()` again; `invalidateMembershipViews()`; null `db`; `initialized = false`. The second `disposeAll()` and the membership-view invalidation stay after every await (a read started during the awaits must not install a view; a subscription taken during them must not keep its timers).
- **StrandDatabase:** the synchronous releases as now; `disposeAll()`; `await db.close()`; `await shutdownStrand()`; `disposeAll()` again; null `db`, `resolvedTransactor`, `initialized`.
- **Keep `this.db` set until after the awaits.** Quereus latches `close()` (a second call returns the first call's promise), so a second, concurrent `close()` on the same instance awaits the same teardown and then reaches the factory/strand shutdown, which is already safe to run twice (`compose-strand.ts` latches `shutdown()`; the control path nulls `collectionFactory` after its await as now). A concurrent second close does happen: `StrandInstanceManager.buildStrandRuntime` closes a `StrandDatabase` again after `initialize()` when a stop released the runtime through its gate part-way (`strand-instance-manager.ts` near line 1284). Nulling `this.db` before the await would let that second call skip straight to storage shutdown while the first is still waiting for Quereus.
- **A rejected `db.close()` is logged, not propagated, and the teardown continues** (storage shutdown and the rest still run). Propagating would skip the steps callers run after `close()`: `CadreNode` stop would not stop the control node, `releaseRuntime` would not stop the strand's libp2p node. Use the file's `log` with the error; do not swallow it silently (AGENTS.md).

## Points already checked (fix stage)

- **Called from inside a statement?** `await db.close()` from code running inside a statement never resolves. No cadre-core path found: `ControlDatabase.close()` is called only from `CadreNode` stop; `StrandDatabase.close()` from `StrandInstanceManager` (`buildStrandRuntime`, `discardDatabaseAttempt`, `releaseRuntime`), reached from stop, quiesce (hibernate timer, wake window, failed-resume cleanup), `stopAll`, and `forgetJoinedStrand`. Table-change watch handlers only set flags and arm timers (`table-change-watch.ts` module doc), and `onInvalidate` hooks only invalidate caches; consumers' `onChange` runs execute outside any statement. An open iterator held by a run that then triggers a stop does not deadlock: Quereus stops abandoned iterators without waiting for them to be pulled. The only remaining route is application code: a handler for `strand:commit-durability` / `strand:commit-held` (forwarded by `strand-commit-durability.ts`) that calls `stopStrand`. Confirm the plugin raises those reports outside the committing statement (Optimystic's durability follower, not a commit hook); if it does not, note it as a `NOTE:` on `StrandDatabase.close()`.
- **Statement stuck in a network wait.** It reaches no row boundary until its network call returns, so `close()` now waits for it. Those calls are bounded by Optimystic's RPC deadlines (`../optimystic/packages/db-p2p/src/rpc-deadline.ts`: response 10 s, transaction 30 s).
  - *Strand:* `shutdownStrand` with cadre-core's injected node only calls `collectionFactory.dispose()` (clears transactors, closes network watches, releases cache leases); it aborts no in-flight request, so shutting it down first never unstuck a strand read. No change in what can be stuck; `close()` simply now waits up to the deadline instead of returning early.
  - *Control:* `collectionFactory.shutdown()` stops the control libp2p node registered through `registerLibp2pNode`, which does fail an in-flight control network call at once. After the reorder a control read waiting on the network holds `close()` up to its deadline. Control reads normally answer from the local replica (`cost_profile: 'localDisk'`, every member holds every block), so this is rare. Decision: plain reorder, no abort plumbing. Extend the existing `NOTE:` on `ControlDatabase.close()` (which already accepts waiting on a stuck write) to say it also waits on a statement in a network wait, bounded by the RPC deadlines, and to revisit (abort in-flight collection work before `db.close()`) if node stops show up slow. Put the same tripwire on `StrandDatabase.close()`.
- **Interrupting a statement mid-`initialize()`** is not new: `void db.close()` already aborted running statements synchronously under Quereus 5.0.0. The reorder changes only ordering and waiting.
- **Deferred sApp schema apply** (`quereus-plugin-sereus/src/app-schema.ts`, `retryDeferredAppSchema`): `released` is aborted inside `shutdownStrand`, which now runs after `db.close()`. An apply caught mid-`apply schema` by the close therefore settles `failed` (logged as "Deferred sApp schema apply failed") rather than `cancelled`. Nothing hears it — `StrandDatabase.close()` releases `appSchemaReport` before either — so the only effect is the log line. Acceptable; no change needed unless the implementer finds a listener that does hear it.

## Test

One reproduction spec for `ControlDatabase`, at the lowest layer, beside `control-database-strand-peer.spec.ts` (which already builds a real `ControlDatabase` on `createControlNode` from `control-db-node-helpers.ts`): initialize, open an iterator on `getDatabase()` over a control table and pull one row, wrap the injected node's `stop` (the collection factory's `shutdown()` stops it) to record whether Quereus's `close()` promise had resolved by then, call `controlDb.close()`, and assert: the iterator's next `next()` rejects with `Database is closed`, Quereus's close had resolved before the node was stopped, and Quereus's close has resolved when `controlDb.close()` resolves. Spying on the Quereus `Database` and the test's own libp2p node is fine; do not mock a cadre-core module. Fails on the current code (node stopped before Quereus closes).

A `StrandDatabase` spec only if the solo-strand harness (`strand-solo-write-budget.spec.ts`) makes one cheap; its storage shutdown has no node stop to observe, so the assertion there is only that Quereus's close has resolved when `strandDb.close()` resolves. Skip it if it needs new scaffolding — the two methods change the same way.

Then run the integration scenarios that stop and restart nodes, to see stops still finish and do not slow past their budgets: `strand-relay-only-restart-reconverges`, `strand-offline-queue-survives-restart`, `strand-offline-waits-for-party-machine`, `control-members-restarted-together`, `control-offline-read-after-restart`, `pending-join-survives-restart` (all in `packages/integration-tests/src/scenarios/`; run one file at a time with `yarn workspace @serfab/integration-tests test <file>` in the foreground). Run the cadre-core suite and `yarn lint`.

## TODO

- Reorder `ControlDatabase.close()`: `await this.db.close()` (rejection logged, teardown continues) before `collectionFactory.shutdown()`; keep `this.db` set until the end; update its doc comment and extend its `NOTE:` to cover a statement in a network wait.
- Reorder `StrandDatabase.close()` the same way before `shutdownStrand()`; update its doc comment ("runs the strand-connection shutdown … then closes the `Database`") and add the same `NOTE:`.
- Reword the `NOTE:` in `compose-strand.ts` `releaseOptimysticPlugin` so it says cadre-core closes the `Database` before releasing, and the leak it describes remains only for a host that does not.
- Confirm the durability/held reports are raised outside the committing statement (see "Called from inside a statement?").
- Add the `ControlDatabase` reproduction spec; confirm it fails before the change and passes after. Add the `StrandDatabase` one only if cheap.
- Run cadre-core tests, the listed integration scenarios, and `yarn lint`.
