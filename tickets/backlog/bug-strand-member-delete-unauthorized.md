----
description: Nothing appears to check who is allowed to remove a member from a closed group — the rules cover adding members but not removing them, so any writer may be able to evict anyone, including everyone.
files: schemas/strand.qsql (Member table, ~lines 93-116), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts
----

# `Strand.Member` deletes are unconstrained

The `Member` table carries three constraints:

- `NoUpdate check on update (false)`
- `OnlyClosed check (...)` — applies to all operations, but only asserts the strand is closed
- `Authorized check on insert (...)` — insert only

So a DELETE is gated by nothing but `OnlyClosed`, which any delete on a closed strand satisfies.
The schema already carries a `-- TODO: handle member revocation constraint` at that spot, so the
gap is known; this ticket is to make it a tracked item rather than a comment. Noticed while
planning `strand-manager-authorization-hardening`; **not reproduced** — the first step is a spec
that attempts a stranger-signed `delete from Strand.Member` and reports what happens.

Membership is the read gate for a closed strand, so unconstrained removal is both a denial-of-
service (evict everyone) and a way to strip a party's access.

## What needs deciding before implementing

Revocation is a policy question, not just a missing CHECK:

- Who may remove a member — any manager, only the member itself (leaving), or both?
- What happens to that member's `MemberPeer` rows? They are currently un-deletable at all (the
  `MemberExists` check reads `new.MemberKey`, which is null on delete), so a removed member's
  peer bindings would linger.
- Does the member's `ConsumedInvite` row stay, and can a removed member be re-admitted?
- Does removal need to interact with the read gate (key rotation), or is it advisory?

Related: `Strand.MemberPeer` deletes are currently rejected outright for the reason above — worth
resolving in the same pass, since a revocation story needs peer cleanup.
