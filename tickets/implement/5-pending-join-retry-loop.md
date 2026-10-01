description: Let an app ask to join through an invitation and have the party keep trying in the background, across restarts and from any of its owner machines, until the join works, the invitation is used up or expires, or the user cancels; the app can read and follow the status.
prereq: formation-rejection-codes, pending-join-control-table
architecture: docs/strands.md#what-a-joiners-node-remembers
files: packages/cadre-core/src/pending-join-runner.ts (new), packages/cadre-core/src/cadre-node.ts (formStrand ~8065, rememberFormedStrand, adoptFormationMembershipInvite ~8146, pendingMembershipInvites, enrolledOwnerSigningKey ~2441, start()/stop(), encodeInvitation/decodeInvitation ~8380), packages/cadre-core/src/strand-formation-deadlines.ts (formationDeadlines), packages/cadre-core/src/strand-formation-manager.ts (MEMBERSHIP_INVITE_TTL_MS ~60), packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/types.ts (CadreNodeEvents ~1478), packages/cadre-core/src/index.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts (harness to copy), docs/strands.md, docs/api.md, docs/architecture.md
----
# Pending join: request, retry, status

Part of gotchoices/sereus#25 (split from the plan ticket `durable-pending-join`). Builds on `pending-join-control-table` (the `PendingJoin` table and its `ControlDatabase` methods) and `formation-rejection-codes` (`FormationRejectedError` / `FormationUnreachableError` with `retryable`).

**Scope limit: owner machines only.** Every write to `PendingJoin`, and the `StrandPartyKey` a closed-strand join seats, is owner-signed. A donated always-on node (cadre-host donation, a cadre-provider container) holds no owner key. Letting such a machine finish a join needs a schema decision, filed as `blocked/decide-non-owner-machine-completes-a-pending-join`. Here the loop runs on every machine whose `enrolledOwnerSigningKey()` is non-null: the phone while its node runs, a founding cadre-cli node, a cadre-host running its own cadre. Write it so that adding non-owner machines later means changing who may write, not restructuring the loop.

## API (`CadreNode`)

```ts
interface PendingJoinStatus {
  id: string;                    // PendingJoin.Id
  sAppId: string;
  requestedAt: number;
  expiresAt: number;
  state: 'pending' | 'trying' | 'waiting' | 'joined' | 'failed';
  nextAttemptAt?: number;        // 'waiting'
  lastError?: { code: FormationRejectionCode | 'unrecognized' | 'unreachable'; reason: string }; // 'waiting'
  strandId?: string;             // 'joined'
  failure?: { code: string; reason: string }; // 'failed'
}
```

`pending`, `joined` and `failed` come from the row and are the same on every machine. `trying` (an attempt is running here) and `waiting` (the last attempt here failed in a way worth retrying, so the inviter is unreachable or not ready, with the next attempt at `nextAttemptAt`) are this machine's own view of a pending row. That is the issue's "trying, waiting for the inviter".

- `requestJoin(invitation, disclosure = {}): Promise<PendingJoinStatus>`:
  - Throws on a machine that is not an owner, naming `formStrand` as the one-shot alternative, and throws on an invitation already past its `expiration`.
  - Writes the row (`ExpiresAt = min(invitation.expiration, now + MAX_PENDING_JOIN_MS)`, with `MAX_PENDING_JOIN_MS` = 30 days, because the expiration is chosen by the inviter). If the row exists: a pending row is adopted as is, and a `joined` or `failed` row is replaced by a fresh pending one (the user asked again).
  - Runs one attempt **at once** on this machine and returns the status after it. The common online case is as fast as `formStrand` is today.
- `listPendingJoins(): Promise<PendingJoinStatus[]>`.
- `dismissPendingJoin(id): Promise<boolean>`: removes the row. On a pending row this is "cancel": every machine stops at its next read.
- Event `'pendingJoin:changed': PendingJoinStatus`, emitted when this machine's view of a row changes, whether its own attempt or a row change it read.

`formStrand` stays the one-shot primitive with no row.

## The loop (`PendingJoinRunner`, new file)

`cadre-node.ts` is over 8,000 lines (`debt-cadre-node-single-file-size`), so the policy goes in its own module. `CadreNode` passes in plain functions: read the rows, run one attempt (its own `formStrand`), write an outcome, check whether this machine is an owner, plus the clock. This is a seam the node owns, and it is what lets the policy be tested without a network.

