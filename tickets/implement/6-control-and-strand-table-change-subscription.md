description: Give cadre-core one way to be told that a table changed, in the control database or a strand database, whether the change was committed on this machine or replicated in from another, so the idle pollers can wait for a change instead of re-reading on a timer (GitHub #50).
architecture: docs/architecture.md#control-network-convergence
files: packages/cadre-core/src/table-change-watch.ts (new), packages/cadre-core/src/control-database.ts (`close` ~5127, listener setters ~3604, `notifyMembershipChanged` ~3845), packages/cadre-core/src/strand-database.ts (`getDatabase` ~264, `close` ~300), packages/cadre-core/src/timeout-scheduler.ts (reused timer seam), packages/cadre-core/src/index.ts (export, if the strand consumers outside cadre-core need it), packages/cadre-core/test/table-change-watch.spec.ts (new), docs/architecture.md ("Control Network Convergence"), ../quereus/packages/quereus/src/core/database.ts (`watch` ~2838, `notifyExternalChange` ~2897, `close` ~1483; read only), ../quereus/packages/quereus/src/core/database-watchers.ts (read only), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (`ensureChangeSubscription` ~1146, called from `doInitialize` ~982; read only)
----
# One change-subscription seam for control and strand tables

## Why

Every idle poller in cadre-core re-reads tables on a fixed timer to learn whether something changed (GitHub #50). Its consumers are the plan tickets `strand-watcher-woken-by-control-changes`, `control-reconcile-woken-by-changes-reads-once`, `pending-join-runner-woken-by-changes`, `strand-revocation-enforcer-woken-by-membership-changes`, and `control-membership-rows-cached-until-changed` (which needs a synchronous per-table invalidation, see `onInvalidate` below). This ticket builds only the seam and its two wrappers; it changes no poller.

## Delivery rules (confirmed against the linked Quereus and Optimystic sources)

- `Database.watch(scope, handler)` (Quereus `core/database.ts` ~2838) fires once per commit that touches the scope, after the commit, from inside the committing call. A handler that returns a promise is awaited before the commit call returns (`database-transaction.ts` ~287-294, `database-watchers.ts` `runPostCommit`). Handler errors are logged and swallowed. `watch` throws synchronously when a named table does not exist.
- A `full` scope for a table is a plain literal; no builder is exported for it: `{ watches: [{ table: { schema, table }, columns: 'all', scope: { kind: 'full' } }], nonDeterministicSources: [], unboundParameters: [] }`. Table matching is on the lowercased `schema.table`. `ChangeScope`, `WatchEvent` and `Subscription` are exported types from `@quereus/quereus`.
- The Optimystic plugin calls `db.notifyExternalChange(table, schema)` whenever this node's storage moves that table's collection forward (`StorageRepo.emitCollectionChanges`): a consensus commit this node took part in as a cohort member (a commit made on another machine), a block-transfer push such as join backfill, a read-repair landing, and this node's own commits. `watch` hears it as a whole-table change. `onDataChange` and `onTransactionCommit` do not.
- **The plugin arms that storage bridge per table, on the table's first full initialization on that `Database`** (`ensureChangeSubscription`, called at the end of `doInitialize`). A table this `Database` has never touched hears nothing replicated. A first touch from a committed read while a writer transaction is open does a provisional initialization that skips the bridge; the next touch upgrades it. Consumers all run once at start, which touches their tables; that is what arms the bridge. The seam does not touch tables itself (a touch on a never-written collection is a network consult, which is what #50 is removing).
- One local commit fires the watch twice: Quereus's own post-commit dispatch and the plugin's storage event.
- `Database.close()` does dispose every watch subscription (`watcherManager.dispose()` at ~1519). The plan ticket said otherwise; that was wrong at Quereus 4.20.3. But both wrappers call `void this.db.close()`, and the disposal happens only after `close()`'s own awaits, so the wrappers still dispose their handles themselves, synchronously, at the top of their `close()`.
- Every machine of a cadre of 16 or fewer is in every control block's cohort (`CONTROL_REPLICATION_BREADTH`); on a strand (cluster size 4) both members of a two-party strand are in every block's cohort. Outside those, a machine hears a replicated change only on its next read. That is why consumers keep a backstop (below).

## Design

New module `packages/cadre-core/src/table-change-watch.ts`:

```ts
export interface TableChangeWatchOptions {
	/** Short label for log lines (e.g. 'strand-watcher'). */
	label: string;
	/** Coalescing window after the first change; default TABLE_CHANGE_COALESCE_MS (50). */
	coalesceMs?: number;
	/**
	 * Run anyway this long after the last run settled, change or not. Omit for none.
	 * The path for a change that arrives without a storage event (see delivery rules).
	 */
	backstopMs?: number;
	/**
	 * Called inline, synchronously, from the watch handler — inside the committing call,
	 * possibly with the control write lock held — once per changed table per event.
	 * Only for setting a flag (cache invalidation). Must not read, write or await.
	 */
	onInvalidate?: (qualifiedTable: string) => void;
	/** Timer seam; default real, unref'd timers. */
	scheduler?: TimeoutScheduler;
}

export interface TableChangeWatch {
	/** Schedule a run after `delayMs` (default 0) through the same single-flight rule; an earlier pending run wins. */
	trigger(delayMs?: number): void;
	/** Stop: unsubscribe, clear timers; no run starts afterwards. Idempotent. Does not wait for a run in flight. */
	dispose(): void;
}

export function watchTables(
	db: Database,
	tables: readonly string[],          // qualified 'Schema.Table', e.g. 'CadreControl.Strand', 'Strand.Member'
	onChange: () => Promise<void>,
	options: TableChangeWatchOptions,
): TableChangeWatch;
```

Scheduling contract (this is what the unit test pins):

- Subscribes one `full` scope per table (or one scope with one watch per table; either is fine). Splits each name on its single `.`; a name without one throws.
- The watch handler is a synchronous function returning `undefined`, so Quereus never awaits consumer work inside a commit. It calls `onInvalidate` for each matched table (from `event.matched[].watch.table`), marks the watch dirty, and arms the coalescing timer if none is armed. A later change inside the window joins it and does not extend it (a steady stream of changes cannot starve the run).
- When the timer fires: if a run is in flight, do nothing now; when that run settles, if dirty, arm the coalescing timer again. Otherwise clear dirty and start `onChange()`. At most one run in flight; a change during a run produces exactly one follow-up run.
- A rejected `onChange` is logged (`debug('sereus:cadre:table-watch')`, label included) and counts as a settled run. Consumers that want a failure ladder call `trigger(backoffMs)` from their own catch.
- `backstopMs`, when set, is re-armed each time a run settles (and once at subscribe), and fires `trigger(0)`.
- After `dispose()`, the handler ignores events, timers are cleared, and a run that settles does not schedule another.
- If `onInvalidate` returns a thenable, log it once per watch as a misuse (the result is never awaited). That is the seam's assertion that nothing slow runs inside a commit.
- Plain `setTimeout`-style timers through `TimeoutScheduler` and promises only; no Node-only APIs.

Wrappers:

- `ControlDatabase.watchTables(tables, onChange, options)`: calls `watchTables(this.db!, …)` after `ensureInitialized()`, keeps the handle in a private `Set`, and wraps `dispose` to remove it. `close()` disposes every handle before its `await this.writeQueue`, so a commit that drains the write queue during close schedules nothing.
- `StrandDatabase.watchTables(tables, onChange, options)`: same shape, disposed at the top of `close()` next to `unsubscribeCommits`. A hibernated strand's `StrandDatabase` is closed and a new one built on wake; re-subscribing is the consumer's job (`strand-revocation-enforcer-woken-by-membership-changes` owns that).

## Settled choices

- **Table-wide events, not row events.** Quereus delivers whole-table invalidation for external changes; row-level `changedKeys` is future work upstream (`docs/change-scope.md` ~461). Every consumer re-reads a small table anyway.
- **No cohort-topic network watch for the control database.** Optimystic's network reactivity costs one renewal and one tail read per watched collection every 30 s and tells a cohort member nothing its own storage events don't. It stays a strand option (`strand-reactivity.ts`).
- **The seam owns the backstop timer and the trigger.** Every consumer needs start, change, retry and backstop runs to be one single-flight sequence; putting that in the seam keeps it in one place instead of four.
- **`setMembershipChangeListener` stays as it is; it does not fold into this seam.** It runs awaited, inside the write, so the membership gate is current before a local `authorizePeer` / `removePeer` call returns. A coalesced subscriber would refresh the gate up to `coalesceMs` after the call returns, a race a peer dialling straight after being authorized would hit. Folding it in would remove no code path, only that guarantee. Replicated membership changes reach the gate through `control-reconcile-woken-by-changes-reads-once`, whose pass (now change-driven) already refreshes it. Add one sentence to the `setMembershipChangeListener` doc comment saying that local writes notify here and replicated ones reach the gate through the reconcile pass's table subscription.

## Edge cases & interactions

- **Handler under the control write lock.** `mutateCadrePeer` commits and notifies with the write lock held (`control-database.ts` ~1481, ~1746, ~3675). The seam's handler only sets flags and arms a timer, so nothing it does can wait on the lock. Verify by inspection: the handler has no `await` and returns `undefined`.
- **A double fire for one local commit.** Collapsed by the coalescing window when both arrive inside it; a late storage event costs one extra re-read, nothing else. Verified by the unit test (two commits in quick succession → one run).
- **A change during a run.** Exactly one follow-up run. Unit test.
- **A change during or after `dispose()` / `close()`.** No run starts. Unit test for dispose; the wrappers by inspection (dispose before any await in `close()`).
- **A table the `Database` has not touched yet.** Hears local commits (Quereus's own dispatch) but not replicated ones until the first full initialization arms the plugin bridge. Consumers' start runs arm it. Put a `NOTE:` at `watchTables` saying so.
- **A machine outside the block's cohort** (cadre larger than 16, strand larger than its cluster size) and a replicated block that lands without a storage event. The backstop is the only path. Each consumer ticket sets its own `backstopMs` and notes this at its constant.
- **A table dropped or altered by a schema change.** Quereus disposes the subscription silently. Control and strand schemas are fixed for a database's life, and an app-schema attach (`StrandDatabase.attachAppSchema`) adds `App` tables without altering `Strand` ones. Note it at `watchTables`; no handling.
- **A misspelled table name.** `watch` throws synchronously at subscribe, so a consumer fails at start, not silently.
- **Cross-platform.** Timers via `TimeoutScheduler` (unref'd where available), no Node-only imports.

## Tests

One spec, `test/table-change-watch.spec.ts`, over the seam with a real in-memory Quereus `Database` (`new Database()`, a plain memory table, as the `control-*-constraint.spec.ts` files do) and a hand-cranked `TimeoutScheduler` (pattern: `test/strand-first-sync-gate.spec.ts`):

- Two inserts in quick succession, then crank past the window → `onChange` ran once.
- An insert while a run is in flight (hold the run open on a deferred promise), then several more inserts → after it settles and the window passes, exactly one more run.
- `dispose()` with a change pending and with a run in flight → no further run.
- Also assert `onInvalidate` received the qualified table name of each change (one assertion in the first case; it is the contract `control-membership-rows-cached-until-changed` relies on).

Do not test that Optimystic raises replicated events; that is upstream's contract, and `message-cost-accounting`'s scenario exercises it end to end. Do not test the wrappers.

## TODO

- Write `table-change-watch.ts` per the contract above, with the `NOTE:`s named in the edge cases.
- Add `ControlDatabase.watchTables` and `StrandDatabase.watchTables`; dispose all handles at the top of each `close()`.
- Add the sentence to `setMembershipChangeListener`'s doc comment.
- Export from `index.ts` only if a consumer outside cadre-core needs it (none of the named consumers do; skip otherwise).
- Write the spec; run `yarn workspace @serfab/cadre-core test test/table-change-watch.spec.ts`, then the cadre-core typecheck and `yarn lint`.
- docs/architecture.md, "Control Network Convergence": add a short `#### Table change subscriptions` subsection — what the seam hears (local commits, commits replicated into this node's storage, join backfill and read repair), what it does not (a change that never reaches this node's storage; a table not yet touched), the coalescing and single-flight rule, and why consumers keep a backstop. Name `table-change-watch.ts`.
