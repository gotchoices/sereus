description: Fix the control layer so a formation invite expiring later on the same calendar day as redemption is correctly admitted instead of wrongly rejected.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: easy
----

## What was done

`execFormationUsageInsert` previously received a pre-computed ISO-8601 string (`YYYY-MM-DDTHH:MM:SS.000Z`) as `context.Now`.  `ExpiresAt` is stored as an engine-canonical `datetime` string (`YYYY-MM-DD HH:MM:SS`, space separator).  Quereus compares them lexically; at position 10 canonical has `' '` (0x20) while ISO has `'T'` (0x54).  Since `' ' < 'T'`, any same-UTC-day expiry was always `< Now` regardless of time-of-day, so valid invites expiring later that day were wrongly rejected.

### Fix (`packages/cadre-core/src/control-database.ts`)

- `execFormationUsageInsert` now takes `nowMs: number` instead of `nowIso: string` and calls `canonicalDatetime(this.db!, opts.nowMs)` internally, matching the strand layer's `consumeInvite` convention.
- Both callers (`redeemInvitation`, `recordFormationUsage`) pass `nowMs ?? Date.now()` directly, removing the stale `toISOString()` calls.

### Tests (`packages/cadre-core/test/control-formation-invite.spec.ts`)

Three new regression cases (all pass):

- **same-day future expiry** — `expiresAtMs = base + 1h`, `nowMs = base` → redemption succeeds
- **same-day past expiry** — `expiresAtMs = base − 1h`, `nowMs = base` → rejected
- **exact boundary** — `expiresAtMs = nowMs` → rejected (strict `>`)

All 13 tests in the spec pass; `tsc --noEmit` reports no errors.

## TODO

- Review the fix and regression tests for correctness.
