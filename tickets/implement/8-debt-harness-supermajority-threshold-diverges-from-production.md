----
description: Our integration tests let a write succeed with fewer machines approving it than a real deployment requires; make the tests use the real rule, and make the setting come from one shared place so the two can't drift apart again.
prereq:
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/basic-connectivity.integration.ts
difficulty: medium
----

# Harness and production must run the same control-write approval rule

## Background

A write to the control database (party membership, strand list, owner keys) commits only once a
**super-majority** of the peers in that block's cohort approves it. The fraction is
`clusterPolicy.superMajorityThreshold`, and Optimystic computes the bar as
`Math.ceil(peerCount * threshold)` (`packages/db-p2p/src/repo/cluster-coordinator.ts`, in the
`../optimystic` workspace).

- Production (`CadreNode.buildControlNodeOptions`, `packages/cadre-core/src/cadre-node.ts:948`)
  passes `clusterPolicy: { allowDownsize: true, sizeTolerance: 0.5 }` and omits the threshold, so
  it inherits Optimystic's `DEFAULT_SUPER_MAJORITY_THRESHOLD` = **0.75**.
- The integration harness (`packages/integration-tests/src/harness/test-party.ts:62`) passes the
  same two keys **plus** `superMajorityThreshold: 0.51`.

The override is not a considered decision — `git log -S superMajorityThreshold` shows it arriving
in the suite's very first commit (`ee3954c "Basic integration test"`) and never revisited.

## What was measured during planning

Two things were checked empirically, and both narrow this ticket considerably. Do not re-derive
them; do sanity-check them if a change you make looks like it should have moved them.

**1. The two values only differ at odd cohort sizes ≥ 3.** `ceil(n × 0.75)` vs `ceil(n × 0.51)`:

| cohort size | needs @ 0.75 | needs @ 0.51 | differs? |
|---|---|---|---|
| 1 | 1 | 1 | no (and the coordinator skips the check entirely at `peerCount === 1`) |
| 2 | 2 | 2 | no |
| 3 | 3 | 2 | **yes** |
| 4 | 3 | 3 | no |
| 5 | 4 | 3 | **yes** |

Across the whole suite, only `basic-connectivity.integration.ts` (`droneCount: 2` and `3`) and
`happy-path.integration.ts` (`droneCount: 2`) build parties big enough to reach 3. Every other
harness scenario builds single-node parties (`createParty({ name })`) or `droneCount: 1`.

**2. Removing the override changes nothing today, because harness cohorts are always
self-only.** With the override deleted, `basic-connectivity` + `happy-path` pass unchanged
(7 tests). Running `happy-path` under `DEBUG='optimystic:db-p2p:cluster'` shows **213 of 213**
`cluster-tx:cluster-members` events with a cohort of exactly one peer — the owner. Under
`DEBUG='optimystic:db-p2p:libp2p-key-network'`, every `findCluster:membership` line reads
`serves=0 unknown=0 foreignDropped=0 kept=1`: FRET's `assembleCohort` returns zero non-self
candidates, so it is not the membership filter dropping the drones — they are simply not in the
owner's FRET ring within the test's lifetime. Flipping the owner node from `'transaction'` to
`'storage'` profile (i.e. FRET `edge` → `core`) does not change this.

So the harness's drone nodes have **never** participated in a control-DB commit, and
`superMajorityThreshold` has been inert since it was written. That larger gap is filed separately
as `backlog/debt-harness-control-cohort-never-multi-peer` and is **out of scope here** — this
ticket makes the setting correct and structurally undriftable so that when cohorts do become
multi-peer, they are measured against the production bar.

## Design

Delete the harness override (the ticket's preferred option — the harness should measure what
ships), and go one step further: make the divergence *impossible to reintroduce* by giving the
control network's cluster policy a single exported definition that both production and the
harness consume. Today the object literal `{ allowDownsize: true, sizeTolerance: 0.5 }` is
hand-copied at both sites; deleting `0.51` fixes the symptom but leaves the copy-paste seam that
produced it.

