description: Added tests proving that when a peer presents a bad join signature — or a bad invite token — the responder never calls out to the disclosure validator (a hook that in production can reach an outside approval service).
files: packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/src/strand-formation-protocol.ts
difficulty: easy
----

# Pin that a refused join never reaches the disclosure validator

## What changed

Test-only. `packages/cadre-core/test/strand-formation-protocol.spec.ts`:

- `FormationListener joiner-consent pre-check` → matrix test
  `rejects tampered/mismatched/malformed consent before validating the token`: a
  `disclosureChecks` counter wired into `validateDisclosure`, asserted `0` for every entry
  of the six-case `invalidConsentContacts` matrix, alongside the pre-existing `tokenChecks`
  and `provisions` counters.
- (review) `rejects an invalid token without disclosing responder identity/cadre`: same
  counter asserted `0`, pinning the second half of the ordering — a forged or spent token
  must also stop short of the disclosure hook.
- (review) `rejects an invalid disclosure without disclosing responder cadre`: counter
  asserted `1`, the positive control that makes the two `0` assertions non-vacuous.

No production code changed. `FormationListener.runSession`
(`packages/cadre-core/src/strand-formation-protocol.ts:545-560`) already ordered
consent pre-check → `validateToken` → `validateDisclosure`; this ticket pins that order.

## Verification

From `packages/cadre-core`:

- `yarn vitest run test/strand-formation-protocol.spec.ts` — 30 passed, 0 failed.
- `yarn typecheck` — exit 0.
- `npx eslint packages/cadre-core/test/strand-formation-protocol.spec.ts` from the repo
  root — clean.
- `yarn test` (whole package) — 1390 passed, 5 failed, all 5 in
  `control-revocation-reissue.spec.ts` / `control-revocation-replay.spec.ts`, already
  listed in `tickets/.pre-existing-known.md` against blocked ticket
  `10-revocation-reissue-same-pk-update-unique-collision`. Not re-reported.

## Review findings

**Implementation correctness — confirmed.** Read `runSession` directly rather than
trusting the handoff: the pre-check at line 545 returns before `validateToken` (550) and
`validateDisclosure` (556), so the asserted invariant is the one the code actually holds.
The counter override reaches the listener (`baseOptions` spreads `overrides` last).

**Vacuity — one real gap, fixed inline.** The added `expect(disclosureChecks).toBe(0)`
proves nothing on its own unless something proves the hook is reachable at all; a
listener that never called `validateDisclosure` would have passed. The existing
`rejects an invalid disclosure` test implies reachability via its rejection reason, but
implicitly. Added an explicit `toBe(1)` positive control there.

**Coverage gap — fixed inline.** The ticket pinned only pre-check → disclosure. The
adjacent leg, token → disclosure, was unpinned: a contact with valid consent but a
forged/spent token could have driven the outbound hook with no test objecting. Added the
assertion to the invalid-token test.

**Comment accuracy — tightened.** The added comment asserted the hook "can call out to an
external approval service." `DisclosureValidator` (`strand-solicitation.ts:30`) is a
host-supplied async interface and the only in-repo implementations are an allowlist
(integration test) and a capturing spy — so the network claim is unmeasured. Reworded to
what is verifiable: a host-supplied hook that may do arbitrary work over attacker-chosen
text. Also cut 3 lines to 3 shorter ones.

**Handoff inaccuracy.** The implement note claimed no root `lint` script exists. Root
`package.json` has `"lint": "eslint ."`; it runs fine on the changed file from the repo
root (the flat config resolves from there, not from inside the package).

**Docs — checked, no update needed.** `docs/architecture.md:526` describes
`StrandFormationManager` wiring the listener to its three collaborators but does not
document per-hook ordering, and `docs/STATUS.md` has no entry on formation validation
order. The diff is test-only and introduces no new behavior, so nothing in `docs/` went
stale.

**New tickets — none filed.** Both findings were single-line test additions inside the
file already under review; nothing needed a separate site or a decision.

**Tripwires — none recorded.** The only conditional-looking item is the `disclosureChecks`
counter now declared in three tests, which is duplication of two lines each and matches
the file's existing `tokenChecks`/`provisions` idiom — not worth a `NOTE:`.
