description: Add a test proving that when a peer presents a bad join signature, the responder never calls out to the disclosure validator.
files: packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/src/strand-formation-protocol.ts
difficulty: easy
----

# Pin that a refused join never reaches the disclosure validator

When a peer asks to join, the responder first checks the signature the joining peer made
over its own request. Only if that passes does it do anything else. "Anything else"
includes calling `validateDisclosure` — a caller-supplied hook that, in production, can
reach an outside approval service over the network.

So a peer that presents a bad signature must not be able to make the responder call that
hook. Otherwise anyone who can open a connection can drive outbound requests from the
responder using text they chose, without proving anything about who they are.

## Current state

`FormationListener.runSession` (`packages/cadre-core/src/strand-formation-protocol.ts`,
around lines 536-548) already has the right order: the consent pre-check runs first and
returns before `validateToken` and before `validateDisclosure`. This is a test gap, not a
defect — the behaviour is correct today and nothing pins it.

The matrix test `rejects tampered/mismatched/malformed consent before validating the token`
(`packages/cadre-core/test/strand-formation-protocol.spec.ts`, around line 515) already
counts `validateToken` calls and `provisionStrand` calls and asserts both are zero for
every bad-consent variant. It does not count `validateDisclosure` calls.

## What to do

Add a `validateDisclosure` call counter to that same test, alongside the two counters
already there, and assert it stays zero for every entry of the matrix — same shape as the
existing `tokenChecks` / `provisions` assertions, one more line each.

Noticed during review of `debt-formation-consent-signature-matrix`; left unlanded there
only because that run hit its token budget before it could run the suite to verify the
change.
