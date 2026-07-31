description: The test helpers that pin a fixed set of machines for a shared write were widened to accept a second kind of node, but the one existing test that uses them with the original kind has not been run green since, so nobody has proved the widening did not break it.
prereq:
files: packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/key-network-patch.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts
difficulty: easy
----

# Run the degraded-cohort-member scenario against the widened forcing helpers

## What changed and why this is open

`harness/forced-cluster.ts` used to accept only `CadreNode` (the `cadre-core` class).
Two tickets widened it to also accept a bare harness node and a plain libp2p node, and a
review pass then moved both helpers onto a shared guarded patch module
(`harness/key-network-patch.ts`) that makes an out-of-order teardown throw instead of
silently leaving the patched method installed.

`control-write-degraded-cohort-member.integration.ts` is the **only** existing caller of
`forceFullCohort` / `pinCoordinator`, and it is the only one that exercises the
`CadreNode` shape. It has not been observed green since either change. It type-checks and
lints, and a new helper-only scenario
(`control-cohort-harness-helpers.integration.ts`, 12/12) covers every other branch —
including the out-of-order-restore guard — but the `CadreNode` branch and the
force-then-pin teardown order that this scenario actually performs are unproven at
runtime.

## Why it could not be run in the review pass

Two separate obstacles, in order:

1. The suite's stale-build guard refuses to start while the sibling `../quereus`
   workspace's compiled output is older than its source, and at the time of the review
   that workspace's source did not compile at all:
   `src/planner/stats/catalog-stats.ts(139,16): error TS2304: Cannot find name 'catalogRowCount'`.
   That is an in-flight edit in another repository, not a Sereus defect. It clears on its
   own once that workspace builds again.
2. Before that, a run of this scenario failed inside `beforeAll` at
   `Timeout waiting for B resolves C's signed address record after 45000ms`
   (`:406`), about 56 s in, with all six tests skipped — **before** control reaches the
   `forceFullCohort` / `pinCoordinator` calls at `:431-436`.

## What to do

- Rebuild `../quereus` (or wait for its runner to), then run the scenario.
- If it reaches the forcing calls, the widening and the restore guard are proven — close
  this ticket.
- If it still dies at `:406`, that is a **separate** question this ticket does not own:
  confirm whether it is the same root cause as
  `blocked/transactor-key-network-ignores-network-scoping`. That blocked ticket names a
  different file (`control-cohort-three-node-isolation.integration.ts`) and explicitly
  records this scenario as having been **green** in an earlier run, so the two may not be
  the same failure. If they are not, the failure is untracked and belongs in
  `tickets/.pre-existing-error.md` per the pre-existing-failure rule. Either way, do not
  skip, weaken, or comment out any case.
- `docs/STATUS.md` marks this scenario `[x]` with a ~185 s runtime. If the failure turns
  out to be durable rather than environmental, that claim needs correcting.
