description: Quereus has built the "run these statements as one all-or-nothing batch" option Sereus asked for. Once a Quereus release carries it, the strand writer should use it, which closes two small windows where an app's write can be swept into and lost with a failed background membership write.
files:
  - packages/cadre-core/src/strand-membership-writer.ts (`execStrandTransaction`, `rollbackBatchLeftOpen`, `NESTED_BEGIN_REFUSAL`)
  - packages/cadre-core/test/strand-writer-transaction-isolation.spec.ts
  - package.json files carrying the `@quereus/quereus` floor
----

# Switch the strand writer to Quereus's atomic `exec` batch

## Why this is blocked

**Category: waiting on an upstream release.** Quereus landed `exec(sql, params, { transaction: true })` and `TransactionActiveError` on its main branch on 2026-09-24 (quereus `c391e4c8`, reviewed `6d0d9a37`; `../quereus/tickets/complete/exec-batch-as-one-transaction.md`). The published `@quereus/quereus` 4.19.4 does not have it. **Unblock when** a Quereus release containing it is on npm.

## What happened meanwhile

The same Quereus change reworded the nested-`begin` refusal from `Cannot begin transaction: already in a transaction` to `Cannot begin transaction: a transaction is already active`. `execStrandTransaction` recognises that refusal by its text, so against the linked Quereus main 15 cadre-core tests failed (every "joined" or "busy" path in `strand-writer-transaction-isolation`, `strand-member-revocation`, `strand-membership-invite`, `strand-membership-manager-rotation`, `strand-membership-reconciler`, `strand-seal`). The interim fix, made directly by the gardener on 2026-09-24, makes `NESTED_BEGIN_REFUSAL` accept both wordings.

## Do

1. Raise the `@quereus/quereus` floor to the release that carries the option.
2. In `execStrandTransaction`, run `statements.sql` with `db.exec(sql, params, { transaction: true })` instead of the hand-written `begin transaction; … commit;` batch.
   - `TransactionActiveError` (check with `instanceof`, not by text) means a transaction is already open.
   - With `joinOpenTransaction: false`, that becomes `StrandTransactionBusyError`, the same as now.
   - Otherwise, run the statements as a plain `exec` inside the caller's transaction, the same as now.
3. Delete `rollbackBatchLeftOpen`, `NESTED_BEGIN_REFUSAL` and `isNestedBeginRefusal`. The atomic batch rolls back under its own mutex, which closes both residual windows in the current NOTE.
4. Replace that NOTE with a short description of the new behaviour. Update `docs/strands.md` if it describes the windows.
5. Add a test in `strand-writer-transaction-isolation.spec.ts` for the case the old batch could not handle: a statement that fails before `commit`, while an app `exec` is queued behind the batch. The app's write must survive.
