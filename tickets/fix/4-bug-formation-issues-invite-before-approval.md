description: When someone tries to join a private workspace and the owner's approval service turns them down, the workspace has already created and permanently stored an unused membership pass for them. Nobody can use it, but it never goes away, and a rejected person retrying enough times leaves a permanent pile of them.
files: packages/cadre-core/src/strand-formation-manager.ts (provisionAsResponder, issueBoundMembershipInvite), packages/cadre-core/src/control-formation-recorder.ts (recordUsage, obtainApproval), packages/cadre-core/src/strand-solicitation.ts (FormationUsageRecorder), schemas/strand.qsql (Strand.Invite)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The rows are inert (unusable, and unreachable by the rejected joiner), so a maintainer may reasonably file this behind pruning work for the strand's other insert-only tables rather than reshaping the recorder's approve-and-record seam for it.

# A denied join still leaves a permanent membership pass behind

Joining a private (closed) workspace goes through a handshake the host runs. Since `strand-formation-membership-invite`, that handshake creates a single-use membership pass for the joiner — a row in the workspace's own database — and hands it back with the approval.

The pass is created **before** the host asks its approval service whether this joiner may in fact join. So the order of events for a joiner the approval service **refuses** is: create the pass, ask, get told no, refuse the join. The pass is never handed over, so nobody can redeem it — but the row that represents it has already been written, and that kind of row can never be deleted (it is append-only by design, and its expiry only stops it being *used*, it does not remove it).

## Why the ordering is the way it is

Deliberately. Creating the pass after the consent record would mean an issuance failure leaves the joiner's one-time join token already spent with no pass to show for it — a joiner that looks joined and can never become a member. Issuing first makes that failure retryable, which is the better of the two.

The gap is that the step it was ordered against does *two* things: the recorder's `recordUsage` consults the approval service **and then** writes the consent record. Only the second half needed to come after issuance. The approval question could — and should — be asked before anything is written into the workspace at all.

## Impact

- Any refused, malformed, or unenrolled approval on a private-workspace join adds one permanent unusable row to that workspace's membership-pass table. So does losing a race for the last seat on a multi-use invitation.
- Because refusal leaves the join token unspent (by design — the joiner is meant to be able to retry), a holder of a valid token whose approval keeps being refused can repeat this indefinitely, each attempt costing the host one networked write into the workspace database and one more permanent row.
- Nothing is disclosed to the refused joiner: the refusal reply carries no identity, no keys, and not the pass. This is a durability and write-amplification problem, not a leak.

## Expected behavior

Nothing is written into the workspace database for a join the host is going to refuse. Concretely, the invariant worth holding at this seam is: *the responder performs no workspace-side side effect until the redemption is fully authorized*, while keeping the existing "an issuance failure must leave the join token unspent" property.

The one code site that has to change is the recorder seam that currently fuses "ask the approver" with "write the consent record" — splitting those two lets the handshake ask first, then issue, then record, and satisfies both properties at once. Any fix should also cover the multi-use seat race, which fails in the same window for the same reason.

## Confirming it

Not observed — read from the code. What would confirm it: extend the formation integration coverage with a bound *closed*-strand invitation gated on an approval hook that denies (the existing hook fixture already supports a deny response; today's denying scenarios are all unbound or open), then count the host workspace's membership-pass rows after the refusal. The count should be zero and would currently be one per attempt.
