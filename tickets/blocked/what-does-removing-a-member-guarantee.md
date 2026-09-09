----
description: An app that offers a "remove member" button leads users to believe removal does something. Reading our own source, an outside developer could not tell how much it does — and neither can we state it plainly. Decide what removal is meant to guarantee.
files: schemas/strand.qsql, docs/strands.md, packages/cadre-core/src/strand-membership.ts
----

# Decision (a): what is member removal intended to guarantee?

**Category (a) — a decision only a human should make.** Raised as **gotchoices/sereus#4** by an
outside consumer building a chat app. They are asking so they can write honest user-facing wording;
right now their story says "nothing further reaches them" and they are not confident that is true.

## The question, plainly

When a manager removes a member from a closed strand, what are we promising? Three sub-answers are
needed, and only the third has an obvious default.

**1. Can a removed party re-admit itself?** Today, yes. `docs/strands.md` says so outright: *"a
removed party holding an unspent, unexpired, uncancelled invitation still re-admits itself."*
Removal cannot cancel invitations addressed to the departing party because bearer invitations record
no intended recipient — `schemas/strand.qsql`'s `Invite` carries only `Key` and `Expiration` — and
nothing in `ConsumedInvite`'s gates checks that the issuing manager is still a manager.
**Is that a bug, or accepted behaviour pending `feat-strand-invitee-bound-invites`?**

**2. Can a removed party still write?** Unclear, and this is the one the reporter cares about most.
`feat-strand-party-identity` records that in production a closed strand ends up with exactly one
`Member` row — the founding one — and every joiner is handed the same `MemberPrivateKey`. If that
holds, a removed party still holds a key satisfying `Member.Authorized`. **Is stopping writes
achievable independently of rotating the read gate?**

**3. Can a removed party still read what it already has?** Yes, and the reporter explicitly is *not*
asking us to change that: `docs/strands.md` is clear that revocation is forward-looking and that
rotating the read gate currently means re-forming the strand. They judge that cost worse than the
benefit for a chat app. Default: leave as is, say so plainly in the docs.

## What happens if we do nothing

Consumers ship a remove button whose user-facing wording overstates what it does. The reporter has
already flagged that they are hedging; others will not notice and will simply claim more than we
deliver. That is a trust problem before it is a technical one.

## Options

- **Answer only, no code.** State the guarantee in `docs/strands.md` in the terms above, and let
  consumers word their UI accordingly. Cheapest; leaves both holes open.
- **Close the re-admission hole bluntly.** Removal cancels *all* outstanding invitations to the
  strand. Over-broad — it punishes uninvolved pending invitees — but it closes a revocation bypass
  with the schema we already have.
- **Close it properly.** `feat-strand-invitee-bound-invites` (backlog) binds an invite to its
  intended recipient, so removal can cancel exactly that party's invitations.
- **Close the write hole.** Depends on `feat-strand-party-identity` (backlog) landing, so each party
  holds its own key rather than sharing the founder's.

Recommended default: answer now in the docs, promote `feat-strand-party-identity` next, and treat
the blunt cancel-all as an interim only if a consumer ships removal before it lands.

## Reversibility

The doc answer is free to revise. The blunt cancel-all is a behaviour change consumers would come to
rely on and is awkward to walk back. The two backlog tickets are additive.

## Related work already on the board

`feat-strand-invitee-bound-invites` and `feat-strand-party-identity`, both in `backlog/`. The
reporter names both and notes the security framing is not obvious from either title — the security
consequence has been appended to each as an evidence arm rather than duplicated here.
