----
description: We can prove that a device automatically opens a connection to another member of its party, but nothing proves data actually flows over that specific connection rather than taking an older route.
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/cadre-core/src/cadre-node.ts
difficulty: hard
----
## The gap

A party's members keep a small shared database (the "control database") holding
who is in the party and how to reach them. Every node runs a background routine
that dials the other members so that database can replicate between them.

`control-cohort-three-node-isolation.integration.ts` proves that routine is what
*forms* a connection: in a three-node party A/B/C, node B listens on no network
address at all, so nobody can dial B, and B learns C exists only from replicated
records — yet a B→C connection appears with no test-side dial. That part is
solid.

What no test proves is the next step: that the connection the routine formed
actually **carries data**. The isolation scenario's end-state check (C publishes
a new revision of its record, B sees it) is satisfied whether the revision
travelled B↔C or took the pre-existing route through A. The scenario says so in
its own comments, twice. So today a regression that formed the connection but
left it useless — e.g. the peer never gets seated in the other's replication
cohort, or the connection is opened on a network the database does not use —
would pass every test we have.

## Expected outcome

An integration scenario where a record written on one node can *only* reach
another node across a connection the reconcile routine formed, and it does.

The obvious shape — form B↔C, then take A away, then write on C and read on B —
is not free: A is the storage-profile node holding the control database's
blocks, so removing it may remove the data rather than just the route. Whoever
picks this up should expect to spend real effort finding a topology where the
alternate route can be cut without cutting the data, e.g.:

- a second storage-profile node so blocks survive A's departure, or
- severing only the A↔B link (connection gater / pruning) rather than stopping A,
  so A remains a block host but stops being a path between B and C, or
- observing at the wire level which connection the replication traffic used,
  instead of removing anything.

Any of those is acceptable; picking one is part of the work. Do not weaken the
existing isolation scenario's assertions to get there — it is a separate test.

## Not in scope

The related unanimity/threshold problem in small parties is already tracked in
`debt-harness-supermajority-threshold-diverges-from-production`; a three-member
scenario built for this ticket will run into it and should poll its control
writes the same way the isolation scenario does.
