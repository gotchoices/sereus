description: The membership reconciler redeems a joiner's invitation in an explicit transaction on the same strand `Database` the app is handed, and it starts at the moment the app is handed it. Quereus runs any statement issued while that transaction is open inside it. So an app write made right after `addStrand` resolves is folded into the reconciler's `consumeInvite` transaction and disappears if that commit fails, even though the app's `db.exec` already resolved. The reconciler also classifies a half-committed join as a "dead invitation" by regex and drops it, which leaves the party permanently unseated.
files: packages/cadre-core/src/strand-membership-writer.ts (`inStrandTransaction` ~145-163, `consumeInvite` ~616-634, `insertConsumedInviteRow`), packages/cadre-core/src/strand-membership-reconciler.ts (`DEAD_INVITE_REJECTION` :112, `ensureMembership` ~376-398, `classifyConsumeFailure` ~451-473), packages/cadre-core/src/strand-instance-manager.ts (`publishDatabase` ~1296-1321), packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts, packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts
repro: `cd packages/integration-tests && DEBUG='sereus:cadre:strand-membership*,optimystic:quereus-plugin:txn-bridge' yarn vitest run src/scenarios/strand-chat-participants-converge.integration.ts`. Fails in 4 of 4 isolated runs on 2026-09-17 (one or two of the three tests each time) (optimystic 9ec2de46). Look for a `commit:collections mode=legacy count=5` line on the joiner that lists `default/app/Participant` and `default/app/Message` next to `default/strand/ConsumedInvite` and `default/strand/Member`.
----

# The reconciler's join transaction captures, then loses, the app's concurrent writes

This ticket is about two sereus defects. They show up now because of an upstream optimystic regression, reported separately, but neither depends on it.

## Upstream context (not this ticket's to fix)

Since optimystic `13586033`/`2fdb3b97` (2026-09-17, "legacy-multi-tree-commit-pends-everything-before-committing-anything"), a multi-table SQL commit goes through `TransactionCoordinator`. The joiner's first write to a founder-authored collection (`Strand.Member`, rev 1 → 2) can then be refused in the commit phase with `commit-not-durable` (`missing-base-revision`: the joiner's own store does not yet hold the founder's rev-1 block, so 1 of 2 cohort members holds the write). Meanwhile `ConsumedInvite`, which is all inserts, commits durably. The result is `CoordinatorPartialCommitError`: ConsumedInvite committed, Member not. Before `13586033`, each tree's `sync()` retried that refusal. That problem is optimystic's. This ticket covers what sereus does with the failure.

## Defect 1: app writes join the reconciler's transaction

- `publishDatabase` (strand-instance-manager.ts ~1310-1320) resolves the `whenWritable` / `addStrand` waiters, then does `void reconciler.reconcile()` in the same tick.
- The reconciler's pass calls `consumeInvite` → `inStrandTransaction` → `db.beginTransaction()`. It then awaits `exec(insert Member)`, `canonicalDatetime(...)` and `exec(insert ConsumedInvite)`, and only then calls `commit()`. Quereus's exec mutex is released between those awaits.
- Quereus `Database.exec` (`../quereus/packages/quereus/src/core/database.ts` ~1039-1057) commits per statement only for an *implicit* transaction. While any explicit transaction is open on the `Database`, a statement from any caller runs inside it.
- The app (the chat device shape: write immediately after `addStrand`) calls `insert into App.Participant` / `App.Message` on the same `Database`. Those rows are staged in the reconciler's transaction. The app's `exec` resolves and read-your-writes shows the rows, but nothing is committed yet.

Observed (debug run 2026-09-17, joiner node `ZB5rZA`):

```
txn-bridge commit:collections mode=legacy count=5 default/app/Message=staged default/app/Participant=staged
  default/strand/ConsumedInvite=staged default/strand/Member=staged default/strand/Member/index/_uniq_7.stampid=staged ...
strand-membership-reconciler ... the staged invitation is dead ... — dropping it; ...: Multi-collection commit was not atomic:
  ... Committed ...: [default/strand/ConsumedInvite]. Failed (never committed; local state reverted for retry):
  [default/app/Participant, default/strand/Member, default/strand/Member/index/_uniq_7.stampid, default/app/Message].
```

