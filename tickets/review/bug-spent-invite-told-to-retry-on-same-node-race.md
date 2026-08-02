description: When two people redeem the same invitation at the same instant on one machine, the one who loses was told "conflict, try again" rather than "this invitation is used up" — fixed so the loser now gets the correct, non-retryable answer.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts
----

# Same-node invitation race now reports exhaustion instead of a retryable conflict

## What changed

`ControlDatabase.withUseNumberRetry` (`packages/cadre-core/src/control-database.ts`) used to
only check whether a redemption's use number was within the invite's seat budget
(`assertSeatRemains`) on RETRIES (`attempt > 1`). Two redemptions of a single-use invite racing
on the SAME node never retry — they serialize behind the local write queue (`withWriteLock`),
so the loser's very first attempt already reads a use number past budget. That first attempt
skipped the guard and fell through to a generic `CHECK constraint failed: Authorized` from the
database, which `StrandFormationManager.provisionAsResponder`'s catch-all reports as
`'Formation conflict, retry'` — wrong, since retrying an exhausted invite can never succeed.

Fix: `assertSeatRemains` now runs on EVERY attempt, including the first, so a same-node race hits
the same named `InvitationExhaustedError` → `'Invalid token'` path a cross-node race already did.

To avoid adding a `FormationInvite` read to the common (non-racing) redemption path, the invite's
`TotalUses` is threaded through from callers that already have it in hand:
- `ControlDatabase.redeemInvitation` / `recordFormationUsage` gained an optional
  `totalUses?: number | null` param, passed down to `withUseNumberRetry` → `assertSeatRemains`.
  `undefined` (the default, used by direct test callers) falls back to a fresh
  `queryFormationInvite` read, same as before.
- `ControlFormationUsageRecorder.recordUsage` / `provisionAndRecord`
  (`control-formation-recorder.ts`) both already read the invite before calling into
  `ControlDatabase` (to get `validationUrl`), so both now also pass
  `totalUses: invite?.totalUses ?? null` — zero extra reads on the production path.

Doc comments updated to match (`InvitationExhaustedError` class doc, `assertSeatRemains`'s own
doc, `provisionAndRecord`'s doc in the recorder, and `provisionAsResponder`'s doc in
`strand-formation-manager.ts` — the latter is comment-only, its error-mapping code was already
correct and is pinned by an existing test in `strand-formation-consent.spec.ts`).

## Tests

`control-formation-use-number-retry.spec.ts`, `'seats exactly one redemption of a SINGLE-use
invite and creates no extra seat'` — previously asserted the buggy generic `CHECK constraint
failed: Authorized` string match; now asserts `InvitationExhaustedError` with
`{ token, useNumber: 2, totalUses: 1 }`, mirroring the neighbouring
`'reports an exhausted invitation by name...'` test's assertion shape.

Verified:
- `yarn workspace @serfab/cadre-core test control-formation-use-number-retry` — 17/17 pass.
- `yarn workspace @serfab/cadre-core test control-formation-invite control-formation-consent-signature control-revocation-replay` — 102/103 pass; the 1 failure
  (`control-revocation-replay.spec.ts > ... a tombstone is permanent ...`) is a pre-existing,
  already-tracked failure unrelated to this change — see `tickets/.pre-existing-known.md`, owned
  by blocked ticket `10-revocation-reissue-same-pk-update-unique-collision`.
- `yarn lint` on all four touched files — 0 errors.
- `yarn workspace @serfab/cadre-core build` — clean, no type errors.

## Review findings

None filed — implementation matches the fix ticket's pre-formed plan exactly, no surprises
during implementation. No new tripwires introduced (the `queryFormationInvite` reliability
concern referenced in `assertSeatRemains`'s doc comment is pre-existing, already tracked by
`debt-composite-pk-point-lookup-unreliable-untracked`, not new).
