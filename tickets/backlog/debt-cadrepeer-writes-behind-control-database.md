description: Nothing stops future code from adding or removing a party member by writing the database table directly, which quietly skips the security bookkeeping that admits that member's traffic. Make the direct route unavailable so the mistake cannot be made again.
prereq: debt-membership-gate-coalescing-refresh
files:
  - packages/cadre-core/src/control-database.ts (`mutateCadrePeer`, `getDatabase`, the existing owner-signed write methods `insertStrand` / `deleteGuardedRow` as the shape to copy)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow`, `removePeer`, `reauthorizePeer` — the SQL that would move)
difficulty: medium
----

# Close the direct-SQL route to the party-member table

## The situation

Each node keeps an in-memory list of the peers it believes are approved party members and
refuses inbound database traffic from anyone not on it. The list is a snapshot: it is
rebuilt when a member row is written, not read live (reading it live would require admitting
the very traffic the check is gating). So *every* write to the member row table must trigger
that rebuild, or the node denies the traffic of the member it just approved.

Writes are now funnelled through one method on the control database
(`ControlDatabase.mutateCadrePeer`) which does the triggering. That closes the hole — for
the writers that use it.

What it does **not** do is make the wrong way unavailable. Any code holding the control
database can call `getDatabase()` and run `insert into CadreControl.CadrePeer …` itself,
with no compiler error, no lint error, and no runtime complaint — and it will silently leave
the snapshot stale. This exact mistake has already been made twice (an integration-test
helper, and one of the node's own phone-pairing methods), each time costing a debugging
session where a freshly-approved member's database startup died with no obvious cause.
Today the rule "member writes go through `mutateCadrePeer`" is upheld by a grep, and only
holds as long as every future author happens to know it.

## What to build

Move the three owner-signed member-row statements out of `SeedBootstrapService` and behind
methods on `ControlDatabase`, so the table is only reachable through code that notifies:
insert (the owner-vouched add), delete-plus-tombstone (the remove), and the voucher-rewrite
update (the re-replication re-touch). The class already hosts exactly this shape for other
guarded tables, so the destination is not new ground.

The member table cannot simply reuse the existing shared delete helper: its authorization
digests are built differently from the other guarded tables (its own voucher and remove
digest constructions), which is why the original plan skipped this and accepted the grep
instead. Whoever picks this up should decide whether to generalize that helper or add
member-specific methods beside it — the goal is only that no caller outside
`ControlDatabase` can write the table.

## Expected outcome

- No `CadrePeer` insert / update / delete statement exists outside `control-database.ts`
  (test fixtures that deliberately drive raw SQL against a bare database are fine and
  should stay — they are testing the constraints, not managing membership).
- A new caller that wants to add or remove a member has exactly one API to reach for, and
  gets the snapshot refresh whether or not it knows the refresh exists.

## Not in scope

The signing, digest, and trust-policy logic itself. This is about where the statements
live, not changing what they authorize. Behaviour must be identical afterwards.
