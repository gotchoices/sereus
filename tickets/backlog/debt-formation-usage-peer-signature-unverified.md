description: When someone joins one of a party's networks, the record of that join names who joined, but nobody checks that the named person actually agreed to it — the joiner's own signature is collected and then ignored.
prereq: debt-formation-approval-signature-replayable
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts
----

# The joining peer's signature on a formation record is never checked

## What exists

Redeeming an invitation to join one of a party's networks writes a
`CadreControl.FormationUsage` row. That row names the joining peer, and the insert also carries
a `PeerSignature` value alongside it. No constraint ever looks at the signature — it is
declared in the table's write context and dropped on the floor.

The node that writes the row is the *inviting* party's node, not the joiner's. So the joiner's
identity on that row is whatever the writing node says it is.

## Why it matters

After `debt-formation-approval-signature-replayable` lands, an outside approver's sign-off is
bound to the joining peer's identity. That stops one approval from being re-filed under a
different name — but only because the digest would no longer verify, not because anyone proved
the named joiner took part. A writing node that wanted to could still get an approval for
joiner A and record the join as having been for A while a different party actually holds the
resulting membership.

It also leaves the join record weaker as an audit trail than the equivalent membership record:
a `CadrePeer` row stores the vouching key and signature on the row itself so any reader can
re-check it later. A formation record stores neither.

## What "done" would look like

- The joining peer signs something that identifies its own join, that signature travels over
  the formation protocol to the responder, and the constraint verifies it against the joiner's
  own key before the record is accepted.
- Whatever is signed is bound tightly enough that it cannot be lifted onto a different join —
  the same standard the approver's sign-off is held to.
- A reader can re-check the record after the fact, which likely means storing the signature on
  the row rather than passing it only at write time.

## Open questions for whoever picks this up

- The joiner's identity today is a libp2p peer identifier string, not a raw public key in the
  form the schema's signature check accepts. `CadrePeer` solves the same problem by storing a
  separate public-key column beside the peer id; the join record would need something similar,
  or a way to derive one from the other at check time.
- The formation protocol messages have no field for a joiner signature yet, so this touches the
  wire format. It is worth doing together with, or right after, the work that makes the
  approver web hook actually get called (`feat-formation-validation-webhook-unwired`), since
  both change the same exchange.
