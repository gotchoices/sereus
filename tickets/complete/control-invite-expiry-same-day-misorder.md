description: Reviewed the control-layer change that routes invite-expiry "now" through the same date formatting as the stored expiry; the change is safe and tests pass, but it does not fix a real bug — the original diagnosis was mistaken.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: easy
----

## What was implemented (recap)

`execFormationUsageInsert` was changed to accept `nowMs: number` and derive
`context.Now` via `canonicalDatetime(this.db!, opts.nowMs)` (replacing
`new Date(nowMs).toISOString()`), so both `redeemInvitation` and
`recordFormationUsage` feed `context.Now` through the same transform that produced
the stored `FormationInvite.ExpiresAt`. Three regression tests were added
(same-UTC-day future → admit, same-day past → reject, exact boundary → reject).

## Review findings

### Verdict

The committed change is **correct and safe to keep** — but it is a
**behavioral no-op / consistency cleanup, not a bug fix**. The root-cause narrative
in the fix ticket, the implement handoff, and the code/test comments was **factually
wrong**, and the three "regression" tests do **not** pin the bug they claim to.

### Correctness / root-cause verification (the core of this review)

The fix chain claimed: `ExpiresAt` is stored space-separated (`YYYY-MM-DD HH:MM:SS`)
while ISO `Now` is `T`-separated, so at position 10 `' ' (0x20) < 'T' (0x54)` makes
`ExpiresAt > Now` *always false* for same-UTC-day expiries.

Empirically (verified against the in-use `@quereus/quereus`):

- `select datetime(?)` → `"2031-03-04T13:00:00"` — **`T` at position 10**, not a space.
- `select cast(? as datetime)` normalises even an ISO `…T…000Z` input to
  `"2031-03-04T13:00:00"` (`T`).
- So **both** operands of `FI.ExpiresAt > context.Now` already had `T` at position 10
  under the old code (`ExpiresAt` via `canonicalDatetime`; ISO `Now` from
  `toISOString()`). The described position-10 mis-ordering **cannot occur**.
- The old `Now` differed from the new `Now` only by a trailing `.000Z`, which makes
  it lexically ≥ the canonical form — never flipping a strict `>` against a
  second-granular `ExpiresAt`. The admit/reject decision is identical for every
  input. **The change is behaviorally a no-op.**

**Controlled experiment (definitive):** I temporarily reverted
`execFormationUsageInsert` to the old `toISOString()` path and ran the three new
tests through the real code path — **all three passed** against the pre-fix code.
They are valid behavioral coverage but do not pin the originally-described defect.
The edit was reverted; the committed fix is restored (confirmed via `git diff`).

### Fixed inline (minor)

- Rewrote the misleading comment in `control-database.ts:~796` (was: *"mis-ordering
  at position 10 where canonical ' ' < ISO 'T'"*) to state the truth: the engine
  `datetime()` separator is `T`, the `.000Z`-only difference never flipped the
  comparison, and this is a robustness/consistency change matching the strand layer.
- Rewrote the false test comment in `control-formation-invite.spec.ts:~178` (was:
  *"position 10 is 'T' while ExpiresAt has ' ' … always false for same-day"*) to
  describe what the test actually guards.
- Kept all three tests — they are good behavioral coverage (same-day future/past +
  exclusive boundary), even though they pre-date-pass.

### Filed as new work (major, separate subsystem)

`tickets/backlog/quereus-datetime-format-doc-myth.md` — the false
"Quereus stores `YYYY-MM-DD HH:MM:SS` (space)" claim is repeated across the reference
apps (rn/web/ns), an integration scenario, the strand-membership spec, and two
complete tickets. The reference apps **actively format timestamps to space-form
before insert**, which (depending on column coercion) could produce a real mix of
`T`- and space-separated stored values and a genuine ordering bug. That needs an
end-to-end check and is out of scope here. Not touched in this pass (separate
subsystem, already-completed tickets).

### Other dimensions checked

- **Consistency / DRY:** `nowMs ?? Date.now()` is applied identically in both callers
  (`redeemInvitation` ~726, `recordFormationUsage` ~776); both funnel through the one
  shared `execFormationUsageInsert`. Matches `strand-membership-writer.ts` convention.
  No `Date.now()` fallback reintroduces a format mismatch. ✔
- **Type safety:** `execFormationUsageInsert` correctly became `async`; the `nowMs:
  number` type replaced `nowIso: string` cleanly; no `any`. ✔
- **Error handling / resource cleanup:** `redeemInvitation`'s transaction
  begin/commit/rollback path is unchanged and correct (rollback-after-failed-commit
  is swallowed-with-log only for the expected "no transaction active"). ✔
- **DST / sub-second:** `canonicalDatetime` truncates to the second via the engine;
  no DST hazard (all UTC). The boundary test confirms strict `>` (exact instant
  rejected). ✔
- **Lint:** `npx eslint` on both touched files — clean (exit 0). ✔
- **Tests:** `vitest run test/control-formation-invite.spec.ts` — **13/13 pass**. ✔

### Pre-existing failures

None encountered.
