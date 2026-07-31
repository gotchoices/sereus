description: When two people redeem the same invitation at the same moment, the one who loses the race throws away an approval that was already granted, so a human approver gets asked to approve the very same join a second time. Make the database layer reuse the approval instead.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/formation-consent-helper.ts, schemas/control.qsql
difficulty: medium
----

# Re-present a granted approval after a lost formation race — database layer

> **Scope note (split from the original ticket).** This ticket is the `ControlDatabase`
> change plus its tests. The manager/recorder wiring, schema comments, and docs moved to
> `debt-formation-approval-retry-wiring`, which lists this one as its `prereq`.

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
  primary-key collision.
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

`InvitationExhaustedError` is consumed by the follow-on ticket
(`debt-formation-approval-retry-wiring`), which maps it to a joiner-visible rejection. Export it
here regardless — this ticket is what produces it.

## Findings from the prior (budget-truncated) investigation run

No code was changed. These are verified facts; do not re-derive them.

### Error surfaces — where the two lost-race messages actually come from

- `ConstraintError` **is** exported from `@quereus/quereus` (`packages/quereus/src/index.ts`
  line 22, alongside `QuereusError`, `MisuseError`, `AbortError`, `unwrapError`). It extends
  `QuereusError`; `code` defaults to `StatusCode.CONSTRAINT`. Subclasses `FailConflictError` /
  `RollbackConflictError` exist for `or fail` / `or rollback` statements — neither is used by
  this schema's writes, but both are `instanceof ConstraintError`.
