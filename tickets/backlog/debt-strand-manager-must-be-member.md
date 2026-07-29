----
description: A group's admin is supposed to be one of its members, but nothing enforces that — an admin can be promoted from a key that never joined the group.
prereq: strand-manager-authorization-hardening
files: schemas/strand.qsql (Manager + Revocation tables), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (insertRevocation — the tombstone signer), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (addExtraManagers helper)
----

# `Strand.Manager` does not require a matching `Strand.Member`

The schema comment says "A manager is a member that can issue invites, authorize members, and
rotate managers", but no constraint enforces the "is a member" half: an existing manager can
promote any key, member or not. (After `strand-manager-authorization-hardening` lands, only the
*founding* manager is required to also be a `Member`, as part of its bootstrap gate — everything
after that is unchecked.)

Not an escalation by itself: promoting still requires a valid signature from an existing manager.
It is an integrity gap — a manager with no `Member` row is an admin who is not in the group, is
not read-gated like one, and has no `MemberPeer` bindings.

**Update — the invariant is now load-bearing at runtime.** Since the single-use-approval work
(`strand-approval-stamps-and-tags`), every deletion of a `Member`, `Manager`, or `MemberPeer` row
must file a tombstone into `Strand.Revocation` in the same transaction, and `Revocation.Authorized`
verifies the tombstone's signature against a **committed `Member` row**. So a manager with no
`Member` row is now half-functional: it can still add members, issue invites, and promote managers,
but it can NO LONGER revoke a member, clear a peer binding, or resign itself — all three file a
tombstone and are rejected. It can still be removed by another manager that *is* a member, so the
state is recoverable rather than wedged, but a member-less manager can strand itself in a seat it
cannot vacate. That makes "should a manager be required to be a member?" a correctness question,
not only a tidiness one.

Cost to fix is mostly in tests: `addExtraManagers` in
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` promotes fresh unrelated
keypairs, and other specs likely do the same, so adding a `MemberExists` constraint means
admitting each key as a `Member` first throughout.

Decide as part of the work: should promotion of a non-member be rejected outright, or should the
writer admit-then-promote in one transaction (deferred checks make that viable, as
`consumeInvite` already demonstrates)?
