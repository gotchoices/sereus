----
description: Decide whether an invitation to a private group should name the person it is for, instead of working like a ticket that anyone holding it can use — and if so, whether removing someone should automatically void the invitations addressed to them.
prereq: bug-strand-invite-no-revocation
files: schemas/strand.qsql (Invite, ConsumedInvite), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (issueInvite, consumeInvite), packages/cadre-core/src/strand-member-registry.ts, docs/strands.md
difficulty: hard
----

# Should an invitation name its invitee?

Today an invitation to a closed strand is a **bearer credential**: it is a freshly minted
keypair, and whoever holds the private half can redeem it to seat a member key of their
choosing. The invitation records no intended recipient.

`bug-strand-invite-no-revocation` adds the missing cancellation primitive, so an operator can
now kill an outstanding invitation. What it deliberately does **not** do is make removal
automatic, because there is nothing to automate against: with no recorded invitee, "cancel the
invitations addressed to the party I just removed" is not a question the strand can answer.

## The question to decide

Should `Invite` carry the intended invitee's member key, so that:

- a given invitation can only ever seat **that** member key, and
- removing a member can cancel the invitations addressed to it in the same step?

## What binding would buy

- Removal becomes a real one-step gate. Today it takes removal *plus* an operator remembering
  to enumerate and cancel.
- A leaked or intercepted invitation is useless to anyone but its intended holder.
- A hostile manager stockpiling invitations for itself is neutralized by its own removal.

## What binding would cost — the reason this is not obvious

The invitee's strand member key may not exist yet when the invitation is issued. The current
flow is deliberately "hand out a secret out-of-band, invitee generates its own key and
redeems" — that is what lets a party be invited before it has any presence in the strand. If
invitations must name a member key up front, every invitation flow needs the invitee to have
already minted and disclosed a key, which changes the shape of the out-of-band handoff and
touches the enrollment path (`StrandMemberRegistry`, `StrandMemberVerifier`).

Possible middle grounds worth evaluating rather than assuming: bind at **first use** (the
first redemption fixes the invitee, so a second redemption for a different key is refused —
though the invitation is already single-use, so this buys little); or make binding **optional
per invitation**, with unbound invitations retained for the pre-key handoff case and bound
ones used where the invitee is already known.

## Also worth resolving here

`StrandMemberVerifier.isAuthorizedToJoin` answers "the door is open" from an invitation count
precisely because invitations are anonymous. If invitations gain an invitee, that pre-flight
can become a real per-member check instead of a strand-wide one.

## Prior art in this repo

The control layer's `CadreControl.FormationInvite` is also a bearer token (a random `Token`
with a use count) and has the same property. Whatever is decided here probably wants to be
consistent across both layers, or to state clearly why the two differ.
