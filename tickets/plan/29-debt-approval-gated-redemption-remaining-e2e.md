description: Two ways an invitation needing outside sign-off can be turned down — the approver being unreachable, and the approver's address being unusable — are only checked against the sign-off client in isolation, never against a running node; and the case where the invitation already names an existing network is untested end to end.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, docs/api.md
difficulty: medium
----

# Remaining end-to-end coverage for approval-gated invitations

An invitation can require sign-off from an outside approver before anyone may redeem it. Phase 5
of `strand-formation-e2e.integration.ts` now runs that whole chain for real — real HTTP approver,
real network, real database write — for the happy path and for four ways a redemption gets turned
down. Three holes are left.

## 1. Two rejection outcomes never run against a real node

When a redemption cannot be approved, the joining side is told a short reason. There are five
possible reasons; three are exercised end to end. The other two are not:

- **The approver could not be reached** (dead host, connection refused, no answer in time) — the
  joiner should be told the attempt may be worth retrying, and the invitation must be left
  spendable.
- **The approver's address is unusable** (the invitation names something that is not an ordinary
  web address, e.g. a `ftp://` URL) — the joiner should be told this is a setup mistake, and again
  nothing should be consumed.

Both are covered where the outgoing web request is made (`test/formation-approval-real-fetch.spec.ts`),
but nothing checks that a node redeeming a real invitation surfaces them correctly and leaves the
invitation unspent.

Both are cheap to drive: for the first, start the approval fixture and close it before redeeming
(a refused connection on loopback fails immediately, so no waiting); for the second, publish an
invitation whose approver address uses an unsupported scheme. Neither needs new fixture support.

## 2. The "invitation already names an existing network" path

An invitation comes in two shapes: one that names an existing network to join, and one that has
the inviting node create a fresh network on the spot. Only the second shape is exercised against a
real approver. The first shape asks the approver in the same way but writes the join record
through a different code path.

Lower value than item 1 — the shared approval logic is already proven, and the database rules for
this shape are unit tested — but it is the other half of what "the whole chain runs end to end"
should mean, and setting it up needs a pre-created network the invitation can point at, which
Phase 5 does not currently build.

## Expected outcome

Phase 5 covers every documented rejection reason and both invitation shapes, and the paragraph in
`docs/api.md` under "Validate Strand Formation" that currently says two reasons are covered only
at the HTTP-client level can be simplified back to "this whole contract is executable".
