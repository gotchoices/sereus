----
description: Our two-node tests prove that one machine can see the other's data, but not that it actually holds a copy — if the first machine went offline, we do not currently test whether the second one still has the information.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
difficulty: medium
----

## The gap

Several two-node integration tests assert "node B sees the row node A wrote" and
treat that as proof of replication. It is not.

When a node reads a piece of data, it picks one peer to act as the coordinator for
that piece. If the coordinator turns out to be the node that authored the data, then
node B's `select` is a remote call against node A's storage — node B never had to
store anything locally for the read to succeed. So a passing "B sees it" assertion is
consistent with two very different worlds:

- the data genuinely replicated to B (what we want), and
- the data lives only on A, and B is reading it over the network (durability risk —
  if A goes away, the data goes with it).

Both current closed-strand tests, and the cross-node observation in
`rbac-signed-write.integration.ts`, are in this position. The
`strand-membership-closed-strand-e2e.integration.ts` header already documents the
caveat honestly; nothing tests past it.

## Why it matters

Replication breadth for a strand is 4 copies per block (`DEFAULT_STRAND_CLUSTER_SIZE`,
raised from 2 by `debt-strand-replication-breadth-ignores-party-count`), and the cohort
is capped at the peers that actually serve the strand — so on a **two**-node strand every
block should land on both nodes and the distinction should not bite. That is a claim we
believe but do not verify. If it is ever wrong — or if breadth changes again, or the
strand grows past four nodes, where partial replication resumes and a reader outside the
cohort is genuinely reading over the network — the tests would keep passing while
durability quietly disappeared.

## What proof would look like

Two candidate techniques, either of which turns visibility into a replication proof:

- **Stop the author, then read.** After the writes converge, shut down the node that
  authored them and assert the surviving node can still read them. Closest to the
  real failure it guards against. Needs care with teardown ordering so a stopped node
  does not strand its partner or hang the run.
- **Read the raw storage directly.** Inspect the second node's own block store rather
  than going through its database, so no coordinator hop can satisfy the read.
  Cheaper and less disruptive, but couples the test to storage internals.

Pick one and apply it to at least the closed-strand membership scenario; decide
separately whether `rbac-signed-write` warrants the same.

## Out of scope

Changing replication breadth, or anything about how many copies a strand keeps —
this ticket is about *measuring* what we already have.
