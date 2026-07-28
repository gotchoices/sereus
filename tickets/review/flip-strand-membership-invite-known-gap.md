description: Confirmed the invite-replay bug is fixed and the test that documented it now correctly rejects a double-consume of the same invite.
files: packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: easy
----

## Summary

Ticket asked to flip the `strand-membership-invite.spec.ts` "KNOWN GAP" test once the
upstream `optimystic` fix for INSERT primary-key uniqueness landed.

Turns out this already happened: commit `92f03b3` ("tess: triage pre-existing test
failure") flipped the test as part of resolving a `.pre-existing-error.md` triage from an
earlier ticket run, once the `optimystic-insert-pk-uniqueness-not-enforced` fix landed in
`../optimystic`. No further code change was needed for this ticket.

## Verification done this pass

- Confirmed `../optimystic` no longer has an open `optimystic-insert-pk-uniqueness-not-enforced`
  ticket (fix has landed, consumed via root `resolutions` -> `link:../optimystic/...`).
- Read `packages/cadre-core/test/strand-membership-invite.spec.ts`: the test at line 358 is
  already named `'a double consume of the same invite is rejected (single-use enforced)'`
  and asserts:
  - the second `consumeInvite` call `rejects.toThrow()`,
  - `ConsumedInvite` count stays 1 (not 2),
  - `Member` count stays 2 (founder + first consumer only — no replay admit),
  - the surviving `ConsumedInvite.MemberKey` still points at the first consumer.
- Ran the full spec file:
  ```
  yarn workspace @serfab/cadre-core vitest run test/strand-membership-invite.spec.ts
  ```
  Result: 25/25 passed, including the flipped test.

## Use cases covered by this test file (for reviewer reference)

- Invite issuance: manager-only, invite-key-proof signature, OnlyClosed-strand gating,
  expiration canonicalization.
- Invite consumption: happy path (atomic Member + ConsumedInvite insert), wrong invite
  key, no matching invite, expired invite (past/future/exact-boundary/null-expiry),
  **and now single-use enforcement (double consume rejected)**.
- Manager-direct admit (bypassing invite).
- `StrandMemberVerifier.isAuthorizedToJoin` expiry filtering.
- `EnrollmentService` end-to-end: happy path, bad self-proof signature, no invite,
  already-registered short-circuit, manager-mode admit.

## Known gaps / out of scope

- None introduced by this pass — this was a verification-only ticket, no source changes.
- The fix itself (optimystic transactor + the test flip) landed in a prior commit outside
  this ticket's direct authorship; this pass only re-verified it's correct and green.

## Review findings

(none yet — ticket had no code change, just confirmation the prior fix + test flip are
correct and passing)
