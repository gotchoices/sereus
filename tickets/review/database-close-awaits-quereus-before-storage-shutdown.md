description: Closing a control or strand database now stops the query engine and waits for it before shutting storage down, so a query still running at close can no longer touch storage that is already gone, and close no longer returns while the engine is still stopping.
architecture: docs/architecture.md
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-database.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/cadre-core/test/control-database-close.spec.ts
----
# Database close awaits Quereus before storage shutdown (review handoff)

## What changed

- `ControlDatabase.close()` (`control-database.ts`, end of class): `disposeAll()`, `await writeQueue`, then `await this.db.close()` (a rejection is logged with the file's `log` and teardown continues), then `collectionFactory.shutdown()` (which stops the control node), null `txnBridge`, `disposeAll()` again, `invalidateMembershipViews()`, then `this.db = null`, `initialized = false`. The doc comment now describes the order and why the handle stays set; the `NOTE:` now also covers a statement stuck in a network wait (bounded by Optimystic's RPC deadlines), with the revisit condition "abort in-flight collection work before closing Quereus, if node stops show up slow".
- `StrandDatabase.close()` (`strand-database.ts`): the synchronous listener/report releases as before, `disposeAll()`, `await this.db.close()` (rejection logged, teardown continues), then `shutdownStrand()`, `disposeAll()` again, then null `db`, `resolvedTransactor`, `initialized`. Doc comment updated; two `NOTE:`s added — the network-wait tripwire, and the finding below about durability reports.
- `compose-strand.ts`: the `NOTE:` in `releaseOptimysticPlugin` now says cadre-core closes the `Database` before releasing and the follower leak remains only for a host that releases first. The `NOTE:` in `shutdown()` about a running deferred sApp schema apply now says that with a close-first host (cadre-core) the apply is stopped by the close and settles `failed`, and the old `cancelled` path applies only to a host that does not close first. Comment-only; package rebuilt so the stale-build guard passes.

`this.db` is deliberately kept set until after every await, so a concurrent second `close()` (as `StrandInstanceManager.buildStrandRuntime` does after a stop released the runtime mid-`initialize()`) gets Quereus's latched close promise and waits for the same teardown, instead of skipping straight to storage shutdown. Both storage shutdowns may then run twice; the strand one is latched in `compose-strand.ts`, and the control one is `CollectionFactory.shutdown()`, whose second concurrent call finds libp2p already `stopping` (no-op) — the control path is only ever closed once, from `CadreNode` stop, so this is theoretical there.

## Finding: durability reports are raised inside the committing statement

The fix ticket asked to confirm that `strand:commit-durability` / `strand:commit-held` are raised outside the committing statement. They are not: Optimystic's `TransactionBridge.commitTransaction` calls `reportCommitDurability` synchronously at the end of the commit (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`, after `endTransaction()`), and cadre-core's `StrandCommitRecord.forward` and `CadreNode.emit` deliver synchronously. But no layer awaits a listener's return value, so an app handler that starts `stopStrand` cannot make the statement wait for `close()`; no deadlock. Recorded as a `NOTE:` on `StrandDatabase.close()` with the condition that would break it (a delivery path that awaits its listeners).

## Test added

- `packages/cadre-core/test/control-database-close.spec.ts` — builds a real `ControlDatabase` on `createControlNode`, seats an owner key, opens an iterator over `CadreControl.OwnerKey` and pulls one row, spies on Quereus's `close()` (to flag when its promise resolves) and on the test's own node `stop()` (to record that flag when the collection factory stops the node), then calls `controlDb.close()`. Asserts Quereus's close had resolved by the time `controlDb.close()` resolved, had resolved before the node was stopped, and the open iterator's next `next()` rejects with `Database is closed`. Confirmed failing on the old code (`quereusClosed` false at `close()` resolution) and passing after.

No `StrandDatabase` spec: the solo-strand harness goes through a full `CadreNode`, and a direct `StrandDatabase` build would need its own libp2p node scaffolding; the ticket allowed skipping it, and the two methods changed the same way. A reviewer who wants the strand arm pinned could add it to the same file with `createLibp2pNode` and `new StrandDatabase({ strandId, strandType: 'o', libp2pNode, coordinatedRepo })` — the only assertion available is that Quereus's close has resolved when `strandDb.close()` resolves.

## Validation run

- `yarn workspace @serfab/cadre-core test` — 197 files, 2621 passed, 1 skipped (pre-existing).
- `yarn lint` — clean.
- Integration scenarios, one file at a time: `strand-relay-only-restart-reconverges` (2 passed, 2 skipped — env-gated `runIf` arms), `strand-offline-queue-survives-restart`, `strand-offline-waits-for-party-machine` (4), `control-members-restarted-together`, `control-offline-read-after-restart`, `pending-join-survives-restart` — all passed, durations in line with their budgets (each file 15–55 s wall clock).
- `@serfab/quereus-plugin-sereus` tests not run: its change is comments only.

## For the reviewer

- During the awaits in `ControlDatabase.close()`, `initialized` and `db` are still set, so a background caller (e.g. the reconcile pass's `reapRevokedRows`, whose per-row guard checks `!this.initialized || !this.db`) keeps going and each of its statements now fails with `Database is closed` (logged per row and continued) rather than running against a factory being shut down. The same window existed before the change (both fields stayed set across the factory shutdown await). Judge whether a `closing` flag is worth adding; I did not add one.
- A deferred sApp schema apply caught mid-apply by the close now settles `failed` and logs "Deferred sApp schema apply failed" instead of `cancelled`; `StrandDatabase.close()` releases `appSchemaReport` before either, so nothing hears it. No listener found that does.
