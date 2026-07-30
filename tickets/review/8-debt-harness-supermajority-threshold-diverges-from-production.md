----
description: The integration tests used to let a write succeed with fewer machines approving it than a real deployment requires; they now use the real rule, and the setting lives in one shared place so the two cannot drift apart again.
prereq:
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/basic-connectivity.integration.ts, docs/architecture.md
difficulty: medium
----

# Review: harness and production now run the same control-write approval rule

## What changed

A write to the control database (party membership, strand list, owner keys) commits only once a
**super-majority** of the peers in that block's cohort approves it. The fraction is
`clusterPolicy.superMajorityThreshold`; Optimystic's bar is `Math.ceil(peerCount * threshold)`.
Production omitted the key and therefore inherited Optimystic's default of **0.75**; the
integration harness passed **0.51**, so a harness cohort of 3 could commit on 2 approvals where a
real party needs 3.

Both call sites now pass one shared frozen constant that names no threshold at all.

**New constant** — `CONTROL_CLUSTER_POLICY` in
`packages/quereus-plugin-sereus/src/cluster-size.ts`, beside `CONTROL_REPLICATION_BREADTH`:

```ts
export const CONTROL_CLUSTER_POLICY = Object.freeze({
	allowDownsize: true,
	sizeTolerance: 0.5,
});
```

Its docblock states that `superMajorityThreshold` is deliberately absent (absence is what selects
0.75, for both the cluster member and the coordinator), and that strand networks are out of its
scope. Exported through `packages/quereus-plugin-sereus/src/index.ts` and re-exported from
`packages/cadre-core/src/types.ts` in the existing cluster-size export block.

**Consumers**

- `packages/cadre-core/src/cadre-node.ts:948` — the inline `{ allowDownsize: true, sizeTolerance:
  0.5 }` literal replaced with `CONTROL_CLUSTER_POLICY`. Behaviourally identical.
- `packages/integration-tests/src/harness/test-party.ts:53` — the whole `clusterPolicy` literal,
  `superMajorityThreshold: 0.51` and its `NOTE:` block included, replaced with the same constant.

**Guards**

- `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` — a new test asserts
  `options.clusterPolicy?.superMajorityThreshold` is `undefined` *and* that
  `options.clusterPolicy` is the shared `CONTROL_CLUSTER_POLICY` object by identity. The identity
  assertion is the part that catches "someone spreads a copy and adds a key".
- `packages/integration-tests/src/scenarios/basic-connectivity.integration.ts` — a new test reads
  the threshold a **live** harness node resolved
  (`coordinatedRepo.effectiveSuperMajorityThreshold`) and asserts it equals
  `DEFAULT_SUPER_MAJORITY_THRESHOLD` from `@optimystic/db-core`. This is the assertion the
  config-layer test cannot make: it runs after `createLibp2pNode` has threaded `clusterPolicy`
  into the coordinator and the cluster member.

**Tripwire recorded** — a `NOTE:` at the harness node-creation site
(`test-party.ts`) records the measured fact that harness control cohorts are self-only today
(213/213 single-peer cohorts across a `happy-path` run), pointing at
`backlog/debt-harness-control-cohort-never-multi-peer`. Nobody should read the harness as
exercising multi-peer approval.

**Docs** — `docs/architecture.md` → "Replication cluster size" gained one bullet naming
`CONTROL_CLUSTER_POLICY`, why the threshold is set by omission, and why it is shared rather than
copied. The section's opening line now says the harness shares it too.

## The honest gap — read this before reading the green suite as coverage

**This change is expected to be behaviour-neutral today, and it is.** Every harness cohort is
size 1, where the coordinator's `peerCount > 1 && approvalCount < superMajority` guard never
fires. `ceil(n × 0.75)` and `ceil(n × 0.51)` only differ at odd cohort sizes ≥ 3, and the harness
never reaches a cohort of 3 — measured during planning, unchanged here.

So: a green suite after this change is **not** evidence that multi-peer approval is now covered.
It is not covered. That larger gap is `backlog/debt-harness-control-cohort-never-multi-peer` and
was explicitly out of scope. What this ticket bought is that *when* harness cohorts do become
multi-peer, they will be measured against the production bar without anyone remembering to go
change a number.

The new runtime guard has the same shape of limitation, and it is worth naming: it asserts the
node *resolved* 0.75, not that a 3-peer cohort *behaved* like 0.75. It is a wiring assertion, and
that is all a self-only-cohort harness can offer.

## Verification performed

- `yarn workspace @serfab/quereus-plugin-sereus build` then `yarn workspace @serfab/cadre-core
  build` (order matters — cadre-core imports the plugin, never the reverse).
- `yarn workspace @serfab/quereus-plugin-sereus test` — 7 files, 68 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test` — 76 files, 1199 passed, 1 skipped.
- From `packages/integration-tests`:
  `yarn vitest run --reporter=verbose src/scenarios/basic-connectivity.integration.ts
  src/scenarios/happy-path.integration.ts src/scenarios/multi-party-sync.integration.ts`
  — 3 files, 12 passed, including the new threshold test. No scenario changed behaviour.
- `yarn lint` (repo-wide) and `typecheck` on all three touched packages — clean.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## What a reviewer should probe

- **The frozen shared object.** `Object.freeze` was kept because nothing in Optimystic writes to
  `options.clusterPolicy` — every reference in `db-p2p/src/libp2p-node-base.ts` is a read
  (`options.clusterPolicy?.allowDownsize ?? true`, etc.), and three live integration scenarios
  constructed real nodes from the frozen object without throwing. If a future Optimystic revision
  starts mutating it, the failure is a `TypeError` at node construction under ESM strict mode, not
  a silent misconfiguration — and the fix is to hand each caller a spread copy, keeping the shared
  constant.
- **Strand networks were deliberately left alone.** `strand-instance-manager.ts:271` and
  `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts:93` pass a structurally identical
  literal for `strand-*` networks. That shape match is a coincidence, not shared meaning; sweeping
  them into `CONTROL_CLUSTER_POLICY` would be wrong. Worth confirming the reviewer agrees the two
  concerns are genuinely separate rather than an artificial split.
- **The identity assertion in the config-layer test.** `expect(options.clusterPolicy).toBe(
  CONTROL_CLUSTER_POLICY)` sits next to an existing "object freshness" test that asserts
  `buildControlNodeOptions` returns a *fresh options object* each call. These are not in tension
  (fresh wrapper, shared policy), but the pairing is worth an eye.
- **Whether the runtime guard belongs where it is.** It went in
  `src/scenarios/basic-connectivity.integration.ts` rather than
  `packages/integration-tests/test/*.spec.ts`, because per `vitest.config.ts` that directory holds
  unit specs about the suite's own wiring and does no network setup. The cost is that a wiring
  assertion now pays for a real libp2p party (~740ms).
- **Not run:** the rest of the integration suite beyond the three harness-based scenarios named in
  the plan, and the `networked.e2e` strand tests. Nothing in the diff touches strand node creation,
  but that is reasoning, not measurement.
