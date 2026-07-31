description: When two people redeem the same invitation at the same moment, the one who loses the race throws away an approval that was already granted, so a human approver gets asked to approve the very same join a second time. Reuse the approval instead.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/control-formation-invite.spec.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

# Re-present a granted approval after a lost formation race

## What is wrong today

An invitation may carry a `ValidationUrl` — a web hook that is asked whether one specific
person may redeem it. The hook can be a human review queue. The approver signs over five
fields: token, nonce (`UsageStampId`), strand id, joining peer key, and disclosure text.
The **use number is deliberately not among them** (`FormationUsage.Authorized` in
`schemas/control.qsql`, "Why a fresh nonce rather than binding UseNumber"), precisely so a
node that loses a write race can re-present the same approval under a different use number.

Nothing uses that affordance. Both write paths in `ControlDatabase` compute
`UseNumber = max+1` (`nextUseNumber`) **before** taking the write lock, so two redemptions of
one token pick the same number, one insert loses, and the loser's error reaches
`StrandFormationManager.provisionAsResponder`'s catch-all, which answers
`Formation conflict, retry`. The joiner restarts formation, mints a fresh nonce, and the hook
is asked a second time about a join a human already approved.

## Shape of the fix

Two independent changes, both inside `ControlDatabase`:

**1. Compute the use number inside the write lock.** `redeemInvitation` and
`recordFormationUsage` both read `nextUseNumber(token)` outside `withWriteLock`. Reads take no
transaction and are safe inside a locked body (`execFormationUsageInsert` already runs a
`select` there), so move the read in. That alone removes the collision entirely for two
redemptions hitting the **same node** — the common case — because the local write queue
serializes them and each computes a fresh number.

**2. Retry the write, unchanged, when a use number is taken anyway.** Writers this lock does
not cover (another node of the cadre, another `Database` handle over the same store) can still
take the number between our read and our commit. Wrap [compute number → check the invite still
has a seat → write] in a bounded attempt loop. Every parameter — nonce, approver signature,
strand id, peer key, disclosure — is passed through untouched, so *by construction* the retry
re-presents the identical approval and the four non-nonce signed fields cannot drift. No new
call to the hook is possible from inside the loop: `obtainApproval` lives one layer up, in
`ControlFormationUsageRecorder`, and is never re-entered.

Suggested shared private helper on `ControlDatabase`, used by both write paths (they differ
only in what the write does — a bare insert vs. a `Strand`+`FormationUsage` transaction):

```ts
/** Attempts allowed per redemption: the first, plus two retries of a lost use number. */
const USE_NUMBER_ATTEMPTS = 3;

private async withUseNumberRetry(
  token: string,
  operation: string,                       // 'redemption' | 'usage recording', for error text
  signal: AbortSignal | undefined,
  write: (useNumber: number) => Promise<void>,
): Promise<number>
```

