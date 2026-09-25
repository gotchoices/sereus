description: The strand membership writer now asks Quereus to run each membership write as one all-or-nothing batch, so a failed background write can no longer swallow and discard an app's write that was waiting behind it.
architecture: docs/architecture.md#strand-membership-bootstrap
files:
  - packages/cadre-core/src/strand-membership-writer.ts (`execStrandTransaction`)
  - packages/cadre-core/test/strand-writer-transaction-isolation.spec.ts
  - packages/cadre-core/test/strand-membership-reconciler.spec.ts (the two `db.exec` hooks that identify a writer batch)
  - docs/architecture.md ("How the writers transact"), docs/strands.md (the joiner-membership bullet)
  - packages/{cadre-core,integration-tests,quereus-plugin-sereus,reference-app-ns,reference-app-rn,reference-app-web}/package.json, yarn.lock
----

# Switch the strand writer to Quereus's atomic `exec` batch

## What changed

`execStrandTransaction` used to send `begin transaction; <statements> commit;` as one `db.exec` string. Quereus holds its execution mutex for the length of one `exec` call but releases it between calls, so a statement that failed *before* the closing `commit` released the mutex with the batch's transaction still open. An app `exec` already queued on that connection then ran inside the writer's transaction, and the writer's follow-up `rollback()` discarded that app write although the app's `exec` had already resolved. That was the loss this ticket closes.

Quereus 4.20.0 added `exec(sql, params, { transaction: true })`, which begins, runs, and commits *or rolls back* the whole batch under a single hold of the mutex, and a typed `TransactionActiveError` for "a transaction is already open here". `execStrandTransaction` now:

- sends the statements with `{ transaction: true }` and no hand-written transaction control;
- recognises the already-open case by `error instanceof TransactionActiveError` — no message-text match anywhere any more;
- keeps the two existing outcomes unchanged for callers: `joinOpenTransaction: false` still throws `StrandTransactionBusyError` with the refusal as `cause`; the default still re-runs the statements as a plain `exec` inside the caller's transaction.

`rollbackBatchLeftOpen`, `NESTED_BEGIN_REFUSAL` and `isNestedBeginRefusal` are gone — the engine owns the rollback now, so nothing in Sereus has to guess whether a failed batch left a transaction behind.

The `@quereus/quereus` floor moved `^4.19.4` → `^4.20.0` in all six packages that declare it (the code needs the new API, and `upgrade:quereus` moves them together). `yarn.lock` records the new descriptors; the resolved package is unchanged, since root `resolutions` links `@quereus/quereus` to `../quereus/packages/quereus`, which is 4.20.0.

The `@optimystic/*` floors were deliberately **not** touched — see "Not in scope" below.

## Tests

| Test | What it verifies |
| --- | --- |
| `strand-writer-transaction-isolation.spec.ts` → "keeps an app write queued directly behind it — the batch rolls back before releasing the connection" (**new**) | The window this ticket closes: a membership statement that fails before `commit` (a `consumeInvite` whose `Member` insert collides on the primary key), with an app `insert` queued on the connection directly behind the batch. The app's row must still be there afterwards. |

That is the only test added. Everything else in the two touched spec files is an edit, not a new behaviour:

- `queueBehindWriterBatch` and `failNextWriteBatch` used to identify "this `exec` is a writer's transaction batch" by `sql.startsWith('begin transaction')`. The batch no longer spells `begin`, so both now key on `options?.transaction === true`.
- The busy-refusal test asserted the `cause`'s message matched `/^Cannot begin transaction: /`; it now asserts `cause` is a `TransactionActiveError`, which is the guarantee the writer actually depends on.

**The new test was checked against the old code, not just asserted to pass.** With `execStrandTransaction` temporarily reverted to the hand-rolled batch (and the helper's batch detection reverted with it), it fails exactly as the defect predicts — `expected +0 to be 1`, the app's row gone. The revert was undone immediately; only the described files are modified.

## Validation run

- `yarn workspace @serfab/cadre-core build` / `typecheck` / `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core test` — 138 files, 2272 passed, 1 skipped.
- `yarn build`, `yarn typecheck` (whole workspace) — clean.
- `yarn test` (all workspaces plus the root gates, including `check-dep-ranges`) — exit 0 in 17m 37s. 4308 tests passed across the nine workspaces, 10 skipped and 1 todo, and all eleven root `node --test` gates reported `fail 0`. Run log: `tickets/.logs/strand-writer-adopt-quereus-atomic-exec-batch.test.log`. No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## What a reviewer should push on

- **The join path still has a pre-existing gap, and this change does not close it.** When the batch refuses with `TransactionActiveError` and `joinOpenTransaction` is not `false`, the retry is a plain `db.exec(sql, params)` with no `{ transaction: true }`. If the other transaction closed between the refusal and that retry, the statements run as separate autocommit statements instead of one unit. This was the behaviour before the change too, and reaching it requires a caller to close its own transaction concurrently with its own writer call, which no caller does. It is listed here because it is the one place where "indivisible" still rests on caller discipline rather than on the engine. No code comment was added for it — the reviewer may reasonably disagree and want one, or want the retry to pass `{ transaction: true }` and treat a second refusal as busy.
- **The floor was raised in all six packages, not only `cadre-core`.** Only `cadre-core` calls the new API. The argument for moving them together is that a consumer installing two Sereus packages with different floors can resolve two copies of Quereus, and that `yarn upgrade:quereus` moves them as a set anyway. If the project would rather keep floors minimal per package, five of the six edits should be reverted.
- **The test hooks now couple to an option value rather than to SQL text.** `options?.transaction === true` is a tighter coupling to `execStrandTransaction`'s call shape than a SQL prefix match was, but it is also unambiguous — a plain `exec` can no longer be mistaken for a batch. Worth a second opinion on whether that belongs in a shared helper rather than duplicated in two spec files.
- **Nothing pins Quereus's refusal of transaction control inside an atomic batch.** `exec` with `{ transaction: true }` throws `MisuseError` if the SQL spells `begin`, `commit` or a bare `rollback`. No writer fragment does, and a violation would fail loudly at runtime on the first call, so no test was written for it. Flagged in case the reviewer thinks the batch builders deserve a guard.

## Not in scope

The `@optimystic/*` floors stay at `^1.5.0`. Released optimystic 1.5.0 is unsafe with Quereus 4.20.0 after a failed `apply schema` (it has no `dropIndex` hook, so an unwound `create index` stays in storage) — that is `tickets/fix/control-schema-init-retry-under-quereus-4-20-rollback`. `.release-notes.pending.md` already carries the release hold: **do not release until the optimystic patch is published and those floors are raised.** This ticket does not change that file; the gardener wrote the entry for this change ahead of time and it is still accurate.
