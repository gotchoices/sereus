description: Added a test proving that when a peer presents a bad join signature, the responder never calls out to the disclosure validator (a hook that in production can reach an outside approval service over the network).
files: packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/src/strand-formation-protocol.ts
difficulty: easy
----

# Pin that a refused join never reaches the disclosure validator

## What changed

`packages/cadre-core/test/strand-formation-protocol.spec.ts`, matrix test
`rejects tampered/mismatched/malformed consent before validating the token`
(describe block `FormationListener joiner-consent pre-check`):

- Added a `disclosureChecks` counter, wired into `validateDisclosure` in the test's
  `baseOptions` override, alongside the pre-existing `tokenChecks` and `provisions`
  counters.
- Added `expect(disclosureChecks, label).toBe(0)` for every entry of the bad-consent
  matrix (tampered/mismatched/malformed variants from `invalidConsentContacts`).

No production code changed — `FormationListener.runSession`
(`packages/cadre-core/src/strand-formation-protocol.ts:545-560`) already ran the consent
pre-check before `validateToken` and `validateDisclosure`; this ticket only adds the
missing assertion pinning that order.

## Verification

`yarn vitest run test/strand-formation-protocol.spec.ts` (from `packages/cadre-core`):
30 passed, 0 failed.

Did not run the repo-wide lint gate — no root `lint` script and no workspace `lint`
script exists for `@serfab/cadre-core`; `npx eslint <file>` couldn't resolve the flat
config from that path either. The added lines mirror the pre-existing `tokenChecks`/
`provisions` counter pattern in the same test verbatim (same declaration style, same
assertion style), so style risk is low.

## Review findings

(none yet — first pass)
