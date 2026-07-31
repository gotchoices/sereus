description: Code that lets a node reuse an already-granted invitation approval after losing a race has been written but never compiled or run — build it, run the tests, and fix whatever breaks.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: medium
----

# Re-present a granted approval after a lost formation race — database layer

> **Continuation, same slug.** The prior implement run wrote the code and the new spec, then
> hit its token budget before running `yarn lint` / `yarn build` / `yarn test`. **Nothing
> below has been compiled or executed.** Treat the new spec as a draft that has never been
> green, not as passing coverage. The slug is unchanged so
> `debt-formation-approval-retry-wiring`'s `prereq:` still resolves.

## What already landed (unvalidated)

All in `packages/cadre-core/`.

### `src/control-database.ts`

- `import { … unwrapError } from '@quereus/quereus'` added.
- `InvitationExhaustedError(token, useNumber, totalUses)` — new exported error class, next to
  `FormationAbortedError`. Not added to `src/index.ts` (neither is `FormationAbortedError`).
- `USE_NUMBER_ATTEMPTS = 3` — module-private const.
- `LOST_USE_NUMBER_PATTERNS` + exported `isLostUseNumberRace(error: unknown): boolean`.
  Matches, over the whole `cause` chain via `unwrapError`:
  `/UNIQUE constraint failed: FormationUsage\.Token, FormationUsage\.UseNumber/i` and
  `/CHECK constraint failed: Monotonic\b/`. Deliberately not `instanceof`-gated — the deferred
  `Monotonic` failure is a bare `QuereusError`, not a `ConstraintError`.
- `private withUseNumberRetry(token, operation, signal, write)` — per attempt, under
  `withWriteLock`: abort check → `nextUseNumber` → (attempt > 1 only) `assertSeatRemains` →
  `write(useNumber)`. Retries only when `isLostUseNumberRace`; rethrows the last error when
  attempts run out.
- `private assertSeatRemains(token, useNumber)` — reads `queryFormationInvite`, throws
  `InvitationExhaustedError` when `totalUses != null && useNumber > totalUses`.
- `redeemInvitation` and `recordFormationUsage` both route their write through
  `withUseNumberRetry`; the `nextUseNumber` read moved inside the lock. `strandStampId` is
  still minted / read ONCE before the loop in each. Doc comments updated on both, plus on
  `nextUseNumber`.

### `test/control-formation-use-number-retry.spec.ts` (new, ~500 lines)

Boots its own `CadreNode` (`profile: 'transaction'`, empty bootstrap), enrolls an owner key and
one `ValidationKey`. Cases:

- classifier: real primary-key collision → true; real deferred `Monotonic` → true; real
  duplicate `UsageStampId` → false; real `Authorized` failure and non-`Error` values → false.
- two concurrent `recordUsage` calls on a two-use bound invite → use numbers `[1, 2]`, counting
  fake approver asked exactly twice.
- two concurrent redemptions of a **single**-use invite → exactly one lands, loser refused by
  `Authorized`, one row.
- a stale use number is retried and lands at #2 with the hook asked once; the stored row's
  `PeerKey` / `PeerSig` / `Disclosure` / `StrandId` are byte-identical to what was passed.
- `redeemInvitation` retry — pins that a failed attempt rolled the `Strand` insert back too.
- attempts are bounded (stubbed always-lost-race insert → exactly 3 writes).
- a duplicate nonce is written once and not retried.
- exhausted invite on a retry → `InvitationExhaustedError`.
- signal firing between attempts → `FormationAbortedError`, use number never re-read.
- expired invite → clean `Authorized` rejection, no retry.

Private members are shadowed through a `ControlDatabaseInternals` cast + a `withStubbed`
helper that `delete`s the own property to restore, following
`control-write-lock.spec.ts`'s `selfRegistrationTimerSlot` precedent.

## TODO

- Run, from `packages/cadre-core`, streaming output (`2>&1 | tee`, never silent redirect):
  `yarn lint`, `yarn build`, `yarn test`. Fix the fallout.
- **Expect the new spec to need iteration.** Specific things never checked once:
  - `unwrapError`'s exact export shape and whether its `ErrorInfo[]` includes the outermost
    message (it does per source, but this was read, not run).
  - Whether the deferred-`Monotonic` reproduction (raw insert of `UseNumber: 7` against an
    uncapped invite with zero prior uses) actually reaches `Monotonic` rather than being
    refused earlier by something else.
  - Whether `inTransaction`'s rollback really removes the `Strand` row on the
    `redeemInvitation` retry — that is what the rollback case asserts, and if it does NOT,
    `redeemInvitation` needs a fresh `strandStampId` per attempt or a different recovery, and
    the ticket's "mint once" instruction was wrong.
  - `withStubbed`'s `delete slot[name]` under TypeScript's `exactOptionalPropertyTypes` /
    the repo's lint rules.
  - `db.getDatabase().get(...)` / `.eval(...)` usage in the new helpers matches the sibling
    spec's.
- **Check `src/control-formation-recorder.ts` line ~267.** `provisionAndRecord`'s doc comment
  still says *"A concurrent redemption of the same single-use invite collides on the
  `(Token, UseNumber)` PK and this call THROWS for the loser"*. That is no longer how the
  loser fails on the same node — it now reads a fresh use number under the lock and is refused
  by `Authorized`'s seat clause (or by `InvitationExhaustedError` on a retry). Correct the
  paragraph. This was noticed but NOT edited.
- `test/control-formation-invite.spec.ts` line ~1241 (*"lets the loser of a use-number race
  retry the SAME approval under the next use number"*) was reviewed and left alone: it drives
  the retry manually through `rawInsertFormationUsage`, so it still passes and still pins the
  nonce-design rationale. Consider adding a one-line cross-reference to the new spec so the two
  are not read as duplicates. Confirm it is still green.
- Handoff to `review/` must be honest that the tests are a floor written blind, and must list
  which cases were confirmed by an actual run.

## Out of scope

Manager/recorder wiring (mapping `InvitationExhaustedError` to a joiner-visible rejection),
schema comments, and docs — those belong to `debt-formation-approval-retry-wiring`, which
already lists `debt-formation-approval-retry-lost-race` as its prereq.