`packages/quereus-plugin-sereus/src/cluster-size.ts` is already the single source of truth for
control-network replication knobs (`CONTROL_REPLICATION_BREADTH`), re-exported through
`packages/cadre-core/src/types.ts`. The new constant belongs beside it.

```ts
// packages/quereus-plugin-sereus/src/cluster-size.ts

/**
 * Cluster consensus policy every CONTROL-network libp2p node runs — production
 * (`CadreNode.buildControlNodeOptions`) and the integration harness alike.
 *
 * `superMajorityThreshold` is deliberately ABSENT: omitting it makes both the cluster
 * member and the coordinator fall back to Optimystic's
 * `DEFAULT_SUPER_MAJORITY_THRESHOLD` (0.75), which is what a real party runs. Setting it
 * here — or at any one consumer — reintroduces the divergence this constant exists to
 * prevent.
 *
 * NOT for strand networks: `strand-instance-manager.ts` passes a structurally identical
 * literal for a different network with different reasoning. Keep them separate.
 */
export const CONTROL_CLUSTER_POLICY = Object.freeze({
	allowDownsize: true,
	sizeTolerance: 0.5,
});
```

Consumers:

- `cadre-node.ts:948` → `clusterPolicy: CONTROL_CLUSTER_POLICY,`
- `test-party.ts:53–63` → `clusterPolicy: CONTROL_CLUSTER_POLICY,` (whole literal, including the
  `NOTE:` and the `0.51`, replaced)

Two guards, at the two layers where drift would appear:

- **Config layer** — `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` already
  asserts `clusterPolicy.allowDownsize` and `clusterPolicy.sizeTolerance`. Add an assertion that
  `clusterPolicy.superMajorityThreshold` is `undefined`, with a comment stating that absence is
  what selects the 0.75 default.
- **Runtime layer** — `basic-connectivity.integration.ts` already builds parties, so add one test
  there asserting the *resolved* coordinator threshold on a harness-built node equals
  production's default:

  ```ts
  import { DEFAULT_SUPER_MAJORITY_THRESHOLD } from '@optimystic/db-core';
  import type { CoordinatorRepo } from '@optimystic/db-p2p';
  // ...
  const coordinator = party.ownerNode.coordinatedRepo as unknown as CoordinatorRepo;
  expect(coordinator.effectiveSuperMajorityThreshold).toBe(DEFAULT_SUPER_MAJORITY_THRESHOLD);
  ```

  This is the assertion the config-layer test cannot make: it reads what the live node actually
  resolved, after `createLibp2pNode` has threaded `clusterPolicy` into both the cluster member and
  the coordinator. (`effectiveSuperMajorityThreshold` is a public getter on `CoordinatorRepo`,
  `packages/db-p2p/src/repo/coordinator-repo.ts`; `DEFAULT_SUPER_MAJORITY_THRESHOLD` is exported
  from `@optimystic/db-core` via `cluster/structs.ts`.)

Do **not** put the runtime guard in `packages/integration-tests/test/*.spec.ts` — per
`vitest.config.ts` that directory holds unit specs about the suite's own wiring and deliberately
does no network setup.

Finally, leave a short `NOTE:` at the harness node-creation site recording the measured fact that
harness control cohorts are currently self-only, pointing at
`backlog/debt-harness-control-cohort-never-multi-peer`. A future reader who assumes the harness
exercises multi-peer approval needs to meet that where the nodes are built.

## Edge cases & interactions

- **No behaviour change is expected from this ticket.** Every harness cohort is size 1, where the
  coordinator's `peerCount > 1 && approvalCount < superMajority` guard never fires. If a scenario
  *does* start failing, that is a finding worth reporting in the handoff, not a reason to restore
  `0.51`.
- **Shared frozen object.** `CONTROL_CLUSTER_POLICY` is one object passed to two (eventually many)
  `createLibp2pNode` calls. Confirm Optimystic does not mutate `options.clusterPolicy` — under ESM
  strict mode a write to a frozen object throws. If mutation is found, drop `Object.freeze` and
  hand each caller a spread copy rather than removing the shared constant.
