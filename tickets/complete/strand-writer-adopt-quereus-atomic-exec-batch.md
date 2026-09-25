description: The strand membership writer now asks Quereus to run each membership write as one all-or-nothing batch, so a failed background write can no longer swallow and discard an app's write that was waiting behind it.
architecture: docs/architecture.md#strand-membership-bootstrap
files:
  - packages/cadre-core/src/strand-membership-writer.ts (`execStrandTransaction`, review `NOTE:` on the join retry)
  - packages/cadre-core/test/strand-writer-transaction-isolation.spec.ts
  - packages/cadre-core/test/strand-membership-reconciler.spec.ts (the two `db.exec` hooks that identify a writer batch)
  - docs/architecture.md ("How the writers transact", the `consumeInvite` bullet), docs/strands.md (the joiner-membership bullet)
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

The `@quereus/quereus` floor moved `^4.19.4` → `^4.20.0` in all six packages that declare it. `yarn.lock` records the new descriptors; the resolved package is unchanged, since root `resolutions` links `@quereus/quereus` to `../quereus/packages/quereus`, which is 4.20.0.

The `@optimystic/*` floors were deliberately **not** touched. Released optimystic 1.5.0 is unsafe with Quereus 4.20.0 after a failed `apply schema` (no `dropIndex` hook, so an unwound `create index` stays in storage) — that is `tickets/fix/control-schema-init-retry-under-quereus-4-20-rollback`, and `.release-notes.pending.md` carries the matching release hold.

## Tests

One test was added: `strand-writer-transaction-isolation.spec.ts` → "keeps an app write queued directly behind it — the batch rolls back before releasing the connection". It reproduces the exact loss: a membership statement that fails before `commit` (a `consumeInvite` whose `Member` insert collides on the primary key), with an app `insert` queued on the connection directly behind the batch; the app's row must still be there afterwards. The implementer verified it against the reverted implementation, where it fails as the defect predicts.

Everything else in the two touched spec files is an edit rather than a new behaviour: `queueBehindWriterBatch` and `failNextWriteBatch` used to identify a writer's batch by `sql.startsWith('begin transaction')` and now key on `options?.transaction === true`, and the busy-refusal test now asserts the `cause` is a `TransactionActiveError` instead of matching its message.

## Review findings

Read the implement diff (`d218f370`) first, then the Quereus 4.20.0 implementation it depends on (`../quereus/packages/quereus/src/core/database.ts`, read-only), then the writer, the reconciler's failure classifier and the two spec files.

### Verified against the engine, not just the handoff

Every load-bearing claim in the new doc comment was checked against Quereus's source rather than taken on trust, and all of them hold:

- `_execBatchAsTransaction` runs `_beginTransaction`, every statement, and the `commit` **or** the `rollback` inside one `_withMutex` call, so the rollback genuinely happens before the next caller is let in. That is the whole ticket.
- `TransactionActiveError` is thrown before any statement runs, so a refused batch really has written nothing — the precondition `StrandTransactionBusyError` advertises.
- `assertNoTransactionControl` runs before the mutex is taken and before anything executes, so a batch that spelled `begin`/`commit`/bare `rollback` would fail loudly and deterministically on its first call, with the database untouched.
- The engine rethrows the original failure unchanged (it only attaches it as `cause` if the *rollback* also fails), so the reconciler's `classifyConsumeFailure` still sees the same error identities it did before. Confirmed by the reconciler suite passing unchanged.
- `isInTransaction()` is read under the mutex, where an implicit transaction from another caller's autocommit statement has already been committed. The comment's reason for not pre-checking `getAutocommit()` is still the right one, and the spec that pins it still fails a pre-check implementation.

### Type check vs. message match — safe here, for a reason worth stating

Swapping `NESTED_BEGIN_REFUSAL` for `instanceof TransactionActiveError` invites the "two loaded copies of the package" hazard that `strand-membership-reconciler.ts` documents for `PartialCommitError`. It does not apply: the `Database` a strand writer is handed is constructed by cadre-core (`strand-database.ts`) from cadre-core's own resolved `@quereus/quereus`, and the error is thrown by that same copy, so the two can never come from different installs. Moving all six floors together additionally keeps a consumer that installs two Sereus packages from resolving two copies at all. No action; recorded here so the next reader does not re-derive it.

### Found and fixed in this pass (minor)

- **`docs/architecture.md`, the `consumeInvite` bullet** still described the writers' transaction as "one `begin transaction; …; commit;` batch, like every membership writer's transaction". The implement pass updated the two paragraphs it set out to update and missed this third site. Rewritten to name the atomic `exec` batch and point at "How the writers transact".
- **A stale test name.** `strand-writer-transaction-isolation.spec.ts`'s "does not refuse on autocommit state alone — only the batch's **own begin** decides" named a `begin` the batch no longer spells. Now "only the batch itself decides".

