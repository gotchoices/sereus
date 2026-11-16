description: On a device that holds no owner key, accepting an invitation to a members-only shared database uses up the invitation and then fails, even when the device's party already has the membership key the join needs.
architecture: docs/strands/keys.md#where-each-key-comes-from
files: packages/cadre-core/src/cadre-node.ts (`ensureStrandPartyKey`, `requireOwnerSigner`, `adoptFormationMembershipInvite`, `formStrand`), packages/cadre-core/src/strand-formation-rejection.ts (`FormationPostApprovalError`), docs/strands/keys.md, docs/strands/formation.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Only a machine with no owner signer is affected, the first arm matters only when the party already belongs to the strand, and the second arm cannot be closed without either the pending decision on non-owner machines or a protocol change that tells a joiner the strand is closed before it spends the token.
----

# A closed-strand join on a machine with no owner signer spends the token and then throws

## What happens

`CadreNode.formStrand` runs the formation first and adopts its result second. For a closed strand the result carries a membership invitation, and `adoptFormationMembershipInvite` calls `ensureStrandPartyKey(strandId)` to obtain the party's membership key for that strand (the `StrandPartyKey` row). By then the responder has recorded the use, so the invitation's token is spent.

`ensureStrandPartyKey` calls `requireOwnerSigner` on its first line, before it reads the stored row. On a machine with no owner signer wired (`useOwnerSigner` never called: a cadre-host hosted node, a provider container, a device that joined the cadre by machine invitation) that throws, and `adoptFormationMembershipInvite` rethrows it as `FormationPostApprovalError`: "approved (its one-time token is spent), but persisting this party's membership identity failed". The party has to ask the inviter for another invitation.

## Arm 1: a stored key is refused for want of a signer it does not need

When the `StrandPartyKey` row already exists, `ensureStrandPartyKey` returns it and signs nothing. Its own comment says so of the `sign` parameter: "a mint asks for its own (a stored key asks for none)". The signer is demanded anyway, because the check runs before the read.

The row exists on a machine without a signer whenever another machine of the party founded or joined the strand earlier, since the row replicates to every machine of the party. Forming again with a strand the party already belongs to is a supported path: `recordFormationStrandAddrs` calls a re-formation "the recovery path for a dead address", and `adoptFormationMembershipInvite` names "a re-formation by an existing member party" as the case in which the stored key is reused. On a machine with no signer that recovery spends the fresh invitation and throws, although nothing needed signing.

Expected: with a stored key, `ensureStrandPartyKey` returns it whether or not a signer is wired, and the join completes. A signer is required only to mint and write a new row.

## Arm 2: with no stored key, the machine learns it cannot join only after the token is spent

When no row exists, the machine cannot write one: `StrandPartyKey` inserts are owner-signed. That part is by design, and whether a non-owner machine should be able to write the row is the open decision in `tickets/blocked/decide-non-owner-machine-completes-a-pending-join.md`. This ticket does not reopen it.

What is wrong today is the order. The invitation envelope (`OpenInvitation`) does not say whether the strand is closed; the joiner learns it from the result, after the use is recorded. So a machine that can never finish a closed-strand join still spends the invitation finding that out. `docs/strands/keys.md` and `docs/strands/formation.md` describe this as current behaviour.

Expected: a machine that cannot seat a membership key does not consume an invitation to a closed strand. That needs the joiner to know the strand's type before the responder records the use (a field in the envelope, or a refusal the joiner can issue between the responder's answer and its consent write), or the decision above to let such a machine write the row. Which of these is not settled here.

## Evidence and confirmation

Read from `cadre-node.ts`; nothing was run. To confirm arm 1 at the lowest layer: start a `CadreNode` whose control database holds a `StrandPartyKey` row for a strand and wire no owner signer, then call `ensureStrandPartyKey(strandId)`. It throws "the owner signer is not initialized" where it should return the stored key.

A signer that is wired but whose key is not an enrolled owner already behaves correctly for arm 1 (the stored key is returned) and fails arm 2 the same way, at the schema's check rather than at `requireOwnerSigner`.
