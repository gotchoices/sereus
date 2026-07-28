----
description: A group's admin is supposed to be one of its members, but nothing enforces that — an admin can be promoted from a key that never joined the group.
prereq: strand-manager-authorization-hardening
files: schemas/strand.qsql (Manager table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (addExtraManagers helper)
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

Cost to fix is mostly in tests: `addExtraManagers` in
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` promotes fresh unrelated
keypairs, and other specs likely do the same, so adding a `MemberExists` constraint means
admitting each key as a `Member` first throughout.

Decide as part of the work: should promotion of a non-member be rejected outright, or should the
writer admit-then-promote in one transaction (deferred checks make that viable, as
`consumeInvite` already demonstrates)?
