description: The background code that finishes a machine's strand join writes its rows in a transaction on the same database the app is using, and app writes made at that moment get swept into that transaction and are lost if it fails. Make each membership write run as one uninterruptible unit, and stop background writes from joining the app's own transactions.
files: packages/cadre-core/src/strand-membership-writer.ts (`inStrandTransaction` ~145, `insertRevocation` ~186, `consumeInvite` ~616, `insertConsumedInviteRow` ~647, `burnInvite` ~682, `revokeMember` ~988, `leaveStrand` ~1046, `registerMemberPeer` ~1118, `removeMemberPeer` ~1292 with `deleteOwnMemberPeer`/`deleteMemberPeerByManager`, `addMemberByManager` ~911, `addManager` ~1440, `admitManager` ~1496, `removeManager` ~1596, `sealStrand` ~1685), packages/cadre-core/src/strand-membership-reconciler.ts (`ensureMembership` ~376, `burnLeftoverInvite`, `ensureBinding`, `classifyConsumeFailure` ~451), packages/cadre-core/src/strand-instance-manager.ts (`clearOwnMemberPeerBinding` ~1046), packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-spec-helpers.ts, docs/strands.md (~214), ../quereus/tickets/plan/exec-batch-as-one-transaction.md
repro: verified
----
# Strand membership writes must be indivisible on the shared connection

## Background

A strand has one Quereus `Database`. The app gets it from `addStrand` / `whenWritable`, and the same handle is used by background code: the membership reconciler (`strand-membership-reconciler.ts`) and `StrandInstanceManager.clearOwnMemberPeerBinding`. `publishDatabase` (strand-instance-manager.ts ~1296) resolves the app's waiters and kicks a reconciler pass in the same tick, so the app's first writes and the reconciler's join transaction start together.

Quereus facts that decide the design (checked against `@quereus/quereus` 4.19.4, `../quereus/packages/quereus/src/core/database.ts` `exec` ~1028):

- `exec` holds the exec mutex for its whole statement batch, and commits per statement only when the transaction is implicit. While any explicit transaction is open, every caller's statement runs inside it.
- `beginTransaction()`, each `exec`, and `commit()` are separate mutex holds. Between them another caller's statement can run, and it then lands in the open transaction.

## The defect (reproduced 2026-09-18)

`inStrandTransaction` does `beginTransaction()`, awaits several `exec` calls and `canonicalDatetime`, then `commit()`. A cadre-core spec on a local-transactor strand (`openStrand('c')` from `test/strand-spec-helpers.ts`) reproduced it: call `consumeInvite` with an invite that was never issued (so it fails at commit), do not await it, immediately `await db.exec("insert into Note …")`, then await the consume. `getAutocommit()` was `false` right after the app's `exec` resolved, and the `Note` row count afterwards was 0, not 1. The same happens in the integration scenario `strand-chat-participants-converge` (a joiner's `App.Participant` and `App.Message` rows were listed in the reconciler's commit and reverted with it).

The reverse direction is also wrong. When an app has its own explicit transaction open, `inStrandTransaction` sees `getAutocommit() === false` and joins it, so a background write (or even a single-statement write such as `registerMemberPeer`) is committed or rolled back by the app's transaction.

## Design

### One batch per transaction

Every writer computes everything asynchronous first (reads such as `memberStampId` / `managerRow`, `canonicalDatetime`, signatures, fresh stamps), then issues the whole transaction as a **single** `db.exec` call: `begin; <statements>; commit;` with named parameters. Verified on 4.19.4: named parameters bind across every statement of a batch, and a failure at `commit` (deferred constraints, or an optimystic commit failure) leaves no transaction open.

Put this in one helper in `strand-membership-writer.ts`, replacing `inStrandTransaction`:

```ts
/** A writer that must own its transaction found one already open on the connection. */
export class StrandTransactionBusyError extends Error { /* name = 'StrandTransactionBusyError' */ }

/** Options every transactional writer accepts. */
export interface StrandWriteOptions {
  /**
   * Default true: when a transaction is already open, run the statements inside it (the
   * caller composes several writers and owns commit/rollback). Background callers pass
   * false: they must never join a transaction someone else opened.
   */
  joinOpenTransaction?: boolean;
}

async function execStrandTransaction(
  db: Database, body: string, params: SqlParameters, options?: StrandWriteOptions,
): Promise<void>;
```

Behaviour:

