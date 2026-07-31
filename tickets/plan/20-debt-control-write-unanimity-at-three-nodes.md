----
description: In a party of three machines, every change to the shared settings needs all three to approve it, so one machine hiccupping at the wrong moment fails the change outright.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, docs/architecture.md
difficulty: hard
----

# A three-machine party needs unanimous approval for every control write

## What is wrong

A write to the control database (party membership, strand list, owner keys) commits only once a
**super-majority** of the machines it was offered to approves it. The bar is
`ceil(machines × 0.75)`, and Cadre leaves that 0.75 at the storage layer's default.

Since the control database replicates each block to the whole party, the machine count is the
party size. At three machines the bar is `ceil(2.25) = 3` — **unanimous**. One machine that is
mid-reconnect, mid-relay-hop, or momentarily unresponsive is enough to fail the whole write.

Observed for real while validating `control-cohort-three-node-isolation.integration.ts`: a
`registerSelf()` issued while the third connection was still forming failed with

```
Some peers did not complete: … cause=The stream has been reset
Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)
```

The periodic record heartbeat retries the same call every ~7.5 minutes, so a long-lived node
self-heals eventually. But any *one-shot* control write in a small party can fail outright, and
callers are not uniformly written to retry. Three machines is a normal, documented deployment
size, not an edge case.

Note the bar is not monotonically painful with size: `ceil(n × 0.75)` demands unanimity at n = 2
and n = 3, then relaxes (4 machines need 3, 5 need 4). Three is the worst case that real parties
actually hit.

## What resolving this looks like

Pick one; all three are defensible and the choice is a product call.

- **Change the threshold semantics for small parties** — for example cap the required approvals
  below the machine count once there are three or more, or set an explicit "all but one" floor —
  so a single flaky link cannot veto a commit.
- **Add a retry policy for control writes** at the product level, beyond the existing heartbeat,
  so one-shot callers survive a transient reset instead of surfacing an error.
- **Decide unanimity-at-three is correct** and document it in `docs/architecture.md` →
  "Replication cluster size" as an accepted availability cost, so the next person to hit it knows
  it is intentional.

Whichever way, the reasoning should end up in `docs/architecture.md` rather than in a code
comment — the trade-off between replication breadth and write availability is already documented
there.

## Related

- `debt-harness-supermajority-threshold-diverges-from-production` — the integration harness used
  to run a looser threshold (0.51) than production, which is why this never showed up in the test
  suite. Now aligned.
- `debt-harness-record-fret-ring-convergence-finding` — measured that the owner's peer ring
  does reach all party members within ~5 s, so an owner-coordinated write issued after that
  window does form a three-machine cohort. Writes issued immediately after party creation
  race the ring and see one member, which is why this never showed up.
- `debt-harness-cohort-wait-and-force-helpers` — builds the wait/observe/force helpers the
  harness needs before a scenario can reproduce this reliably.
- `debt-harness-party-multi-machine-control-write` — the scenario that uses them; it is the
  place this fragility is expected to show up first.
- `debt-control-write-availability-degraded-cohort-member` (in `plan/`) — coverage for a
  connected-but-slow machine inside the cohort; the boundary it targets is exactly this one.
