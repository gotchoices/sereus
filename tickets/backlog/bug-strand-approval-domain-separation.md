----
description: In a closed group, the approval an admin signs to let someone join is the exact same signed value needed to strip that person of their admin rights — so a routine "add this member" approval can be reused by anyone to demote an admin.
files: schemas/strand.qsql (Member.Authorized, Manager.Authorized, MemberPeer.Authorized), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts
difficulty: medium
----

# Strand approvals are not scoped to a table or an action

## What is wrong

Every signed write in the `Strand` schema is authorized by an ed25519 signature over a hash of
just the affected key(s) — nothing in the signed bytes says *which table* or *which operation*
the approval was for. Two different rules therefore accept the very same signature.

The concrete, reachable case:

- **Admitting a member.** `Member.Authorized` (direct-admit branch) accepts a manager's
  signature over `digest(new.Key)` — i.e. the hash of the key being admitted. This is the
  normal `addMemberByManager` flow.
- **Removing an admin.** `Manager.Authorized` (admin-removal branch) accepts *another*
  manager's signature over `digest(old.MemberKey)` — the hash of the manager key being removed.

Those are byte-identical constructions. So when manager **M** signs an approval to admit key
**X** as a member, that same approval is a valid authorization for anyone to delete **X**'s
`Manager` row.

This matters because the standard way to seat a new admin is *admit as member, then promote to
manager* — which mints exactly the signature needed to demote them again. Constraint context
values travel with the write out to the strand's peers, so anyone who has seen the admit write
holds the demotion approval; no privileged network position is needed.

`Manager.MinOneManager` stops the strand from losing its last admin, but does not stop
targeted demotion of any other admin.

The same shape appears elsewhere in the schema and should be swept, not patched pointwise:
`MemberPeer.Authorized` uses one construction for insert, update **and** delete; the manager
self-resignation branch signs `digest(old.MemberKey)`, which is also a valid member-admit
approval for that same key.

## What good looks like

The control plane already solved exactly this (see `complete/2-control-approval-domain-separation`).
There, every signed message leads with two fixed labels — the table it applies to and the action
(`add` / `remove` / …) — before any row fields, so an approval verifies against one rule only.
The strand layer needs the same treatment, adapted to its own signing idiom.

Expected behaviour after the fix:

- An approval minted to admit a member is refused for every other rule, including admin removal.
- An approval minted to remove an admin is refused for admission and for self-resignation.
- An approval minted for a `MemberPeer` insert is refused for its delete.
- Existing legitimate flows (`addMemberByManager`, `addManager`, `removeManager`, invite
  consumption, peer publication) keep working end to end.

No backwards compatibility is required — old untagged signatures may stop verifying.

## Relationship to sibling tickets

- `bug-strand-manager-authority-antireplay` (in `fix/`) covers the *other* axis — approvals
  being single-use and nonce-bound. It names this shape in passing but does not call out the
  member-admit → admin-removal collision, and a nonce alone does not close it. The two are
  complementary and could sensibly be done together.
- `bug-strand-member-delete-unauthorized` (in `fix/`) covers `Member` deletes being ungated at
  all. Whatever rule that ticket adds must be tagged from the start rather than retro-fitted.