Per attempt, under `withWriteLock`: throw `FormationAbortedError` if the signal is already
aborted (nothing has been written, so this stays inside that error's documented contract);
read `nextUseNumber`; on attempts after the first, re-check the invite's seat budget; call
`write(n)`. On a lost-race error, loop; on anything else, rethrow. After the last attempt,
rethrow the last error — the manager then returns today's `Formation conflict, retry`.

### Classifying a lost race

Retry **only** on "another writer took this use number". Two distinct errors mean that, and
both must be accepted:

- `UNIQUE constraint failed: FormationUsage.Token, FormationUsage.UseNumber` — the
  primary-key collision, raised by the optimystic vtab as a structured `unique` violation that
  Quereus rethrows as `ConstraintError` (exported from `@quereus/quereus`, along with
  `StatusCode`). Message shape confirmed by `optimystic-module.ts` → `uniqueConstraintMessage`
  and by the existing `ConsumedInvite.InviteKey` precedent in `docs/architecture.md`.
- `CHECK constraint failed: Monotonic` — `FormationUsage.Monotonic` has a subquery so it defers
  to commit and reads `committed.FormationUsage`. A concurrent row that our insert's key probe
  did not see still trips this at commit. Same meaning, different surface; missing it would
  drop the exact approval this ticket exists to keep.

Everything else is non-retryable and keeps today's behaviour, in particular:

- `UNIQUE constraint failed: FormationUsage.UsageStampId` — a duplicate nonce. **Never retry**:
  the nonce is single-use by design and re-presenting it is replay, not a lost race.
- `CHECK constraint failed: Authorized` (bad approval, expired invite, exhausted invite),
  `PeerConsented`, `StrandExists`, `FormationApprovalError`, `FormationAbortedError`,
  `MissingHostStrandError`, and any unrelated write failure.

Put the predicate in one exported, tested function — e.g. `isLostUseNumberRace(err): boolean` in
`control-database.ts` — rather than inline string tests at two call sites. It is the one piece
of this change that depends on error text, so it gets its own test against errors the real
engine produced (see tests below).

### Keeping single-use accounting honest

Retrying must not manufacture a seat. `FormationUsage.Authorized` already enforces
`FI.TotalUses is null or FI.TotalUses >= new.UseNumber`, so a retry past the limit fails at the
database — but it fails as a generic `CHECK constraint failed: Authorized`, which the manager
would report as `Formation conflict, retry`, telling the joiner to retry something that can
never succeed. So on retry attempts, read the invite (`queryFormationInvite`, already on this
class) and if `totalUses !== null && useNumber > totalUses`, stop without attempting the write
and throw a new exported `InvitationExhaustedError(token, useNumber, totalUses)`.

The first attempt skips this check: `StrandFormationManager.validateToken` already gates on
`isTokenUsed` before any of this runs, and re-reading the invite on the common path costs a read
per redemption for nothing.

### What the joiner is told

`provisionAsResponder`'s catch gains one branch: `InvitationExhaustedError` →
`{ approved: false, reason: 'Invalid token' }`, with the exhaustion detail in the local `log`
line. Deliberately reusing the existing wording rather than minting `'Invitation fully
redeemed'`: `strand-formation-protocol.ts` already answers `'Invalid token'` when the up-front
`validateToken` finds the invite used up, and a joiner that arrives a moment later gets exactly
that — so the race-loser sees the same string as the non-racing case, and no new distinction
between "invalid" and "exhausted" is exposed on the wire. Operator signal lives in the log.

## Edge cases & interactions

- **Two redemptions, same node, multi-use invite (`TotalUses: 2`).** Both must succeed with use
  numbers 1 and 2, and the hook must be asked exactly twice (once per joiner), not three times.
  This is the primary regression test; after change (1) it passes without any retry firing.
- **Two redemptions, same node, single-use invite (`TotalUses: 1`).** Exactly one succeeds. The
  loser is rejected — `validateToken`'s `isTokenUsed` gate or the exhaustion check, depending on
  timing — and **no** third row appears. The retry must not create a seat.
- **Retry that succeeds.** With a use number already taken, the write fails, the loop recomputes,
  the second attempt lands. The row that lands must carry the **same** `UsageStampId`,
  `ValidationKey`, `ValidationSignature`, `PeerKey`, `PeerSig`, `Disclosure`, and `StrandId` as
  the first attempt.
- **Retry that exhausts its attempts.** Sustained contention must terminate and surface today's
  clean rejection, not loop. Assert the attempt count is bounded.
- **Duplicate nonce is not a race.** A second write with an already-used `UsageStampId` must fail
  on the first attempt with no retry at all (assert the write was attempted once).
- **Abort mid-loop.** A signal that fires between attempts must throw `FormationAbortedError`
  with no row written and no further attempt — the manager rethrows it and the listener's timeout
  path owns the reply. A signal that fires *after* an insert is issued must still not be checked
  (the existing contract; the settle grace adopts that write).
- **Expiry crossed between attempts.** `nowMs` is re-derived per attempt, so an invite that
  expires mid-loop fails `Authorized` on the retry — non-retryable, clean rejection. Correct;
  just do not pin `nowMs` outside the loop.
- **Bound path (`recordFormationUsage`) gets this too.** Production (`cadre-web.ts` /
  `cadre-phone.ts`) publishes strand-**bound** invites, so the bound record-only path is the one
  that actually races in the field. Both paths must share the helper.
- **`redeemInvitation`'s `strandStampId`.** Minted once, before the loop, and reused: a failed
  attempt rolls the whole transaction back so nothing persisted under it, and the stamp is
  deliberately not part of the approver's signed digest. Do not re-mint per attempt.
- **Write-lock re-entrancy.** `withWriteLock` is **not** re-entrant and re-entry hangs forever,
  silently. The helper takes the lock per attempt and its `write` callback must be a bare private
  body (`inTransaction` / `execFormationUsageInsert`), never another locked public method.
- **Schema copies.** `schemas/control.qsql` and `CONTROL_SCHEMA` in
  `packages/cadre-core/src/control-schema.ts` are two hand-maintained copies of one text;
  `control-schema-drift.spec.ts` fails the build on a one-sided edit. Any comment touched must be
  edited in both, identically.

## Tests

New/extended cases, in `packages/cadre-core/test/` (the real-database formation cases live in
`control-formation-invite.spec.ts`; a focused new spec is fine if that file is already long):

- *concurrent redemptions of a two-use invite both land* — fire both in the same tick without
  awaiting the first (the deterministic-concurrency idiom `control-write-lock.spec.ts`
  documents: every writer reaches `withWriteLock` synchronously, so call order is queue order).
  Assert use numbers `[1, 2]`, two rows, and a counting fake approver asked exactly twice.
- *a lost use number is retried with the same approval* — pre-insert use #1 through the normal
  path, then force a stale number by stubbing the private `nextUseNumber` to return `1` once and
  delegate afterwards (repo precedent for test-only private access:
  `selfRegistrationTimerSlot` in `control-write-lock.spec.ts`). Assert the redemption succeeds at
  use #2, the approver was asked **once**, and the stored row's nonce/signature/peer/disclosure
  match what was passed in.
- *the classifier accepts a real primary-key collision and rejects a real nonce collision* —
  produce both errors from the actual engine (insert the same `(Token, UseNumber)` twice; insert
  the same `UsageStampId` under a different use number) and assert `isLostUseNumberRace` is
  `true` / `false`. This is what stops the message-text dependency drifting silently.
- *retries terminate* — a stub that always reports a lost race must reject after
  `USE_NUMBER_ATTEMPTS` writes, not spin.
- *an exhausted invite is not given an extra seat* — force a stale number on a `TotalUses: 1`
  invite whose single use is already spent; assert `InvitationExhaustedError`, one row total, and
  that `provisionAsResponder` maps it to `reason: 'Invalid token'`.

## TODO

Phase 1 — database

- Move the `nextUseNumber` read inside the locked body in both `redeemInvitation` and
  `recordFormationUsage`.
- Add `isLostUseNumberRace(err)` (exported) covering the `(Token, UseNumber)` unique violation and
  the deferred `Monotonic` check failure, explicitly excluding the `UsageStampId` violation.
- Add exported `InvitationExhaustedError`.
- Add the `withUseNumberRetry` helper with `USE_NUMBER_ATTEMPTS = 3`, the per-attempt abort check,
  and the retry-only seat check; route both write paths through it.
- Update the `redeemInvitation` doc comment — it currently says callers "must serialise" and that
  a holder of a sign-off "should retry a lost race with the SAME `usageStampId`"; that is now
  what this class does, not advice to the caller. Same for `recordFormationUsage`.

Phase 2 — manager and recorder

- Map `InvitationExhaustedError` to `{ approved: false, reason: 'Invalid token' }` in
  `provisionAsResponder`, logging the token, attempted use number, and limit.
- Replace the `NOTE:` at the catch-all in `strand-formation-manager.ts` (it points at
  `tickets/backlog/debt-formation-approval-retry-lost-race.md`) with a statement of what now
  happens: the approval is retried in the database layer, and reaching this catch means the retry
  was exhausted or the failure was never retryable.
- Update `provisionAndRecord`'s doc comment in `control-formation-recorder.ts` — "this call
  THROWS for the loser" is no longer the whole story.

Phase 3 — schema comments and docs

- In **both** schema copies, extend `FormationUsage.Monotonic`'s comment (which says concurrent
  redemptions "collide on the `(Token, UseNumber)` PK") to name `ControlDatabase`'s retry as what
  resolves that collision, and note that the deferred check is the other surface the same race
  can take. Keep the two files byte-identical.
- `docs/architecture.md`: in the `StrandFormationManager` / formation section, state that a
  redemption that loses a use number is retried with the same approval and that the approval hook
  is asked once per join, not once per attempt.
- `docs/STATUS.md`: the "Control DB local write serialization — covered" section lists recovery
  from a lost race as covered only for the peer-record path; add the formation use-number race and
  its new specs.

Phase 4 — validate

- `yarn lint`, `yarn build`, and `yarn test` in `packages/cadre-core` (stream output with `| tee`;
  never silent-redirect).
