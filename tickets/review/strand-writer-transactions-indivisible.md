description: Strand membership writes (a machine finishing its join, and the other membership changes) now run as one uninterruptible database transaction each, so app writes made at the same moment are no longer swept into them and lost, and background membership writes never join a transaction the app has open.
files: packages/cadre-core/src/strand-membership-writer.ts (`execStrandTransaction`, `StrandTransactionBusyError`, `StrandWriteOptions`, `combineStatements`, statement builders), packages/cadre-core/src/strand-membership-reconciler.ts (`classifyConsumeFailure` busy kind, `handleConsumeFailure`, `burnLeftoverInvite`, `ensureBinding`), packages/cadre-core/src/strand-instance-manager.ts (`clearOwnMemberPeerBinding`), packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-writer-transaction-isolation.spec.ts (new), packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-seal.spec.ts (comment only), docs/strands.md (join bullet), docs/architecture.md (`consumeInvite` bullet), ../quereus/tickets/plan/exec-batch-as-one-transaction.md
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
