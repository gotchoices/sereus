description: A cadre formation invitation that expires later on the same calendar day it is redeemed is wrongly treated as already expired, so a perfectly valid invite gets rejected.
prereq:
files: packages/cadre-core/src/control-database.ts, schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/canonical-datetime.ts
difficulty: easy
----

# Fix: control `FormationUsage` expiry comparison mis-orders same-UTC-day timestamps

## The bug

`CadreControl.FormationUsage.Authorized` gates redemption on
`FI.ExpiresAt is null or FI.ExpiresAt > context.Now`
(`schemas/control.qsql` ~line 172, mirrored in `packages/cadre-core/src/control-schema.ts`).

`ExpiresAt` is stored as an engine-**canonical** `datetime` string produced by
`canonicalDatetime()` — format `YYYY-MM-DD HH:MM:SS` (space separator). But the writer
supplies `context.Now` as a JavaScript **ISO-8601** string:

- `packages/cadre-core/src/control-database.ts:716` (`redeemInvitation`): `new Date(nowMs ?? Date.now()).toISOString()`
- `packages/cadre-core/src/control-database.ts:778` (`recordFormationUsage`): same
- both flow through `execFormationUsageInsert` (~line 790) as `context.Now`.

ISO format is `YYYY-MM-DDTHH:MM:SS.000Z` (`T` separator, `.000Z` suffix). Quereus does
**not** type-coerce context params (only column values) — this is explicitly documented in
the code comment at `control-database.ts:713-715` — so `context.Now` stays an ISO string and
is compared **lexically** against the canonical `ExpiresAt`.

The two formats diverge at **position 10**: `ExpiresAt` has `' '` (0x20), `Now` has `'T'`
(0x54). Since `' ' < 'T'`, any `ExpiresAt` whose first 10 chars (`YYYY-MM-DD`) equal `Now`'s
date is lexically **less than** `Now` regardless of the actual time-of-day. So
`ExpiresAt > Now` is **always false whenever the expiry falls on the same UTC calendar day as
redemption** — the invite is wrongly rejected as expired even though it expires hours later.

Cross-day comparisons are unaffected (the date prefix decides them correctly), which is why
the existing control tests — they use only far-future / far-past expiries — never caught it.

## Why it surfaced now

The sibling strand-layer enforcement (`strand-invite-expiration-enforcement`, now complete)
hit the identical hazard and avoided it by canonicalising `Now` via
`canonicalDatetime(db, nowMs)` so **both** sides of the comparison are byte-identical
canonical strings. The control layer still uses the ISO form and carries the latent bug. The
strand work documented this divergence but left the control fix out of scope (it is a
separate subsystem) — hence this ticket.

## Expected behavior

An invite that expires later today (same UTC date as the redemption instant) must be
redeemable. Only an invite whose `ExpiresAt` is at or before `context.Now` (strict `>`, so
the exact instant is exclusive) may be rejected as expired.

## Suggested fix

Canonicalise `Now` the same way `ExpiresAt` and the strand layer do, instead of using
`toISOString()`. Both call sites funnel through `execFormationUsageInsert`, so the cleanest
fix is to pass `nowMs` down and compute `await canonicalDatetime(this.db!, nowMs ?? Date.now())`
once there (or compute the canonical string at each caller, matching the strand-layer
`consumeInvite` convention). Keep the strict `>` semantics.

## Regression test to add

In the control redemption test suite, add a **same-UTC-day future-expiry** case: issue a
`FormationInvite` with `expiresAtMs = base + oneHour` and redeem at `nowMs = base` where
`base` and `base + oneHour` share a UTC date — assert redemption **succeeds**. This is the
case the day-granular tests miss; it fails under the current ISO `Now` and passes once `Now`
is canonicalised. Mirror the strand-layer test
`admits a member with a same-UTC-day future expiry (canonical Now, not ISO)` in
`packages/cadre-core/test/strand-membership-invite.spec.ts`.

Also confirm the boundary case (`expiresAtMs === nowMs` → rejected) and a same-day **past**
expiry (`expiresAtMs = base - oneHour`, redeem at `base` → rejected) once `Now` is canonical.
