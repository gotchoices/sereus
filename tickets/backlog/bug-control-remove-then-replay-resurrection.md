----
description: Removing someone from the party is not permanent — the original approval that let them in still works afterwards, so anyone who kept a copy of it can put them straight back without asking anyone.
files: schemas/control.qsql + packages/cadre-core/src/control-schema.ts (OwnerKey and CadrePeer tables — the StampId column and the Authorized / AuthorizedInsert constraints), packages/cadre-core/src/seed-bootstrap.ts (authorizePeer, removePeer), packages/cadre-core/src/control-database.ts (insertOwnerKey)
difficulty: medium
----

# Removal is undoable: an add-approval stays valid after the row is deleted

## What is wrong

Two control-plane tables gate who is in the party:

- `CadreControl.OwnerKey` — the keys allowed to make control changes.
- `CadreControl.CadrePeer` — the nodes that are members of the party's cadre.

Adding a row to either requires an approval: an owner signs a short message naming the row
being added, and that signature travels with the write. Each row also carries a `StampId`
column — a random one-off value that is part of the signed message and is declared `unique`,
which the schema comments describe as making the approval "single-use (anti-replay)".

It does not. The uniqueness only applies to rows that currently exist. Once a row is deleted,
its `StampId` is free again, and the original approval — which is just a signature over
(row key, that stamp) and never expires — verifies exactly as it did the first time. So the
add can simply be repeated, and the row comes back.

Both were reproduced against a real control database during review of
`bug-control-ownerkey-self-authorization`:

| Sequence | Result |
|----------|--------|
| Owner enrolls key K → owner removes K (properly signed) → the *original* enrollment write is repeated verbatim | K is an owner again |
| Owner admits peer P → owner removes P (properly signed) → the *original* admission write is repeated verbatim | P is a member again |

## Why it matters

Removing a compromised or retired key/node is a security action. Today it can be silently
undone by anyone who can write to the party's control collection and who kept a copy of the
original approval. Two things make keeping a copy easy rather than exotic:

- For `CadrePeer` the approval is **stored on the row itself** (the `VouchOwner` / `VouchSig`
  columns), so the peer being removed can simply read its own row while it is still a member
  and save the pair for later.
- Approvals ride along with the write to the party's other nodes, so any node that saw the
  original add has it.

The removed party is not necessarily the one who replays it — any writer can, which is the
same attacker position assumed by the rest of the control-plane authorization work: an
already-admitted cadre peer. There is a partial mitigation for a *removed node* re-admitting
itself — the inbound connection gate (`membership-connection-gater.ts`) refuses a peer it can
positively tell is not a member — but that gate is deliberately fail-open in ambiguous states,
does not apply to a still-admitted accomplice, and does not apply at all to the `OwnerKey` case.

## What "fixed" should mean

A removal must be final: no previously issued approval may authorize re-adding the same row.
The obvious shapes, for whoever picks this up to weigh:

- Keep a tombstone of removed (key, stamp) pairs and refuse an add that matches one. Costs a
  growing table and needs a replication-safe answer for "was this really removed, or have I
  just not seen the add yet".
- Bind the approval to something that moves forward on its own — e.g. a per-row generation
  counter that only increases, so an old approval names a stale generation. This is the shape
  the sibling `Strand.Manager` hardening already used for a related problem.
- Bind the approval to a validity window, so a stale one simply expires.

Whatever is chosen must hold for **both** tables, keep `schemas/control.qsql` and
`packages/cadre-core/src/control-schema.ts` byte-identical (a drift test enforces this), and
come with tests that perform the add → remove → replay sequence above and assert the replay is
refused by name.

## Related, deliberately not merged into this ticket

`bug-strand-manager-authority-antireplay` and `bug-devicetoken-authority-antireplay` cover
tables that have **no** one-off value in the signed message at all. This ticket is about the
tables that *do* have one and are still replayable, because the uniqueness disappears with the
row. A fix for those two will not fix this.

Also note the schema comments on `OwnerKey.StampId` and `CadrePeer.StampId` currently assert
"single-use anti-replay" as fact; they should be corrected as part of this work.
