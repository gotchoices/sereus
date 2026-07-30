----
description: Our integration tests start extra machines for a party, but the shared-settings database never sends a single write to them — every write is approved by the writer alone. So none of those tests prove anything about machines agreeing with each other.
prereq:
files: packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, packages/integration-tests/src/scenarios/basic-connectivity.integration.ts
difficulty: hard
----

# Integration harness never forms a multi-machine cohort for control writes

## What was observed

The integration harness (`createTestParty`) can build a party with extra "drone" machines
alongside the owner. They connect: `basic-connectivity.integration.ts` has a passing test
asserting the drones are dialled to the owner. But when the owner writes to the control database
(party membership, strand list, owner keys), the group of machines the write is offered to — the
*cohort* — contains only the owner.

Measured on `happy-path.integration.ts` (a party with 2 drones):

- Under `DEBUG='optimystic:db-p2p:cluster'`: **213 of 213** `cluster-tx:cluster-members` events
  report a cohort of exactly one peer.
- Under `DEBUG='optimystic:db-p2p:libp2p-key-network'`: every `findCluster:membership` line reads
  `serves=0 unknown=0 foreignDropped=0 kept=1`.

That second line matters. Cohort selection asks FRET (the peer-routing layer) for nearby peers,
then filters out any that serve a *different* network. Here the filter has nothing to filter —
FRET returned zero non-self candidates. So the drones are not being rejected; they are not in the
owner's routing table at all during the test's lifetime.

Changing the owner node from the `transaction` profile to `storage` (FRET `edge` → `core`) does
not change the result. The scenarios that build `CadreNode` directly — `control-cohort-*` — *do*
reach three-machine cohorts, so this is specific to the harness, not to the product.

## Why it matters

Every conclusion the harness-based scenarios appear to support about multi-machine behaviour is
unsupported:

- No harness test has ever exercised the approval threshold, replication to a second machine, or
  a partial-failure path on the write side. A regression in any of them passes the suite.
- A party of one machine writes to local storage without forming a cluster at all, so these
  scenarios are, on the control-DB path, barely more than single-node tests wearing a party's
  clothes.
- `debt-harness-supermajority-threshold-diverges-from-production` aligned the harness's approval
  threshold with production — correct, but currently inert for exactly this reason.

## What resolving this looks like

- Find why the drones never enter the owner's FRET routing table. Candidates worth ruling out
  first: routing-table convergence simply takes longer than the ~2–3 second scenarios run; the
  harness's `arachnode: { enableRingZulu: true }` on every node (production sets it only for
  storage-profile nodes) interacting badly with the `edge` FRET profile the owner gets; or the
  owner never re-querying after the drones join.
- Give the harness a way to *wait for* a cohort of a stated size before writing — something like
  `waitForControlCohort(party, minPeers)` — that fails with a clear message instead of silently
  proceeding self-only. Scenarios that mean to test multi-machine behaviour should assert it, not
  assume it.
- Once a real multi-machine cohort forms, expect some scenarios to start failing at the
  production approval bar; a three-machine party needs all three to approve. Those failures are
  findings. See `debt-control-write-unanimity-at-three-nodes`.

## Related

- `debt-harness-supermajority-threshold-diverges-from-production` — aligned the threshold; this is
  why that alignment currently changes nothing.
- `debt-control-write-availability-degraded-cohort-member` (in `plan/`) — wants to test a
  connected-but-slow machine inside the cohort. It cannot be written against the harness until
  this is fixed.
- `debt-control-write-unanimity-at-three-nodes` — the production-side fragility a real cohort
  would expose.
