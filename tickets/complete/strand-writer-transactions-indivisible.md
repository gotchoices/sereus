description: Strand membership writes (a machine finishing its join, and the other membership changes) now run as one uninterruptible database transaction each, so app writes made at the same moment are no longer swept into them and lost, and background membership writes never join a transaction the app has open.
files: packages/cadre-core/src/strand-member-registry.ts (review NOTE), packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts (review comment fix), packages/cadre-core/src/strand-membership-writer.ts (`execStrandTransaction`, `StrandTransactionBusyError`, `StrandWriteOptions`, `combineStatements`, statement builders), packages/cadre-core/src/strand-membership-reconciler.ts (`classifyConsumeFailure` busy kind, `handleConsumeFailure`, `burnLeftoverInvite`, `ensureBinding`), packages/cadre-core/src/strand-instance-manager.ts (`clearOwnMemberPeerBinding`), packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-writer-transaction-isolation.spec.ts (new), packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-seal.spec.ts (comment only), docs/strands.md (join bullet), docs/architecture.md (`consumeInvite` bullet), ../quereus/tickets/plan/exec-batch-as-one-transaction.md
----
# Strand membership writes are indivisible on the shared connection

## What changed

A strand's one Quereus `Database` is used both by the app and by background code (the membership reconciler, and `clearOwnMemberPeerBinding` at unpublish). Before this change, `inStrandTransaction` did `beginTransaction()`, several `exec` calls, then `commit()`. Quereus releases its exec mutex between those calls, so an app statement issued in the gap ran inside the membership transaction and was rolled back with it if it failed. The reverse was also true: a background writer joined any transaction the app had open.

Now every membership writer in `strand-membership-writer.ts` does all its reads, signing, and `canonicalDatetime` first, then issues the whole transaction as a single `db.exec` batch through `execStrandTransaction`:

```
begin transaction;
<statement fragments, named parameters>
commit;
```

