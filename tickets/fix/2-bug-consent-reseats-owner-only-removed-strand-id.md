----
description: When a party deletes one of its networks, someone holding an unused invitation can bring that network's entry back by re-creating it under the same name, so the deletion does not stick.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/test/control-revocation-replay.spec.ts
difficulty: hard
----

# Deleting a network entry can be undone by an unused invitation

## Background in plain terms

A party's control database lists the networks ("strands") that party takes part in. A row
gets there one of two ways:

- **owner-signed** — an owner of the party signs the row into existence; or
- **by consent** — no signature at all, authorized purely by the existence of a redemption
  record for an invitation the party issued. This is how an invited peer joins.

An earlier ticket (`bug-formation-consent-unconstrained-strand-seating`) narrowed the
consent path so a redemption can only create the plain, keyless entry it was invited to,
and so a given network name can be consent-created **once, ever** — the redemption record
is append-only, so it survives the entry's later deletion and blocks a second unsigned
creation of that name.

## The gap

"Once, ever" is enforced by looking for a *surviving redemption record* naming the entry.
An **owner-signed** creation writes no redemption record. So for a network entry that was
only ever owner-created and then legitimately deleted, there is nothing left to look at,
and a spare use of any unexpired invitation re-creates the entry under the same name — no
signature required.

Concretely: the party owner creates a private network, later deletes it (properly signed,
with the deletion recorded), and anyone on the party's replicated control database who
still holds an unused invitation puts the entry back.

## Why it matters, and what it is not

- The re-created entry is always the plain, keyless kind, so the attacker cannot pick the
  party's secret for that network — the earlier fix holds on that front.
- What breaks is **deletion**: the party's nodes see the network listed again and will act
  on it. Invitation tokens sit in plaintext in the replicated control database, so anyone
  who can read that database and finds an unused invitation can do this.
- This is not the ordinary invitation flow. A normal unbound redemption always mints a
  fresh, random 128-byte name that has never existed, so it is never affected. Only an
  attacker who deliberately supplies a previously-used name reaches this.

## Expected behavior

A deletion of a network entry should be final against every unsigned path, regardless of
how the entry was originally created. Re-joining a deleted name should stay owner-gated:
the owner re-creates it signed, and returning parties record consent against that live row.

## Reproduction

`packages/cadre-core/test/control-revocation-replay.spec.ts` →
`'Strand: RESIDUAL — an id seated ONLY owner-signed, then removed, is still consent-seatable'`
currently **asserts the gap** (the re-seat succeeds). When this ticket lands, that test
should flip to expecting a rejection from `Strand.AuthorizedInsert`.

## Notes for whoever picks this up

The obvious shapes both have costs and neither is obviously right yet — this needs design
work, not a one-line CHECK edit:

- The existing deletion tombstone table (`Revocation`) records only the deleted row's
  one-off stamp, never its name, so it cannot answer "was this name ever deleted?". Adding
  the name would make deletion permanent for that name under *both* paths — including the
  legitimate owner re-creation the previous ticket established as the re-join route — so it
  would need a deliberate carve-out for the owner-signed branch.
- Requiring a redemption record for every creation (so the once-ever rule always has
  something to see) changes the owner-signed path's shape and its authorization message.

Both touch the same constraint that two prior security tickets already reworked; read the
constraint comments on `Strand.AuthorizedInsert` first.
