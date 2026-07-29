description: When an outside approver signs off on someone joining a network, that approval is not tied to the specific person or the specific join — so anyone holding the invitation could reuse a copy of someone else's approval to get in.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: medium
----

# An approval sign-off is a reusable token, not a per-joiner one

## Background

A party can mint an invitation to one of its networks that requires an outside approver to
sign off before anyone may redeem it (the invitation carries a `ValidationUrl`, and the party
keeps the approver's public key in `CadreControl.ValidationKey`). Redemption writes a
`CadreControl.FormationUsage` row, and its `Authorized` CHECK now demands that the sign-off
verify against an enrolled approver key — that part was fixed in
`bug-formation-validation-key-never-checked`.

## The gap

What the approver signs is a digest over exactly two things: the invitation token and the
joiner's **disclosure** text.

```sql
digest('CadreControl.FormationUsage', 'vouch', new.Token, new.Disclosure)
```

Nothing else is bound in. Not which use of the invitation this is (`UseNumber`), not which
network row is being formed (`StrandId` / `StrandStampId`), not who is joining
(`context.PeerId`, which the same CHECK declares and never verifies). The disclosure text is
supplied by the redeemer on the insert.

So an approval, once issued, authorizes **any** redemption of that invitation that repeats the
same disclosure bytes. Concretely: an invitation good for five joiners, approver signs off on
joiner A; anyone else holding the invitation copies A's disclosure and A's approval signature
verbatim into their own redemption, and the gate opens. Even for a single-use invitation, a
party who sees the approval before A submits it can spend it first.

The invitation token itself is already a bearer credential — anyone holding it can attempt a
redemption. The approver check is the mechanism meant to raise that bar for gated invitations,
and a replayable approval largely gives the bar back.

## Why this is filed rather than fixed

Nothing in the codebase ever calls a `ValidationUrl` today (see
`feat-formation-validation-webhook-unwired`), so no approvals exist to capture and the hole is
not reachable in practice. It becomes live the moment that hook is wired — so whoever builds
the hook needs the answer to this ticket in hand first. A `KNOWN GAP:` comment sits on the
constraint in `schemas/control.qsql` / `control-schema.ts` pointing here.

## Expected behavior

An approval should authorize one specific joining, not a token-and-text pair. What the sign-off
covers must be settled together with the hook design, since the approver has to know the bound
values at signing time. Options, roughly in order of how much they constrain:

- Bind the joining peer's identity, which also needs `context.PeerId` / `context.PeerSignature`
  to actually be verified — they are declared and ignored today.
- Bind the strand row being formed (`StrandId` + `StrandStampId`), which the redeeming insert
  already carries.
- Bind `UseNumber`, which caps an approval at one redemption but is awkward: the redeemer
  computes the next use number just before the insert, so the approver would have to be told it
  in the same round trip and races between concurrent joiners become approval failures.

Whatever is chosen, the constraint comment should state what an approval is and is not
transferable across, and the regression suite should include a case that replays a valid
approval under a different redemption and expects rejection.