- **Member/coordinator coupling.** `createLibp2pNode` calls `assertSuperMajorityCoupling` at
  construction and throws if the cluster member and coordinator resolve different thresholds. Both
  read the same `clusterPolicy`, so omission keeps them equal — but if you refactor how the policy
  is threaded, a mismatch fails loudly at node construction, not silently mid-consensus.
- **Strand networks must not be swept in.** `strand-instance-manager.ts:271` and
  `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts:93` pass an identical-looking
  literal for `strand-*` networks. Leave both alone; the shape matching is a coincidence, not
  shared meaning.
- **Package build order.** `@serfab/cadre-core` imports from `@serfab/quereus-plugin-sereus`
  (never the reverse). Build the plugin first, or the re-export in `types.ts` will not resolve.
- **Stale-build guard.** The integration suite's `globalSetup` fails the run when any cadre
  package's `dist` predates its `src`. Both packages you touch are on that list, so rebuild before
  running integration scenarios.
- **Existing export list.** `types.ts` re-exports the cluster-size symbols in one named `export {}`
  block with a shared docblock; add `CONTROL_CLUSTER_POLICY` to that block rather than starting a
  second one, and extend the docblock to cover it.

## TODO

Phase 1 — shared constant

- Add `CONTROL_CLUSTER_POLICY` to `packages/quereus-plugin-sereus/src/cluster-size.ts` with the
  docblock above (state explicitly why `superMajorityThreshold` is absent, and that strand
  networks are out of its scope).
- Export it from `packages/quereus-plugin-sereus/src/index.ts` alongside the existing cluster-size
  symbols.
- Re-export from `packages/cadre-core/src/types.ts` in the existing named-export block; extend
  that block's docblock to mention the policy.
- Confirm the constant's type is structurally accepted by `createLibp2pNode`'s `clusterPolicy`
  parameter at both consumers without adding a new cross-package dependency.

Phase 2 — consumers

- `packages/cadre-core/src/cadre-node.ts:948` — replace the inline literal with
  `CONTROL_CLUSTER_POLICY`; keep the surrounding `clusterSize` / `assumedClusterSize` comment.
- `packages/integration-tests/src/harness/test-party.ts:53–63` — replace the whole `clusterPolicy`
  literal (override, `NOTE:` block and all) with `CONTROL_CLUSTER_POLICY`.
- Add a `NOTE:` at the harness node-creation site recording that harness control cohorts are
  currently self-only (measured: 213/213 single-peer in `happy-path`), pointing at
  `backlog/debt-harness-control-cohort-never-multi-peer`.

Phase 3 — guards

- `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` — assert
  `options.clusterPolicy?.superMajorityThreshold` is `undefined`, commenting that absence selects
  Optimystic's 0.75.
- `packages/integration-tests/src/scenarios/basic-connectivity.integration.ts` — add a test
  asserting `effectiveSuperMajorityThreshold` on a harness party's `coordinatedRepo` equals
  `DEFAULT_SUPER_MAJORITY_THRESHOLD`.

Phase 4 — validate

- `yarn workspace @serfab/quereus-plugin-sereus build` then
  `yarn workspace @serfab/cadre-core build` (order matters).
- `yarn workspace @serfab/quereus-plugin-sereus test` and
  `yarn workspace @serfab/cadre-core test`.
- From `packages/integration-tests`, stream the harness-based scenarios:
  `yarn vitest run --reporter=verbose src/scenarios/basic-connectivity.integration.ts src/scenarios/happy-path.integration.ts src/scenarios/multi-party-sync.integration.ts 2>&1 | tee /tmp/harness-threshold.log`
  (never redirect silently — the runner's idle timer needs streamed output).
- `yarn lint` and `yarn typecheck` on the touched packages.
- If the stale-build guard reports `@quereus/quereus` stale, that is the neighbouring
  `../quereus` workspace, not this change — build it with
  `yarn workspace @quereus/quereus build` from `C:/projects/quereus` and continue.

## Handoff notes for review

State plainly in the `review/` ticket that this change is expected to be behaviour-neutral today,
and why (self-only cohorts), so the reviewer does not read a green suite as evidence that
multi-peer approval is now covered. It is not; that is
`backlog/debt-harness-control-cohort-never-multi-peer`.
