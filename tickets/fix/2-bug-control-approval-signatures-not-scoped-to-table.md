----
description: An approval an owner signs to grant someone a narrow, limited role also works, unchanged, to make that same person a full owner of the party — the approval never says which role it was for.
files: schemas/control.qsql + packages/cadre-core/src/control-schema.ts (OwnerKey.Authorized and ValidationKey.Authorized — both verify a signature over the same two-field message), packages/cadre-core/src/control-database.ts (insertValidationKey, buildAuthorizationMessage)
difficulty: medium
----

# A limited-role approval is accepted as a full-owner approval

## What is wrong

When an owner approves a control-plane change, it signs a short message built from the fields
of the row being added. The message contains **only those field values** — nothing identifies
which table, which party, or which kind of change the approval was for.

Two tables happen to build the identical message:

- `CadreControl.OwnerKey` — a key allowed to make **any** control change for the party.
- `CadreControl.ValidationKey` — a key allowed only to **validate strand formation
  disclosures**, a deliberately narrow role.

Both are `(Key, StampId)` text pairs, and both constraints verify a signature over
`digest(Key, StampId)` against an existing owner key. So an owner's approval to add a
validation key is, byte for byte, a valid approval to add that same key as an **owner**.

Reproduced against a real control database during review of
`bug-control-ownerkey-self-authorization`: call the shipped API
`ControlDatabase.insertValidationKey(K, owner, sign)`, then re-present the resulting
`(K, StampId, signature)` as an `OwnerKey` insert. It is accepted. `K` is now a full owner.

## Why it matters

This defeats the point of having a limited role. Anyone holding the approval — including the
holder of the validation key itself, who is the natural recipient of it, and any node that saw
the write — can promote that key to full control of the party. No owner ever consented to that.

Reachability today: `insertValidationKey` is exported public API of `@serfab/cadre-core` but has
no caller inside this repo, so nothing in the current product issues such an approval. The hole
opens the moment a consumer uses the API as intended. Treat it as a design defect to close
before the validation-key flow is built on, not as an active incident.

## Wider point

The collision between these two tables is the *symptom*. The underlying issue is that approval
messages carry no domain separation: nothing binds an approval to the table it was meant for,
to the party, or to the intended action. The `'remove'` marker recently added to the delete
approvals for `OwnerKey` and `CadrePeer` is the same idea applied to one axis only (add vs
remove) and only where someone noticed a collision.

A durable fix gives every signed control-plane message a fixed leading component identifying
what is being authorized — table and action at minimum, and the party identifier is worth
considering so an approval cannot be carried between parties that share an owner key. That
touches every `verify(...)` in `CadreControl` and every signing writer in `control-database.ts`
/ `seed-bootstrap.ts`, which is why it is filed as its own ticket rather than patched at the
one collision.

Whatever is chosen must keep `schemas/control.qsql` and
`packages/cadre-core/src/control-schema.ts` byte-identical (a drift test enforces this) and be
covered by a test that signs an approval for one table and asserts it is refused, by constraint
name, when presented to another.

## Related

- `bug-control-remove-then-replay-resurrection` — the other way these approvals outlive their
  intent (they survive the removal of the row they added).
- `bug-strand-manager-authority-antireplay`, `bug-devicetoken-authority-antireplay` — the same
  family on tables whose approvals have no one-off value at all. A single scheme covering
  table, action, and nonce would settle all of these together; worth deciding before any of
  them is worked in isolation.
