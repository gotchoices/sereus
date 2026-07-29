----
description: Adding a member to a party only takes effect for the security check that admits that member's traffic if the code doing the adding remembers to say "I added someone" — and it is easy to forget, which briefly locks the new member out. Make it automatic instead.
prereq:
files:
  - packages/cadre-core/src/cadre-node.ts (`refreshAuthorizedControlPeers`, `refreshMembershipGate`, the membership wrappers, `authorizeInboundControlStream`)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` — the single place every member row is written)
difficulty: medium
----

# Make the membership-gate refresh automatic instead of a caller obligation

## Background

A node decides whether to accept another node's control-database traffic by checking an
in-memory list of the members it currently believes are approved. That list is a snapshot:
it is rebuilt from the database only when something explicitly rebuilds it. It cannot be
replaced with a live database read — answering the question would require accepting the very
traffic being judged.

Today the rebuild is attached to each of the seven `CadreNode` methods that add or remove a
member (`authorizePeer`, `removePeer`, `addDrone`, `acceptPhone`, `addPhoneWithRelay`,
`applySeed`, `registerSelf`), plus a timer that re-reads roughly every 15 seconds. Anything
that writes a member row without going through one of those methods leaves the snapshot
stale, and for up to ~15 seconds the node denies the traffic of the member it just approved
— long enough to kill that member's database startup outright, which is what the
`push-wake-e2e` work chased down.

## Why this is worth doing

The obligation is documented (in `CadreNode.refreshMembershipGate`'s doc comment and in
`docs/architecture.md`) but not enforced, and it has already been missed twice:

- an integration-test helper wrote a member row through the lower-level service and denied
  the peer it had just vouched for (fixed by calling the refresh explicitly);
- `CadreNode.addPhoneWithRelay` forwarded to a service method that authorizes the phone
  internally and never refreshed — found and fixed during the review of that same work.

Both were one-line fixes, which is the point: the rule is easy to satisfy and easy to skip,
and skipping it is silent. Every member row in the codebase is written through exactly one
private helper (`SeedBootstrapService.insertCadrePeerRow`) plus the delete path, so there is
a single natural place for the notification to originate.

## Expected behavior

- Any code path that adds or removes a `CadrePeer` row causes the writing node's approved-member
  snapshot to be rebuilt, without the caller having to remember anything.
- The rebuild stays best-effort: a failed read keeps the previous snapshot and never rejects,
  and it must not fire inside a database transaction that has not committed yet — the read it
  performs must see the committed row, not race it.
- Repeated writes should not turn into a storm of redundant reads (coalescing, or a
  cheap "snapshot is dirty" flag consulted by the gate, is acceptable — the shape is the
  designer's call).
- `refreshMembershipGate()` may stay as a public escape hatch, or be removed if the automatic
  path makes it dead. The wrappers' explicit calls should collapse into whatever replaces them
  rather than being duplicated.

## Out of scope

The `~15s` reconcile timer itself, and the deliberate bounded staleness for a member added
while this node was down — those are by design and unchanged.