The app's participant and message are reverted. The test sees `['host', 'joiner']` and then, on the next read, `['host']` (`expected [ 'host' ] to deeply equal [ 'host', 'joiner' ]` at `strand-chat-participants-converge.integration.ts:152`, via `:359`).

This does not need the upstream regression. The reconciler's documented normal retry case is `consumeInvite` failing because the `Invite` row has not replicated yet (the `ValidUsage` deferred check at commit, reconciler.ts ~471). That rollback discards any app statements that ran inside the transaction in the same way. The reverse case is also wrong: if the reconciler's commit succeeds, the app's rows were committed by a transaction the app does not know about, after its `exec` had already resolved.

Other writers that use `inStrandTransaction` from a flow the app does not control have the same exposure (e.g. `removeMemberPeer` from strand-instance-manager.ts ~1064).

### Fix direction

Make every writer transaction indivisible on the shared connection, so no other caller's statement can run between its `begin` and `commit`:
- Preferred: compute everything asynchronous first (signature, `canonicalDatetime`), then run `begin; insert …; insert …; commit` as one `db.exec` batch with named parameters. `exec` holds Quereus's exec mutex for the whole batch. The joined-transaction mode (caller-owned transaction) keeps its current behaviour.
- Alternative: a per-strand write gate that both the background writers and the app-facing handle use. This is more invasive, because the app gets a raw `Database`.

## Defect 2: a half-committed join is classified as a "dead invitation"

`DEAD_INVITE_REJECTION = /NotExpired|NotCancelled|ConsumedInvite/i` (reconciler.ts:112) matches the `CoordinatorPartialCommitError` message, because that message names the collection `default/strand/ConsumedInvite`. The reconciler logs "consumed elsewhere" and clears the staged invitation. After that half-commit the invitation really is spent: `ConsumedInvite(InviteKey, MemberKey=<this party>)` is durable, and `Member.Authorized`'s invite branch needs a fresh same-transaction consumption. So the party can never be seated from it, and only a manager's direct admit can recover. Nothing reports this. It is also why `blind-relay-phone-to-phone-e2e` (3 of 3 runs) and the chat file's first test time out waiting for the joiner's `Member` seat.

### Fix direction

- Classify `CoordinatorPartialCommitError` (and the plugin's `PartialCommitError`) by type, before any message regex. Log it as a half-committed join that names the committed and failed collections, and surface it (`console.warn` / an event), not "consumed elsewhere". Anchor the dead-invite regex to the constraint names, not the bare table name.
- Decide (human call if it is not obvious) whether sereus should recover a party whose `ConsumedInvite` landed without its `Member` row. For example, a schema branch that seats `Member` against an existing `ConsumedInvite` naming the same `MemberKey`. The alternative is to rely on optimystic making the commit atomic again.

## Edge cases & interactions

- App writes issued while the reconciler is mid-transaction, for both reconciler commit success and failure.
- A reconciler pass racing the app's own explicit `beginTransaction()`. Today `inStrandTransaction` joins it (`getAutocommit()` false) and the app's commit or rollback decides the join.
- A join that fails on `ValidUsage` (Invite not replicated): no app row may be lost.
- The half-committed join: the classification, the log and the staged-invite handling.

## TODO

- Add a regression spec in cadre-core. Hold the reconciler's `consumeInvite` open (e.g. a slow `canonicalDatetime` or a failing deferred check), issue an app insert on the same `Database`, and assert the app row survives a reconciler rollback.
- Implement the indivisible writer transaction in `strand-membership-writer.ts`.
- Implement typed classification of partial-commit errors in the reconciler.
- Re-run `strand-chat-participants-converge`, `blind-relay-phone-to-phone-e2e` and `strand-membership-closed-strand-e2e` 3× each. Expect the Member-seat timeouts to remain until optimystic fixes the commit-phase regression, but no app rows should be lost.
