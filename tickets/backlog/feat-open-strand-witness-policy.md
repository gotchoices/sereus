----
description: A workspace can be marked as open to anyone, but nothing about how it protects itself is any different from an invitation-only one. Decide what an open workspace should actually require before it accepts a change, and whether we should offer that mode at all until we can back it up.
prereq: feat-strand-party-identity
files: schemas/strand.qsql, schemas/control.qsql, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

# An open workspace gets the same protections as an invitation-only one

## The gap

A workspace is created as either **open** or **closed**, and the flag is recorded immutably in
two places: `Strand.Header.Type` (`schemas/strand.qsql`, insert-only singleton) and
`CadreControl.Strand.Type` (`schemas/control.qsql`, no updates permitted). Today the flag
governs who may read and who may join. It governs nothing about how the workspace protects
itself from a participant acting in bad faith.

That is fine for a closed workspace. Everyone in it arrived through an invitation, holds a
signed identity, and can be removed — accountability does most of the work that a stricter
voting rule would otherwise have to do.

It is not fine for an open one, where none of that is true. Two settings that are defensible
under invitation-only assumptions become weak spots:

- The value Optimystic calls its **assumed cohort size** is left at 2, which is what lets a
  household with one or two machines work at all. In an open workspace it also means the
  corroboration floor can fall to a single voter, so one participant's claim about what the
  current data is can be accepted without a second opinion. In a closed workspace that
  participant is a named member who can be expelled. In an open one they are anonymous and can
  return immediately under a new identity.
- Changes that carry rules for everyone — who may administer, who is a member, what has been
  revoked — commit on the same super-majority as ordinary data. That threshold counts machines
  in the group holding the data, and in an open workspace an attacker chooses how many machines
  they bring.

## The uncomfortable part

The intuition that a bigger network needs stronger protection has this backwards. A **small
open** workspace is the cheapest thing in the system to attack: joining is free, so an attacker
can be most of any group with a handful of machines, and the routing layer's own estimate of
how large the network is has no confidence at that size, so the weaker fallback rule is the one
in force. A large invitation-only deployment is far safer at identical settings.

Danger tracks **how you get in**, not how many are already inside.

## What this ticket has to decide

The decision is a product one as much as an engineering one, and there is no defensible default
to just pick — which is why this sits in backlog rather than going straight to plan.

1. **Do we support genuinely open workspaces at all in the near term?** `docs/strands.md`
   states Sereus is intended to be invitation-only. If that holds, the honest move may be to
   restrict what an open workspace is allowed to be used for — read-only publication, say —
   rather than implying it carries the same integrity guarantees as a closed one. Shipping an
   "open" mode whose only difference is larger numbers would be worse than not offering one.
2. **If yes, what makes a new participant cost something?** Everything else depends on this.
   Without some barrier to creating identities, no voting threshold helps: the attacker simply
   brings more identities. Options span invitation chains that stop short of full membership,
   attestation by existing participants, external identity anchoring, and stake — each with
   very different implications for who can use the product.
3. **What must a rule-bearing change require, distinct from an ordinary data write?** The
   promising split is that ordinary data commits locally and replicates lazily, while changes
   carrying rules for everyone require attestation from several distinct parties. That is the
   two-layer model `docs/cadre-consistency.md` already proposes for the control database,
   applied to strands. It cannot be enforced until copy placement can tell parties apart, which
   is why `feat-strand-party-identity` is a prerequisite — and that ticket records why the gap is
   wider than it looks: production strands write no per-party membership rows at all today.
4. **What is the assumed-cohort-size value for an open workspace, and who sets it?** It must be
   identical for every participant or writes fail, so it has to come from a single replicated
   source rather than each machine's own config. The immutable open/closed flag is the obvious
   source and is already readable before a strand's network is built.

## Why the open/closed flag is the right input, and why it is not wired up yet

Ruled out during the discussion that produced this ticket: deriving policy from how many people
are in the workspace. It cannot be read before the network it would configure exists, it does
not exist at all for open workspaces, it changes in the direction that breaks writes, and it
counts parties where the setting consumes machines. The full reasoning is recorded in
`implement/debt-strand-replication-breadth-ignores-party-count`.

The flag has none of those problems. It was deliberately *not* threaded through when the strand
replication default was raised, because open and closed want the same number of copies today —
both benefit identically from lifting the corroboration floor off a single voter — and a
parameter whose two branches are identical is speculative generality. This ticket is what gives
the flag a real branch to justify carrying it. `strand-instance-manager.ts` already has the
strand row in scope at the call site, so the threading itself is small; the policy behind it is
not.

## What happens if we do nothing

Open workspaces keep working and keep looking equivalent to closed ones. Nothing fails, and
nothing warns. The exposure is silent, which is the argument for deciding deliberately rather
than letting it stand by default.