- **PK collision path.** The optimystic vtab does NOT throw. It returns a structured result
  `{ status: 'constraint', constraint: 'unique', message, existingRow }`
  (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts` — the PK branch
  near line 1193, the key-move branch near line 1323, and the secondary-unique branch via
  `resolveUniqueConflict` near line 1101). `message` comes from `uniqueConstraintMessage`
  (line 817), which renders `UNIQUE constraint failed: <Table>.<Col>[, <Table>.<Col>…]` —
  **table name only, no `CadreControl.` schema prefix**. With no argument it names the primary-key
  columns, i.e. `FormationUsage.Token, FormationUsage.UseNumber`; the `UsageStampId` collision
  comes through the secondary-unique branch as `FormationUsage.UsageStampId`.
  Quereus turns that structured result into an error and `translateConflictError`
  (`../quereus/packages/quereus/src/runtime/emit/dml-executor.ts` line 573) leaves it a plain
  `ConstraintError` under the default ABORT resolution.
- **Deferred CHECK path — the trap.** A deferred CHECK failure is thrown at
  `../quereus/packages/quereus/src/runtime/deferred-constraint-queue.ts` line 197 as
  `new QuereusError('CHECK constraint failed: ' + entry.constraintName, StatusCode.CONSTRAINT)`
  — a bare `QuereusError`, **not** a `ConstraintError`. `Monotonic` is deferred (it has a
  subquery), so **`isLostUseNumberRace` must not gate on `instanceof ConstraintError`**; doing so
  silently drops the branch this ticket most needs.
- `QuereusError`'s constructor appends ` (at line N, column M)` to `message` when it carries
  location info, and `redeemInvitation` wraps its work in a transaction whose failure may arrive
  with a `cause` chain. Classify by **substring / regex over the message, walking the `cause`
  chain**, not by string equality. `unwrapError(err)` (exported from `@quereus/quereus`) already
  walks that chain and returns `{ message, name, code }[]` — prefer it over a hand-rolled
  `while (err.cause)`.
- Non-deferred CHECK failures render at `runtime/emit/constraint-check.ts` line 60 as
  `CHECK constraint failed: <name><exprHint>` — same prefix, so a prefix-only match would
  also swallow `Authorized`. Anchor on the constraint NAME with a word boundary, exactly as
  `expectConstraintFailure` does.

### Code locations (current line numbers, `packages/cadre-core/src/control-database.ts`)

| What | Line |
|---|---|
| `FormationAbortedError` (contract doc: never thrown once insert issued) | 79 |
| `redeemInvitation` (`nextUseNumber` read at 1391, outside the lock at 1393) | 1361 |
| `recordFormationUsage` (`nextUseNumber` read at 1473, outside the lock at 1475) | 1443 |
| `execFormationUsageInsert` — the bare insert both paths share | 1493 |
| `queryFormationInvite` (returns `totalUses`) | 1533 |
| `nextUseNumber` (private) | 1624 |
| `withWriteLock` — NOT re-entrant; re-entry hangs silently and strands the queue | 1166 |
| `inTransaction` (private, bare — safe to call from a locked body) | 1071 |

`redeemInvitation`'s doc comment (lines ~1355-1359) is the one that currently says callers
"must serialise" and that a holder of a sign-off "should retry a lost race with the SAME
`usageStampId`" — that becomes a description of what this class now does. Same for
`recordFormationUsage`'s abort-contract paragraph (~1456-1460), which says the signal is checked
"immediately before the insert is issued" — still true per attempt, but say per attempt.

### Test scaffolding that already exists — reuse, do not rebuild

- `packages/cadre-core/test/control-constraint-helpers.ts` — `expectConstraintFailure(write,
  ...names)` (regex `CHECK constraint failed: (a|b)\b`) and `expectUniqueViolation(write,
  ...cols)` (regex over the vtab wording). Both already document the message-shape dependency.
- `packages/cadre-core/test/formation-consent-helper.ts` — `mintJoiner()`, `mintConsent(token,
  disclosure?, joiner?)` (returns the spreadable `{ peerKey, usageStampId, peerSignature }`
  triple), `signJoinerConsent(...)`.
- `packages/cadre-core/test/control-formation-invite.spec.ts` (1520 lines) — boots a real
  `CadreNode` (`profile: 'transaction'`, empty bootstrap) in `beforeAll`, exposes `db`, `rawDb`,
  `signMessage`, and counters `inviteCount` / `strandCount` / `usageCount`. It also has a
  private `rawInsertFormationUsage(opts)` helper (line 81) that issues the bare insert with every
  derived field caller-controlled — that is the cheapest way to plant a colliding
  `(Token, UseNumber)` row or a duplicate `UsageStampId` and capture the REAL engine errors for
  the classifier test.
- **Read `control-formation-invite.spec.ts` line 1241 first** — an existing case named
  *"lets the loser of a use-number race retry the SAME approval under the next use number"*
  already exists in the approval-replay block. Determine whether it asserts the manual
  (caller-driven) retry that this ticket automates; extend or re-point it rather than adding a
  near-duplicate.
- `packages/cadre-core/test/control-write-lock.spec.ts` documents the deterministic-concurrency
  idiom (every writer reaches `withWriteLock` synchronously, so call order is queue order) and
  the repo precedent for test-only private access (`selfRegistrationTimerSlot`, line 39).

### Schema facts

- `FormationUsage` — `schemas/control.qsql` lines 479-608. `primary key (Token, UseNumber)`
  (line 514); `Monotonic` (516-524) reads `committed.FormationUsage` and its comment already
  says "concurrent redemptions of the same token collide on the `(Token, UseNumber)` PK";
  `Authorized`'s seat check `FI.TotalUses is null or FI.TotalUses >= new.UseNumber` is line 530;
  the "Why a fresh nonce rather than binding UseNumber" rationale is lines 553-559.
- `schemas/control.qsql` and `CONTROL_SCHEMA` in `packages/cadre-core/src/control-schema.ts` are
  two hand-maintained copies of one text; `control-schema-drift.spec.ts` fails the build on a
  one-sided edit. **This ticket should not need to touch either** — the schema-comment edit is in
  the follow-on wiring ticket. If you do touch one, edit both identically.

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
- **`recordFormationUsage`'s `queryStrandStampId` / `MissingHostStrandError`.** Read once before
  the loop, as today — the host strand is pre-existing and owner-signed, and a retry does not
  change which strand row is named.
- **Write-lock re-entrancy.** `withWriteLock` is **not** re-entrant and re-entry hangs forever,
  silently. The helper takes the lock per attempt and its `write` callback must be a bare private
  body (`inTransaction` / `execFormationUsageInsert`), never another locked public method.

## Tests

New/extended cases, in `packages/cadre-core/test/` (the real-database formation cases live in
`control-formation-invite.spec.ts`; a focused new spec is fine — that file is already 1520 lines):

- *concurrent redemptions of a two-use invite both land* — fire both in the same tick without
  awaiting the first (the deterministic-concurrency idiom `control-write-lock.spec.ts`
  documents). Assert use numbers `[1, 2]`, two rows, and a counting fake approver asked exactly
  twice.
- *a lost use number is retried with the same approval* — pre-insert use #1 through the normal
  path, then force a stale number by stubbing the private `nextUseNumber` to return `1` once and
  delegate afterwards. Assert the redemption succeeds at use #2, the approver was asked **once**,
  and the stored row's nonce/signature/peer/disclosure match what was passed in.
- *the classifier accepts a real primary-key collision and rejects a real nonce collision* —
  produce both errors from the actual engine via `rawInsertFormationUsage` (insert the same
  `(Token, UseNumber)` twice; insert the same `UsageStampId` under a different use number) and
  assert `isLostUseNumberRace` is `true` / `false`. Add a third case that produces a real
  deferred `CHECK constraint failed: Monotonic` and asserts `true` — that is the branch the
  `instanceof ConstraintError` trap above would silently break.
- *retries terminate* — a stub that always reports a lost race must reject after
  `USE_NUMBER_ATTEMPTS` writes, not spin.
- *an exhausted invite is not given an extra seat* — force a stale number on a `TotalUses: 1`
  invite whose single use is already spent; assert `InvitationExhaustedError` and one row total.
  (The `provisionAsResponder` mapping half of this case belongs to the wiring ticket.)

## TODO

- Move the `nextUseNumber` read inside the locked body in both `redeemInvitation` and
  `recordFormationUsage`.
- Add `isLostUseNumberRace(err)` (exported) covering the `(Token, UseNumber)` unique violation and
  the deferred `Monotonic` check failure, explicitly excluding the `UsageStampId` violation.
  Walk the `cause` chain (`unwrapError`); do NOT gate on `instanceof ConstraintError`.
- Add exported `InvitationExhaustedError`.
- Add the `withUseNumberRetry` helper with `USE_NUMBER_ATTEMPTS = 3`, the per-attempt abort check,
  and the retry-only seat check; route both write paths through it.
- Update the `redeemInvitation` and `recordFormationUsage` doc comments — the "callers must
  serialise" / "should retry a lost race with the SAME `usageStampId`" advice is now a
  description of what this class does.
- Add the tests above.
- Validate: `yarn lint`, `yarn build`, `yarn test` in `packages/cadre-core` (stream output with
  `| tee`; never silent-redirect).