- **Reading.** Every `PENDING_JOIN_POLL_MS` (30 s), and once right after start, read `queryPendingJoins()`. Emit changes. Skip the pass when this machine is not an owner (checked per pass; a machine can be enrolled as an owner later).
- **Scheduling, per pending row, on this machine:**
  - A row this machine did not write: first attempt after a stagger in `[0, base)`, derived from a hash of (this peer id, row id). Two owner machines of the party then rarely start together; this answers the issue's "stagger by machine" question.
  - `base = 2 × formationDeadlines(L).dialMs` (39 s at the default declared link of 3.5 s), so the pace follows `network.linkRoundTripMs` as the issue asks.
  - After a retryable failure: wait `min(base × 2^(n−1), PENDING_JOIN_MAX_BACKOFF_MS)` with ±20 % jitter, where `PENDING_JOIN_MAX_BACKOFF_MS` is 10 min.
  - One attempt in flight per row, at most 2 per machine.
- **Classifying an attempt:**
  - approved (`formStrand` resolved; it has already recorded the strand addresses, seated the party key, staged the membership invitation and remembered the join, as today) → `replacePendingJoin` the row to `joined`, with `StrandId` and, for a closed strand, `MembershipInvite`.
  - `FormationUnreachableError`, or `FormationRejectedError` with `retryable` → `waiting`, schedule the next attempt.
  - `FormationRejectedError` `token-spent` → see "Spent" below.
  - Any other final `FormationRejectedError` (`approval-refused`, `approval-invalid`, `host-strand-must-be-recreated`, `consent-invalid`, `disclosure-invalid`, `disclosure-too-large`) → `failed` with that code and reason.
  - Approved, then a local step failed: `formStrand`'s two "was approved (its one-time token is spent)" throws in `adoptFormationMembershipInvite` and `rememberFormedStrand`. Give them a typed `FormationPostApprovalError` (exported) → `failed` with code `'local'`. Retrying cannot help: the token is spent.
  - Any other thrown error → log it and treat it as retryable. Retrying is safe because nothing is retried after the expiry.
  - At or after `ExpiresAt` with the row still pending → `failed` with code `'expired'`, written by whichever owner machine notices first.
