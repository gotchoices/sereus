description: When two people redeem the same invitation at the same instant on one machine, the one who loses is told "conflict, try again" rather than "this invitation is used up", so their client makes a pointless extra attempt before getting the real answer.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts
difficulty: easy
repro: static
----

<!-- resume-note -->
A prior run of this ticket completed investigation and root-cause analysis (below) but was cut
off by a token-budget warning before making any edits. No code has been changed yet. The plan
below is fully formed and ready to implement, not speculative — start straight from "TODO".

# A spent invitation is reported as a retryable conflict when the race is same-machine

## Root cause (confirmed by reading the code)

`packages/cadre-core/src/control-database.ts`, method `withUseNumberRetry` (currently around
line 1992-2031), body around line 2011-2014:

```ts
const useNumber = await this.nextUseNumber(token);
if (attempt > 1) {
  await this.assertSeatRemains(token, useNumber);
}
await write(useNumber);
```

`assertSeatRemains` (currently around line 2046) is the guard that turns an over-budget
`UseNumber` into `InvitationExhaustedError` (→ reported as `'Invalid token'` by
`StrandFormationManager.provisionAsResponder`, same as an already-spent invite). It is gated
behind `attempt > 1` on the theory that attempt 1 is "already gated by
`StrandFormationManager.validateToken`'s `isTokenUsed` check" — true for a joiner arriving after
the invite is already full, false for two joiners racing on the SAME node at the SAME instant:
both clear `isTokenUsed` before either has written, then serialize behind
`ControlDatabase.withWriteLock`'s single local write queue. The second one reads the use number
the first already committed — no collision, no retry, straight refusal on ITS FIRST attempt —
so the `attempt > 1` gate never fires for it. Its insert is refused by `FormationUsage
.Authorized`'s `TotalUses >= new.UseNumber` clause as a generic
`CHECK constraint failed: Authorized`, which is not recognised as a lost-seat case, so it
propagates to `StrandFormationManager.provisionAsResponder`'s catch-all and is reported to the
joiner as `'Formation conflict, retry'` — wrong: retrying can never succeed, the seat is gone.

This exact race is ALREADY covered mechanically (not by assertion-intent) by an existing test:
`packages/cadre-core/test/control-formation-use-number-retry.spec.ts`, describe block
`'concurrent redemptions on one node'`, test `'seats exactly one redemption of a SINGLE-use
invite and creates no extra seat'` (currently lines 356-372). It fires two concurrent
`db.recordFormationUsage(...)` calls against a `totalUses: 1` invite and currently asserts the
loser's rejection matches `/CHECK constraint failed: Authorized\b/` — i.e. it currently PINS the
buggy behaviour. Confirmed by reading, not run under a debugger, hence `repro: static` — but the
code path is unambiguous and the test's own inline comment ("non-retryable, so the retry cannot
manufacture a seat...") already anticipates roughly what should happen, it just asserts the wrong
error shape.

The `'reports an exhausted invitation by name rather than as a retryable conflict'` test
(currently around lines 521-544) is a DIFFERENT scenario: it stubs `nextUseNumber` to hand
attempt 1 a stale/already-taken number, forcing the redemption around to attempt 2, where the
existing `attempt > 1` guard already lives. That test's assertions are expected to survive the
fix untouched.

## Chosen fix shape (already designed, not just sketched)

Naive fix (drop `attempt > 1` unconditionally) makes EVERY redemption — including the
overwhelmingly common non-racing case — pay an extra `FormationInvite` read per attempt. Avoid
that on the production hot path by threading the invite's `TotalUses` down from callers that
already have it, and only falling back to a fresh read when a caller doesn't supply it.

Confirmed via reading `packages/cadre-core/src/control-formation-recorder.ts`
(`ControlFormationUsageRecorder`): BOTH of its write paths already call
`this.controlDatabase.queryFormationInvite(token)` before calling into `ControlDatabase`:
- `recordUsage` (around line 206) reads `invite` then calls `recordFormationUsage` (line 216).
- `provisionAndRecord` (around line 292) reads `invite` then calls `redeemInvitation` (line 297).

So the real production callers already have `invite.totalUses` in hand — passing it through
costs nothing extra there. Direct test callers of `ControlDatabase.recordFormationUsage` /
`redeemInvitation` that don't have an `invite` in hand simply omit the new param and get the old
read-based behaviour (fine for tests, not perf-sensitive).

### Concrete steps