- Statement fragments are built by small builders returning `{ sql, params }` (`revocationStatement`, `consumedInviteStatement`, `memberAddByManagerStatement`, `managerAddStatement`, `ownMemberPeerRemovalStatements`, `memberPeerRemovalByManagerStatements`, `managerRemovalStatements`). Each builder uses its own parameter names. `combineStatements` merges fragments and throws if two fragments bind the same parameter name.
- Every transactional writer takes an optional trailing `StrandWriteOptions { joinOpenTransaction?: boolean }`: `consumeInvite`, `burnInvite`, `addMemberByManager`, `revokeMember`, `leaveStrand`, `registerMemberPeer`, `removeMemberPeer`, `addManager`, `admitManager`, `removeManager`, `sealStrand`. The default (`true`) keeps the old "run inside the caller's open transaction" behaviour used by specs that compose writers inside `inTransaction(...)`.
- `joinOpenTransaction: false` throws `StrandTransactionBusyError` (with Quereus's refusal as `cause`) when a transaction is already open, and writes nothing. Both names are exported from `index.ts`.
- The reconciler passes `{ joinOpenTransaction: false }` for `consumeInvite`, `burnInvite` and `registerMemberPeer`. `classifyConsumeFailure` returns a new `{ kind: 'busy' }` (a typed check over the `cause` chain, run before every other check). `handleConsumeFailure` logs it and keeps the staged invitation, so the pass retries on the ladder. A busy burn in `burnLeftoverInvite` returns without clearing the staged invitation. A busy `registerMemberPeer` falls to the pass's outer catch and retries.
- `clearOwnMemberPeerBinding` passes `{ joinOpenTransaction: false }`. Its existing best-effort catch logs a busy refusal.

## Deviations from the ticket's design (please scrutinise)

- **No `getAutocommit()` pre-check.** The ticket's helper checked `!db.getAutocommit()` first to decide join/refuse. In Quereus 4.19.4, `getAutocommit()` is also false while another caller's autocommit statement is mid-flight (an implicit transaction is open during every statement). A pre-check would make the reconciler refuse whenever an app write happened to be in flight (an app that writes steadily could starve the join), and would make a default-mode caller with no transaction run its batch as separate autocommits. Instead, the helper always issues `begin transaction; …; commit;` first and uses the batch's own `begin`, which runs under the mutex, as the test. If Quereus refuses it with `Cannot begin transaction: already in a transaction`, a transaction is open. Own mode then throws `StrandTransactionBusyError`. Default mode re-issues the statements without `begin`/`commit` inside the open transaction. Cost for composed writers: one refused `begin` per writer call.
- Consequently default mode never throws `StrandTransactionBusyError`. The ticket had it thrown for a `begin` that lost a race in default mode too.
- The helper takes one `StrandStatements` object rather than `(body, params)`.

## Known residuals (documented in the `NOTE:` on `execStrandTransaction`)

- (1) The ticket's residual: a statement that fails before `commit` (for example a `Member` primary-key collision) leaves the batch's transaction open after the mutex is released. An app `exec` already queued behind it runs inside it and is lost when the helper rolls back. The common join failures (Invite not replicated yet, expired, cancelled, sealed, optimystic commit refusals) all fail at `commit` and leave nothing open. The fix needs the Quereus primitive requested in `../quereus/tickets/plan/exec-batch-as-one-transaction.md`.
- (2) Found during implementation: the helper decides whether to roll back by reading `getAutocommit()` after the failed batch released the mutex. After a `commit`-time failure, an app statement already in flight also reads as "open". The queued `ROLLBACK` then runs after that statement's own commit and is a no-op, because Quereus's `ROLLBACK` does nothing when no transaction is open. It only does harm if an app `beginTransaction()` also got in between, in which case it ends the app's new transaction. The same Quereus primitive removes this.
- The nested-`begin` refusal is matched by its exact message. `strand-writer-transaction-isolation.spec.ts` asserts the message text, so a Quereus rewording fails a spec rather than silently turning every refusal into a failure.

## Tests

- New `test/strand-writer-transaction-isolation.spec.ts` (8 tests, local transactor, app table `Note`):
  - The reproduced loss: an app insert issued as `consumeInvite` of a never-issued invite starts survives the consume failing (`Note` = 1, `Member` = 1, autocommit true). **Verified to fail on the pre-change writer** (swapped HEAD's file in temporarily): `Note` count 0. Four other tests in the file also fail there.
  - The same with the app insert queued directly behind the writer's batch (a `db.exec` spy fires the app write the moment the `begin transaction` batch is issued).
  - A successful join with app writes in both orderings: both committed, member seated.
  - Own mode while the app holds an explicit transaction: `consumeInvite` rejects `StrandTransactionBusyError` (cause text pinned), app commit keeps its row, no `Member`/`ConsumedInvite`, and the same invitation redeems afterwards. `registerMemberPeer` (single statement) refuses too and leaves the app's rollback untouched.
  - A statement-time failure (`consumeInvite` for the founder's key, which collides on `Member`'s primary key) leaves autocommit true and writes nothing.
  - Default mode: `revokeMember` inside `inTransaction` commits with the caller, and rolls back with it.
- `strand-membership-reconciler.spec.ts`: busy consume is retried, keeps the invitation, logs no dead-invitation line, and completes on the next pass. A busy burn keeps the invitation staged, writes no binding, and burns and binds on the next pass. A classification test covers busy, both unwrapped and wrapped. The three half-committed-join tests used to inject their failure with `vi.spyOn(db, 'commit')`. The writers no longer call `commit()`, so those tests now use `failNextWriteBatch`, which rejects the first `begin transaction` exec.
- Runs: `yarn workspace @serfab/cadre-core test`: 136 files, 2237 passed, 1 skipped. That skip was there before this change. `yarn lint`: clean. cadre-core and integration-tests `typecheck`: clean. cadre-core rebuilt.
- Integration (`packages/integration-tests`), 3 runs each, all green: `strand-chat-participants-converge` (3/3), `blind-relay-phone-to-phone-e2e` (1/1), `strand-membership-closed-strand-e2e` (9/9). With `DEBUG=optimystic:quereus-plugin:txn-bridge` on the chat scenario, both join commits listed only `default/strand/ConsumedInvite`, `default/strand/Member`, `default/strand/Member/index/_uniq_7.stampid`, and every `MemberPeer` commit listed only `default/strand/MemberPeer` (+ its index). No app collection appeared in any membership commit. The upstream optimystic half-commit regression (`tickets/.pre-existing-known.md`) did not appear in these runs. Logs: `tickets/.logs/strand-writer-transactions-indivisible.*.log`.

## Gaps for the reviewer

- No test stages "own-mode writer called while an app autocommit statement is mid-flight does not refuse" (the reason for dropping the pre-check). It depends on timing and I found no deterministic hook. The reasoning is in the helper's doc comment.
- Residuals (1) and (2) are not pinned by tests. A test would have to assert the known-wrong outcome.
- Specs identify a writer batch by its `begin transaction` prefix (`queueBehindWriterBatch`, `failNextWriteBatch`), so they depend on the helper's SQL shape.
- Not converted, by scope: `issueInvite`, `cancelInvite` (single app-called statements) and the founder bootstrap inserts still use plain `db.exec`. The reconciler's reads (`isStrandMember`, `canonicalDatetime`) still run inside an app's open explicit transaction if there is one. They are reads only.
- `tickets/.pre-existing-known.md` still names this ticket as `implement/strand-writer-transactions-indivisible`.

## Review findings

Read the implement diff (`f5d2f270`) before the handoff, then checked the claims against Quereus 4.19.4's source (`Database.exec`, `_acquireExecMutex`, `TransactionManager.beginTransaction`/`commitTransaction`, `Database.beginTransaction`/`commit`/`rollback`).

**Correctness: confirmed, no defects found.**
- `exec` holds the mutex for the whole batch and only auto-commits or rolls back implicit transactions, so a mid-batch failure inside the batch's explicit transaction leaves it open (the documented residual 1), and a refused `begin` while another caller's explicit transaction is open does not disturb that transaction. `commitTransaction` rolls back every connection and resets state on any commit-time failure, so commit-time failures leave nothing open, as claimed.
- The refusal text `Cannot begin transaction: already in a transaction` is thrown in exactly one place (`database-transaction.ts`), which matches the helper's regex. A `begin` during another caller's implicit transaction cannot happen under the mutex, because `exec` commits the implicit transaction after each statement.
- Dropping the `getAutocommit()` pre-check is correct: the transaction manager reports non-autocommit during any in-flight DML's implicit transaction.
- Parameter names across the fragment builders checked by hand: no collisions (`combineStatements` would throw if there were).
- Reconciler: busy is classified before every other check. A busy consume keeps the invitation and retries on the ladder, a busy burn returns before `pending.clear()`, and a busy binding falls to the outer catch. All three are covered by specs.

**Production callers.** Only the reconciler and `clearOwnMemberPeerBinding` are background writers, and both pass `joinOpenTransaction: false`. `StrandMemberRegistry` calls `consumeInvite`/`addMemberByManager` in default (joining) mode, but nothing in cadre-core instantiates it (`EnrollmentService` is built without a registry). Recorded as a tripwire: a `NOTE:` at `strand-member-registry.ts` `registerMember`.

**Residuals (1) and (2)** are accepted as documented in the `NOTE:` on `execStrandTransaction`. Both close with the Quereus primitive requested in `../quereus/tickets/plan/exec-batch-as-one-transaction.md`. A narrower rollback test using Quereus's `_isImplicitTransaction()` would shrink residual (2), but that method is `@internal`, so I didn't use it.

**Related Quereus issue, appended as an arm to that Quereus ticket rather than filed separately (same file, same fix).** `Database.beginTransaction()`/`commit()`/`rollback()` check `isInTransaction()` before taking the mutex. That check is also true during another caller's autocommit statement, so an app's `beginTransaction()` that happens to be called while a background write is in flight throws `Transaction already active`. This is static (read the code, didn't reproduce it). It isn't new with this change: the old `beginTransaction()`/`exec`/`commit()` writer had a wider window.

**Tests.** The implementer's gap "no test that an own-mode writer does not refuse while an app statement is mid-flight" is now closed. A new spec in `strand-writer-transaction-isolation.spec.ts` stubs `getAutocommit()` to `false` (what an in-flight autocommit statement reads as) and asserts that an own-mode `registerMemberPeer` still writes. A pre-check implementation would fail it. Residuals (1) and (2) are still not pinned, for the reason the handoff gives (a test would have to assert the known-wrong outcome). The specs' dependence on the `begin transaction` batch prefix is acceptable: a change to the helper's SQL shape fails those specs loudly and doesn't silently weaken them.

**Docs.**
- `docs/strands.md` said a batch is "never" swept in. Corrected to name the one exception (a pre-`commit` statement failure) and why the usual join failures don't hit it.
- `docs/architecture.md` had no general description of `StrandWriteOptions`, so the joining default and the background opt-out appeared only in code. Added a "How the writers transact" paragraph after the writer list. The `sealStrand` bullet's "joining a caller-owned transaction like every other writer" is still accurate for the default mode.
- A stale comment in `strand-membership-closed-strand-e2e.integration.ts` named the removed `insertRevocation`. Now `revocationStatement`.
- `tickets/.pre-existing-known.md` updated to show this ticket landed.

**Hygiene.**
- `strand-membership-writer.ts` is 1987 lines (`wc -l`). It was already large before this change, and the new code is small single-purpose builders. No split filed: the file is one cohesive writer module, and the size predates this ticket.
- `addManager` logs the generation by reading `promotion.params.managerGeneration`, which ties a log line to a parameter name. Minor, and left as is.
- No `any`, lowercase SQL throughout, no swallowed errors: the rollback-failure path logs.

**Not converted, by scope (agreed).** `issueInvite`, `cancelInvite` and the founder bootstrap stay plain single-statement `exec`s called by the app itself.

**Runs.**
- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core typecheck`: clean.
- `yarn workspace @serfab/cadre-core test`: 136 files, 2238 passed, 1 skipped. The skip was there before this change.
- cadre-core rebuilt.
- Integration scenarios not re-run in review. The only integration-package change is a comment, and the implementer's 3x runs cover the writer change.

