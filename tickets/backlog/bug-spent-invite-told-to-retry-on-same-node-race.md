description: When two people redeem the same invitation at the same instant on one machine, the one who loses is told "conflict, try again" rather than "this invitation is used up", so their client makes a pointless extra attempt before getting the real answer.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts
difficulty: easy
----

# A spent invitation is reported as a retryable conflict when the race is same-machine

## What happens

An invitation carries a seat budget (`FormationInvite.TotalUses`). A joiner is checked against
it twice: once up front (`StrandFormationManager.validateToken` → `isTokenUsed`) and once at the
write (`FormationUsage.Authorized`, whose clause is `TotalUses is null or TotalUses >= UseNumber`).

Two joiners arriving at the same node at the same moment both clear the up-front check before
either has written. They then serialize behind the node's single write queue
(`ControlDatabase.withWriteLock`), so the second one reads the use number the first already
committed — no collision, no retry. Its insert is refused by `Authorized` on its FIRST attempt,
which surfaces as a generic `CHECK constraint failed: Authorized`. That is not recognised as a
lost use-number race, so it is rethrown straight to
`StrandFormationManager.provisionAsResponder`'s catch-all and reported to the joiner as
**`'Formation conflict, retry'`** — an invitation with no seat left, described as something worth
retrying.

## Why the existing guard misses it

`ControlDatabase.assertSeatRemains` exists precisely to turn this case into
`InvitationExhaustedError` (→ reported as `'Invalid token'`, the same answer a plainly-spent
invitation gives). But it is called only on attempt 2 and later:

```ts
const useNumber = await this.nextUseNumber(token);
if (attempt > 1) {
  await this.assertSeatRemains(token, useNumber);
}
```

The comment justifying that says the first attempt "is already gated by
`StrandFormationManager.validateToken`'s `isTokenUsed` check" — true for a joiner arriving after
the invitation filled up, and false for exactly the concurrent case above, which is the one that
gets past that gate. So the named error only ever fires for the cross-node / cross-`Database`
race (the one that does collide and does retry), not for the same-node race, which is the more
common shape.

## Impact

Cosmetic-plus, not a hang. The misled joiner's next attempt hits the up-front `isTokenUsed` check
— the winner has committed by then — and is told `'Invalid token'` correctly. So the cost is one
wasted round trip and a wrong reason string in the interim, not the never-closing retry loop the
guard's own doc comment warns about. Filed because the reason string is wire-visible and is what
a joining client shows a human.

## Shape of a fix (not prescriptive)

The naive fix — drop the `attempt > 1` condition — makes every redemption pay an extra
`FormationInvite` read. Note that `ControlFormationUsageRecorder.provisionAndRecord` **already**
reads the invite (`queryFormationInvite`) before obtaining approval, so the seat budget may
already be in hand a layer up; and `recordFormationUsage`'s caller may be able to do the same.
Whoever takes this should weigh passing the known budget down against paying the read.

Whatever the mechanism, the observable requirement is: **a redemption refused because the
invitation has no seat left is reported to the joiner the same way an already-fully-redeemed
invitation is, regardless of whether the race that exposed it was same-machine or cross-machine.**

## Coverage

`packages/cadre-core/test/control-formation-use-number-retry.spec.ts` → "reports an exhausted
invitation by name rather than as a retryable conflict" covers only the retry path: it stubs
`nextUseNumber` to hand attempt 1 a stale number so the redemption is forced around to attempt 2,
where the guard lives. Its assertions survive the fix untouched (its own explanatory comment about
the generic `Authorized` failure would need rewording). What is missing is a case that never
retries: two redemptions of a one-seat invitation issued concurrently against a single
`ControlDatabase`, asserting the loser's wire reason. Related but not overlapping:
`backlog/debt-formation-use-number-race-real-concurrency` covers the cross-node path.