### Recorded as a tripwire, not filed

- **The join retry is atomic only while the caller's transaction stays open.** When the batch refuses with `TransactionActiveError` and `joinOpenTransaction` is not `false`, the retry is a plain `db.exec` — it has to be, since the point is to run inside the caller's transaction, and `{ transaction: true }` would refuse again. If a caller ever closed its transaction concurrently with a writer call it did not await, the statements would run as separate autocommit statements instead of one unit. This is conditional rather than latent: every joining caller today opens its transaction, awaits the writer, then commits, so the window cannot open. It also mostly fails safe — the writers whose statements are circularly dependent (`consumeInvite`'s `Member` + `ConsumedInvite`, every delete paired with its `Revocation` tombstone) fail loudly on their own deferred checks if split, and only `admitManager`, whose two statements are each valid alone, could commit a partial outcome. `NOTE:` at the retry in `execStrandTransaction`, naming `joinOpenTransaction: false` as the remedy for any future caller that needs to write without awaiting. The handoff raised this and asked whether it wanted a comment; it did, and it does not want a ticket.

### Considered and declined, with reasons

- **A guard against a writer fragment spelling transaction control.** Quereus refuses such a batch with `MisuseError` before taking the mutex and before running anything, so a violation is an immediate, deterministic, first-call failure with no partial write. A Sereus-side guard would duplicate an engine assertion that already cannot be missed, and a test for it would test Quereus. No change.
- **Hoisting `options?.transaction === true` into a shared test helper.** The predicate appears at three sites across two spec files, but each already sits inside a differently shaped `vi.spyOn(db, 'exec')` helper (`queueBehindWriterBatch`, `failNextWriteBatch`, and a one-off that swaps the invitation slot mid-batch). Extracting a one-line predicate out of three different wrappers, across two files, buys less than it costs. The coupling itself is an improvement on the old SQL-prefix match: a plain `exec` can no longer be mistaken for a writer's batch, and a change to the call shape fails these specs loudly rather than silently weakening them.
- **Raising the floor in all six packages rather than only `cadre-core`.** Kept as the implementer did it. Uniform floors are what stops a consumer installing two Sereus packages from resolving two copies of the engine, `yarn upgrade:quereus` moves them as a set, and `scripts/check-dep-ranges.mjs` passes on the result.
- **File size.** `strand-membership-writer.ts` is 1,962 lines (`wc -l`, after this pass) — large, but this change *shrank* it by about 45 lines, the file is a cohesive set of membership writers, and no current-release anchor calls for splitting it. Not filed; the open `debt-cadre-node-single-file-size` ticket is scoped to `cadre-node.ts` and is the right place for this theme if it ever gets one.

### Checked and clean, with nothing found

- **No stale references to the removed symbols.** `rollbackBatchLeftOpen`, `NESTED_BEGIN_REFUSAL` and `isNestedBeginRefusal` appear nowhere outside archived tickets. No `begin transaction` string remains in any `.ts` file.
- **No other hand-rolled shared-connection transaction.** The only other `beginTransaction()` in `packages/*/src` is `ControlDatabase.inTransaction`, on the cadre's own database, behind its write lock — a different connection with a different sharing story, and out of this ticket's scope.
- **Docs beyond the two the implementer touched.** `docs/strands.md`'s joiner bullet and `docs/architecture.md`'s "How the writers transact" both read correctly against the new code; `.release-notes.pending.md` already carries an accurate entry plus the optimystic release hold. The one miss is the `consumeInvite` bullet, fixed above.
- **No new test was warranted beyond the implementer's one.** No defect was found that a test would pin, and the contracts a new test could cover are either engine behaviour (Quereus's own suite) or already covered by the existing specs.

### Validation

- `yarn workspace @serfab/cadre-core build` / `typecheck` — exit 0.
- `yarn lint` (whole workspace) — exit 0.
- `yarn workspace @serfab/cadre-core test` — 138 files, 2272 passed, 1 skipped.
- `node --test scripts/check-dep-ranges.test.mjs` — 9 pass, 0 fail; `node scripts/check-dep-ranges.mjs` against the real tree — clean across 10 linked packages.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written. The full `yarn test` across all nine workspaces takes about 17 minutes, past what is worth running inside a ticket; the implement pass ran it green (4308 passed, all eleven root gates `fail 0`) and this review changed only one comment, one doc sentence and one test title on top of that, plus the gates above.
