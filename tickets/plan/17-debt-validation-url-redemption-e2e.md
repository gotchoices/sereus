description: Invitations that require an outside approver to sign off have never been tested end to end against a real approval server — every piece is tested on its own, but the pieces have never been run together.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-cli/src/commands/validation-key.ts, docs/api.md
difficulty: medium
----

# No end-to-end test of an approval-gated invitation

## Background in plain terms

An invitation can require sign-off from an outside approver before someone may redeem it.
The party publishes an invitation carrying the approver's web address; when a newcomer tries
to redeem it, the party calls that address, gets back a signed approval, and only then lets
the newcomer in. The party decides which approvers it trusts by enrolling their public keys.

Every piece of that now exists and every piece has its own tests:

- enrolling / listing / removing the trusted approver keys
- calling the approver's web hook and mapping each failure to a distinct refusal reason
- writing the sign-off alongside the join record, and the database rules that verify it

## What is missing

No test runs the whole path. In particular nothing has ever pointed the approval client at a
real HTTP server. The approver hook is exercised only against stubbed responses, and every
end-to-end formation test in `packages/integration-tests` uses invitations that need **no**
approval.

So the claim "approval-gated invitations work" rests on the seams between components, which
is exactly where nobody has looked. Plausible failures hiding there: request/response shape
drift between what the client sends and what a real server would answer, the signed bytes
disagreeing between approver and verifier, timeout interaction under a slow hook, or the
enrollment simply not having converged on the node that performs the redemption.

## What this ticket wants

A test that stands up a real (local) approval server, enrolls its key through the normal
operator path, publishes an invitation naming that server, and redeems it with a second
party — asserting the newcomer actually joins.

Worth covering in the same pass, since they are the cases most likely to be wrong and each
one is a one-line variation on the happy path:

- the approver refuses → the newcomer is refused, and the invitation is **not** consumed
- the approver's key was never enrolled → refused
- the approver's key was removed after the invitation went out → refused
- the approver's sign-off is replayed for a second newcomer → refused

`docs/api.md` documents the request/response contract the server must honour, and
`docs/STATUS.md` records this gap under the formation-approval section; update both when the
test lands.

## Note

This is test coverage for behavior believed to work, not a known defect. If the test turns up
an actual bug, file that separately — this ticket is done when the path is covered.