1. In `control-database.ts`, change `withUseNumberRetry`'s private signature (currently line
   1992) to accept a new parameter, e.g. `knownTotalUses: number | null | undefined` (undefined
   = caller didn't supply it, look it up when needed).

2. In the locked body (currently lines 2005-2017), remove the `if (attempt > 1)` condition —
   call the seat-remains check on EVERY attempt, always, passing `knownTotalUses` through:
   ```ts
   const useNumber = await this.nextUseNumber(token);
   await this.assertSeatRemains(token, useNumber, knownTotalUses);
   await write(useNumber);
   ```

3. Change `assertSeatRemains` (currently line 2046) to accept the known value and only query
   `queryFormationInvite` when it wasn't supplied:
   ```ts
   private async assertSeatRemains(
     token: string,
     useNumber: number,
     knownTotalUses: number | null | undefined,
   ): Promise<void> {
     const totalUses = knownTotalUses !== undefined
       ? knownTotalUses
       : (await this.queryFormationInvite(token))?.totalUses ?? null;
     if (totalUses != null && useNumber > totalUses) {
       throw new InvitationExhaustedError(token, useNumber, totalUses);
     }
   }
   ```

4. Add an optional `totalUses?: number | null` field to the params objects of
   `redeemInvitation` (currently line 1831) and `recordFormationUsage` (currently line 1916);
   destructure it and pass it through to `withUseNumberRetry`'s new parameter at their call
   sites (currently lines 1865 and 1950).

5. In `control-formation-recorder.ts`, pass `totalUses: invite?.totalUses ?? null` in both
   `recordUsage`'s call to `recordFormationUsage` (line 216) and `provisionAndRecord`'s call to
   `redeemInvitation` (line 297) — the `invite` each already reads is right there.

6. Update stale doc comments that describe the old "only retries pay for this read" / "first
   attempt is already gated" reasoning now that it's no longer true:
   - `InvitationExhaustedError` class doc (currently lines 92-104) — "Raised only on a RETRY..."
     is no longer accurate; it can now be raised on attempt 1 too, for a same-node race.
   - `assertSeatRemains`'s own doc comment (currently right above its definition, ~lines
     2033-2045) — rewrite around "only retries pay for this read" to describe the
     known-value-vs-query tradeoff instead.
   - `withUseNumberRetry`'s doc comment mentions of the guard's placement, if any drift.
   - `strand-formation-manager.ts` around lines 283-291 (doc comment on `provisionAsResponder`)
     says `InvitationExhaustedError` is "raised once `ControlDatabase`'s use-number retry finds
     no seat left" — broaden this to note it can now also fire on a same-node race with no
     retry involved. This file needs a comment-only touch, no behavior change: the
     `InvitationExhaustedError` → `INVALID_TOKEN_REASON` mapping (catch block around line 349)
     already does the right thing today and needs no code change — confirmed by reading; a
     mocked-recorder test already pins that mapping
     (`test/strand-formation-consent.spec.ts` line 704,
     `'(p) an InvitationExhaustedError from the recorder maps to the same "Invalid token" a
     spent invite gives'`). Do not duplicate that test.

7. Update the existing test `'seats exactly one redemption of a SINGLE-use invite and creates
   no extra seat'` in `control-formation-use-number-retry.spec.ts` (currently lines 356-372) —
   this is that exact "two redemptions of a one-seat invitation issued concurrently against a
   single `ControlDatabase`" case that was originally missing coverage; it already exists, it
   just pins the OLD/buggy expectation. Change the loser's assertion from:
   ```ts
   expect(String(rejected.reason)).toMatch(/CHECK constraint failed: Authorized\b/);
   ```
   to asserting `InvitationExhaustedError` with `token`, `useNumber: 2`, `totalUses: 1` (mirror
   the assertion shape already used in the neighbouring `'reports an exhausted invitation by
   name...'` test, currently lines 533-540). Note: `Promise.allSettled` rejection reasons come
   back as `unknown`, same as `captureError`'s return in the neighbouring test — cast/check with
   `instanceof InvitationExhaustedError` the same way. Update the test's inline comment above
   that assertion (currently line 366-367, "The loser reads use #2 under the lock and is
   refused by `Authorized`'s seat clause — non-retryable...") to describe the new named-error
   outcome instead of the generic CHECK failure.

8. Leave the neighbouring `'reports an exhausted invitation by name rather than as a retryable
   conflict'` test (lines 521-544) as-is — its scenario (forced retry via stubbed
   `nextUseNumber`) and assertions are expected to survive unchanged; its inline comment about
   "Left to the database that would surface as a generic `Authorized` failure" can stay, since
   it's still describing what WOULD happen without the guard, which remains true.

## TODO

- Apply steps 1-5 above in `control-database.ts` and `control-formation-recorder.ts`.
- Apply the doc-comment updates in step 6 (`control-database.ts` + `strand-formation-manager.ts`).
- Update the existing test per step 7 in `control-formation-use-number-retry.spec.ts`.
- Run `yarn workspace @serfab/cadre-core test control-formation-use-number-retry` (and the
  broader `control-formation-invite.spec.ts` / `control-formation-consent-signature.spec.ts` /
  `control-revocation-replay.spec.ts` suites, since they also call `recordFormationUsage` /
  `redeemInvitation` directly without the new `totalUses` param and must still pass unchanged
  under the query-fallback path) to confirm nothing else regresses.
- Run `yarn lint` on the touched files.
- Produce the `review/` handoff ticket per normal workflow once implemented and green.
