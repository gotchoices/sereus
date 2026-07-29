description: A party owner has no way to actually remove a strand or a validation key from the party's shared network — the code that performs the removal exists and works, but nothing in the app, command line, or node ever calls it.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, docs/architecture.md
difficulty: hard
----

# Owner-approved removal of a strand or validation key

## Background

The party's shared control database (the small replicated set of tables every node in a
party keeps in sync) has two tables that can only be changed by a party owner:

- **`Strand`** — the list of shared networks this party participates in.
- **`ValidationKey`** — the keys allowed to vouch that a new strand was formed legitimately.

Both are add-and-remove only. A removal is deliberately hard to perform: it needs a fresh
signature from an owner, made specifically for *removing this exact row*, committed together
with a permanent "this row's one-time token is retired" record so the original add-approval
can never be replayed to bring the row back.

`ControlDatabase.deleteStrand` and `ControlDatabase.deleteValidationKey` do exactly that, and
are covered by tests. **Nothing calls them.** Grep confirms zero callers outside the module
itself and its test file. So today a party can add a strand or a validation key and never
remove one.

Note the neighbouring peer-removal path is fully wired (`SeedBootstrapService.removePeer`,
surfaced through `CadreNode.removePeer`) — it is the closest working example of the whole
shape, end to end.

## What is missing

Two separate things, and the second is the reason this is not a mechanical follow-up:

**1. A call path.** `CadreNode.removeStrand` looks like the natural home but currently does
something narrower and purely local: it stops the strand running on this node, forgets its
local app config, and untracks hibernation. It never touches the shared `Strand` table. So
"remove strand" today means "stop participating on this device", not "remove it for the
party". Those are two genuinely different operations and a decision is needed about whether
they stay separate (e.g. a distinct `deleteStrandForParty`) or whether one grows a flag.

**2. Somewhere for the owner's approval to come from.** The remove needs the owner's private
key to sign a message at the moment of removal. There is no flow anywhere in the product
today where an owner is prompted to approve a specific destructive control-plane change. The
peer-removal path sidesteps this by holding a configured owner private key in the seed
service — acceptable for a self-hosted node the owner runs, but it is not obviously the right
answer for "delete a shared network the party is a member of", which is irreversible and
affects every member.

## Expected behaviour

- An owner can remove a validation key that is no longer trusted, and every node in the party
  converges on it being gone.
- An owner can remove a strand the party should no longer participate in, and the removal
  likewise propagates.
- A non-owner cannot, and an old approval for adding the same strand or key cannot be reused
  to undo the removal. (Both already hold at the database level; the point is that the new
  path must not weaken them.)
- Removing something that is already gone is harmless.

## Open questions for whoever picks this up

- Is party-wide strand removal an owner-only operation, or does it need agreement from other
  members of the strand? A strand is shared *between* parties; removing our row only removes
  our participation, which is probably fine — but say so explicitly.
- Where does the approval UI live — cadre-host's local UI, the CLI, or both?
- Should removal of a *closed* strand (whose row stores our private membership key for that
  network) warn harder, since the key is destroyed with the row and cannot be recovered?

## Related known gap

A delete that commits while this node is the only one online does not currently propagate
when others come back — documented under "Delete-while-alone durability" in
`docs/architecture.md` and tracked separately in
`tickets/backlog/control-delete-while-alone-tombstone.md`. Whatever wiring lands here inherits
that limitation; it is not this ticket's job to fix, but the UX should not promise more
durability than the layer beneath it delivers.