- A transaction is open (`!db.getAutocommit()`) and joining is allowed: `await db.exec(body, params)`. This is today's joined mode, and the 17 test sites that compose writers inside `inTransaction(...)` keep working unchanged.
- A transaction is open and joining is not allowed: throw `StrandTransactionBusyError` without touching anything.
- Otherwise: `await db.exec(`begin; ${body} commit;`, params)`. On failure:
  - If the batch's own `begin` was refused because another caller's explicit transaction opened between the check and the batch (Quereus message `Cannot begin transaction: already in a transaction`), throw `StrandTransactionBusyError` with the original error as `cause`, and do **not** roll back. That transaction belongs to someone else.
  - Otherwise, if `!db.getAutocommit()` (a statement before `commit` failed, which leaves the batch's transaction open), `rollback()` and log it. Rethrow the original error.

Statement fragments: `insertRevocation`, `deleteOwnMemberPeer`, `deleteMemberPeerByManager`, and the insert halves of `addMemberByManager` / `addManager` become builders that return `{ sql, params }` after doing their reads and signing, so `admitManager` (member add + manager add) and every delete-plus-tombstone pair can assemble one batch. Named parameters must not collide when two fragments share a batch (e.g. both halves of `admitManager` bind a manager key). Give each builder distinct parameter names, or a prefix argument. Do not rewrite SQL text to rename parameters.

Single-statement writers used by background flows (`burnInvite`, `registerMemberPeer`) go through the same helper, so in own mode they refuse rather than join an app transaction.

### Background callers own their transactions

- Reconciler: `consumeInvite`, `burnInvite` and `registerMemberPeer` are called with `{ joinOpenTransaction: false }`. `StrandTransactionBusyError` means "the app is mid-transaction; try again". Classify it before the dead-invite regex in `classifyConsumeFailure`, as retry-next-tick with its own log line. In `burnLeftoverInvite`, a busy refusal must **not** clear the staged invitation, since nothing was tried. Leave it staged for the next pass. `ensureBinding`'s failure already falls to the pass's outer catch and retries.
- `clearOwnMemberPeerBinding` calls `removeMemberPeer` with `{ joinOpenTransaction: false }`. Its existing best-effort catch logs a busy refusal like any other failure.
- Export `StrandTransactionBusyError` and `StrandWriteOptions` from `index.ts` next to the writers.

### Known residual (interim until Quereus ships a primitive)

If a statement **before** `commit` fails at statement time (a primary-key collision such as a sibling machine seating the same `Member` first, an immediate CHECK, or a storage read error), Quereus releases the mutex with the batch's transaction still open. An app `exec` already queued behind the batch runs inside it, and the helper's `rollback()` then discards that app write. This was reproduced on 4.19.4. The window is one queued statement wide and only opens on statement-time failures. The common failures (Invite not replicated yet, expired, cancelled, sealed, and optimystic commit refusals) all fail at `commit`, which leaves nothing open. The complete fix needs Quereus to roll back before releasing the mutex. That request is filed as `../quereus/tickets/plan/exec-batch-as-one-transaction.md`. Leave a `NOTE:` on the helper naming it, and switch the helper to that API when a Quereus release carries it. The switch also removes the message match on Quereus's nested-begin refusal.

## Tests

- New cadre-core spec (e.g. `test/strand-writer-transaction-isolation.spec.ts`, local transactor, `openStrand('c')`, and a plain `create table Note (Id integer primary key, Body text)` for the app's table):
  - An app insert issued while `consumeInvite` of a never-issued invite is in flight survives the consume failing. `Note` count is 1, `Member` count is still 1 (the founder), and `getAutocommit()` is true afterwards. This is the repro above and must fail before the change.
  - Same, with a consume that succeeds (issue a real invite with `issueInvite`): the app row is present and committed, and the new member is seated.
  - The app holds its own explicit transaction (`beginTransaction`, insert a `Note`), then `consumeInvite(…, { joinOpenTransaction: false })` rejects with `StrandTransactionBusyError`. The app's `commit()` then succeeds with its row, and no `Member`/`ConsumedInvite` row was written.
  - A statement-time failure inside a writer batch (e.g. `consumeInvite` for a `memberKey` that is already a member, which collides on the `Member` primary key) leaves `getAutocommit()` true afterwards.
  - Joined mode is unchanged: `revokeMember` composed inside the helpers' `inTransaction` still commits or rolls back with the caller.
- Existing suites stay green: `yarn workspace @serfab/cadre-core test` (in particular `strand-membership-invite`, `strand-member-revocation`, `strand-seal`, `strand-membership-reconciler`, `strand-membership-network-transactor-parity`).
- Reconciler spec: a busy refusal is retried, does not clear the staged invitation, and is not logged as a dead invitation.

## TODO

- Replace `inStrandTransaction` with `execStrandTransaction` + `StrandTransactionBusyError` + `StrandWriteOptions`, with a `NOTE:` naming the Quereus ticket and the statement-time residual.
- Convert `insertRevocation`, `deleteOwnMemberPeer`, `deleteMemberPeerByManager`, and the insert halves of `addMemberByManager`/`addManager`, into prepare-then-fragment builders with non-colliding named parameters.
- Rewrite `consumeInvite`, `burnInvite`, `revokeMember`, `leaveStrand`, `registerMemberPeer`, `removeMemberPeer`, `admitManager`, `removeManager`, `sealStrand` (and `addMemberByManager`/`addManager` standalone) to compute first and then make one helper call. Each takes an optional trailing `StrandWriteOptions`.
- Reconciler: pass `{ joinOpenTransaction: false }` for its three writes, classify `StrandTransactionBusyError` as retry (before the dead-invite regex), keep the staged invite on a busy burn.
- `clearOwnMemberPeerBinding`: pass `{ joinOpenTransaction: false }`.
- Export the new error and options from `index.ts`.
- Add the isolation spec and the reconciler busy case. Run cadre-core tests, `yarn lint`, and the type check.
- docs/strands.md (~214, the paragraph on the join rows landing with the strand): one or two sentences saying membership writes run as one indivisible batch, never join an app transaction, and back off while the app has one open.
- Re-run `strand-chat-participants-converge`, `blind-relay-phone-to-phone-e2e` and `strand-membership-closed-strand-e2e` from `packages/integration-tests` (3× each if time allows). The joiner's `Member` seat may still time out because of the upstream optimystic partial-commit regression (see `tickets/.pre-existing-known.md`), but the participant list must no longer lose the joiner's own rows. With `DEBUG=optimystic:quereus-plugin:txn-bridge`, the reconciler's `commit:collections` line must list only `default/strand/*` collections.