- **Spent.** A `token-spent` answer may mean a sibling machine of this party won the race (the maintainer note on #25). Before failing:
  1. Re-read the row. If it is no longer pending, adopt it and stop.
  2. Otherwise schedule **one** confirming attempt after `2 × formationDeadlines(L).sessionMs`, long enough for a winning sibling's `joined` write to replicate.
  3. If that attempt also answers `token-spent` and the row is still pending → `failed` with `token-spent`.
- **Writing outcomes.** Every outcome goes through `replacePendingJoin(expectedStampId, …)`. On `PendingJoinChangedError`, re-read and resolve:
  - row now `joined` → adopt it (with an unlimited-use invitation both machines may have joined; harmless, since the membership is the party's);
  - row now `failed`, and this machine holds a successful join → replace `failed` with `joined` (`joined` always wins);
  - row gone (dismissed while the attempt ran) → keep the join this machine made (it is already remembered machine-locally, as any `formStrand` is) and do not recreate the row;
  - a `failed` outcome never replaces `joined`.
- **Finished rows.** `joined` and `failed` rows stay until `dismissPendingJoin`, or until an owner machine's pass removes them `MEMBERSHIP_INVITE_TTL_MS` (7 days) after `OutcomeAt`. By then the carried membership invitation is dead, and an app that was not running has seen the strand arrive through `strand:discovered`.

## The membership invitation on other machines

A background join of a closed strand may be finished on one owner machine and launched first on another. The phone claims the `strand:discovered` row while the always-on machine that made the join does not host it. The staged invitation lives in the finishing machine's memory (`pendingMembershipInvites`). Without a copy, the launching machine's membership reconciler has nothing to redeem, and the party never gets its `Strand.Member` seat.

So each pass also stages from the rows. For each `joined` row that carries a `MembershipInvite`, is younger than `MEMBERSHIP_INVITE_TTL_MS`, and has an `inviteKey` this process has not staged yet: if `pendingMembershipInvites` has no entry for `StrandId`, set it and call `strandManager.notifyMembershipInviteStaged`. Record the `inviteKey` in a per-process set, so a settled invitation is not staged again every pass. A restart stages it once more; the reconciler finds it spent or the party already seated and settles it. The party key comes from the replicated `StrandPartyKey` row the finishing machine seated.

## Edge cases & interactions

- **Two owner machines finish the same unlimited-use invitation.** Both rows of work succeed, and one `joined` write wins. Both machines remembered the same strand id machine-locally, and the `JoinedStrand` publish is idempotent per id. Inspection of `JoinedStrandSession.publish`.
- **Two machines redeem the same staged membership invitation.** One `consumeInvite` wins. The other's reconciler must settle it as spent and still write its own `MemberPeer` binding, because the party is seated. Verify by reading `strand-membership-reconciler.ts`. If it does not, that is a defect for this ticket to fix.
- **Half-committed redemption** (`ConsumedInvite` saved, `Member` not) is unchanged by this ticket: `blocked/strand-half-committed-join-recovery`.
- **`stop()` during an attempt.** `formStrand` takes no abort signal. `stop()` clears the runner's timers and starts no new attempt, but does not wait for one in flight. An approval that lands while the node stops may lose its local records. The row then stays pending, and the next start's attempt answers `token-spent`, which ends in `failed` after confirmation. That is honest and bounded. Put a `NOTE:` at the runner's stop.
- **Restart.** The row is the durable state. Backoff counters and `trying`/`waiting` are memory only, so a restarted machine starts with its stagger again. Inspection.
- **Owner enrollment changes mid-loop.** A machine that stops being an owner mid-attempt: its outcome write is refused by the schema, and it logs and leaves the row for an owner. No retry storm, because the next pass skips it.
- **App calls `formStrand` directly for the same invitation** while a row is pending. Nothing coordinates the two; one of them gets `token-spent`. Document `requestJoin` as the path for apps that want retries.
- **Expiry while waiting.** A scheduled attempt whose time falls after `ExpiresAt` writes `failed: expired` instead of dialling.
- **Disclosure.** Each attempt runs `formStrand` with the stored disclosure, so each attempt mints its own consent key and stamp, as today. The responder sees a different `memberKey` per attempt. That is expected; the consent covers the stored disclosure text.
- **Logs** print row ids, codes and strand ids, never the invitation or the membership invitation.

## Tests

- **Runner policy, one table-driven spec** (`pending-join-runner.spec.ts`) over the injected seam with a fake clock:
  - a retryable rejection schedules with growing backoff;
  - `token-spent` twice → `failed`, while `token-spent` followed by a re-read showing `joined` → adopted;
  - a final rejection → `failed` with its code;
  - `FormationPostApprovalError` → `failed: local`;
  - past `ExpiresAt` → `failed: expired` without an attempt;
  - `PendingJoinChangedError` on a success over a `failed` row → `joined`.

  This is the branching the issue is about. No test of the scheduling arithmetic beyond "grows".
- **One integration scenario** (new, copying `strand-formation-e2e`'s harness): the inviter's node is stopped. The invitee (an owner) calls `requestJoin`, which returns `waiting`. The invitee node is then **restarted**, and the inviter started. The join completes with no further app call: `pendingJoin:changed` reaches `joined`, and the strand is launched and seated on the invitee. This pins the durability the issue reported (kjeib's repro shape) end to end.

## TODO

- `FormationPostApprovalError` on `formStrand`'s two post-approval throws; export it.
- `pending-join-runner.ts` with the policy above, behind the injected seam.
- `CadreNode`: `requestJoin`, `listPendingJoins`, `dismissPendingJoin`, the event, runner start and stop, and staging from `joined` rows.
- Types and exports: `PendingJoinStatus`, the event in `CadreNodeEvents`, the constants.
- Tests above.
- Docs:
  - `docs/strands.md`: a new subsection under "What a joiner's node remembers", "Joining while the inviter is offline", covering the row, who retries, the status states, spent handling, and the owner-only limit with a link to the blocked decision;
  - `docs/api.md`: the three methods and the event;
  - `docs/architecture.md`: one sentence and a link where the control table list mentions `PendingJoin`;
  - a release-note bullet in `.release-notes.pending.md`.
- `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/cadre-core test`, and the new integration scenario.
