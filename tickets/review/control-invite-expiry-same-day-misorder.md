description: Review the fix that corrects same-UTC-day invite-expiry comparisons in the control layer so valid invites are no longer wrongly rejected.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: easy
----

## What was implemented

`execFormationUsageInsert` previously accepted a pre-computed ISO-8601 string (`YYYY-MM-DDTHH:MM:SS.000Z`) for `context.Now`. Quereus stores `datetime` columns in engine-canonical form (`YYYY-MM-DD HH:MM:SS`, space separator at position 10). Lexical comparison of ISO `Now` (`T` at position 10, 0x54) against canonical `ExpiresAt` (` ` at position 10, 0x20) always evaluated `ExpiresAt > Now` as false for same-UTC-day expiries, regardless of time-of-day — wrongly rejecting valid invites.

### Fix (`packages/cadre-core/src/control-database.ts`)

- `execFormationUsageInsert` now accepts `nowMs: number` and converts it internally via `canonicalDatetime(this.db!, opts.nowMs)` — matching the strand layer's `consumeInvite` convention so both sides of the `>` comparison use the same `YYYY-MM-DD HH:MM:SS` format.
- Both callers (`redeemInvitation` line 724–728, `recordFormationUsage` line 774–778) pass `nowMs ?? Date.now()` directly; the stale `toISOString()` calls are removed.

### Regression tests (`packages/cadre-core/test/control-formation-invite.spec.ts`)

Three new cases (lines 174–229), all passing:

| Test | `expiresAtMs` vs `nowMs` | Expected |
|------|--------------------------|----------|
| same-day future expiry | `base + 1h` vs `base` | admit |
| same-day past expiry | `base − 1h` vs `base` | reject |
| exact boundary | `base` vs `base` | reject (strict `>`) |

## Validation

- All 536 cadre-core tests pass (`yarn workspace @serfab/cadre-core test`).
- `tsc --noEmit` passes (no type errors).

## Review focus

- Verify `canonicalDatetime` is correctly rounding-tripped: `nowMs` → engine canonical → compared against `ExpiresAt` canonical. No edge cases from DST or sub-second precision should slip through (the engine truncates to-the-second).
- Confirm `redeemInvitation` and `recordFormationUsage` both propagate `nowMs` consistently; neither path should fall back to `Date.now()` in a way that reintroduces the format mismatch.
- The boundary (`nowMs === expiresAtMs`) case tests strict `>`: confirm the schema constraint aligns (invites that have "just expired" are not admitted at the boundary).
- No known gaps — the three regression tests cover the original bug and its neighbours.
