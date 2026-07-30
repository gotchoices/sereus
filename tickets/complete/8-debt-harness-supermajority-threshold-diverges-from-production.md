description: The integration tests used to let a write succeed with fewer machines approving it than a real deployment requires; they now use the real rule, and the setting lives in one shared place so the two cannot drift apart again.
prereq:
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/basic-connectivity.integration.ts, docs/architecture.md
difficulty: medium
----

# Complete: harness and production run the same control-write approval rule

## What shipped

A write to the control database (party membership, strand list, owner keys) commits only once a
**super-majority** of the peers in that block's cohort approves it. The fraction is
`clusterPolicy.superMajorityThreshold`; Optimystic's bar is `Math.ceil(peerCount × threshold)`.
Production omitted the key and so inherited Optimystic's default of **0.75**; the integration
harness passed **0.51**. Both call sites now pass one shared frozen constant that names no
threshold at all.

**New constant** — `CONTROL_CLUSTER_POLICY` in
`packages/quereus-plugin-sereus/src/cluster-size.ts`, beside `CONTROL_REPLICATION_BREADTH`:

```ts
export const CONTROL_CLUSTER_POLICY = Object.freeze({
	allowDownsize: true,
	sizeTolerance: 0.5,
} satisfies NonNullable<NodeOptions['clusterPolicy']>);
```

Its docblock states that `superMajorityThreshold` is deliberately absent (absence is what selects
0.75, for both the cluster member and the coordinator), and that strand networks are out of its
scope. Exported through `packages/quereus-plugin-sereus/src/index.ts` and re-exported from
`packages/cadre-core/src/types.ts`.

**Consumers**

- `packages/cadre-core/src/cadre-node.ts:948` — the inline `{ allowDownsize: true, sizeTolerance:
  0.5 }` literal replaced with `CONTROL_CLUSTER_POLICY`. Behaviourally identical.
- `packages/integration-tests/src/harness/test-party.ts` — the whole `clusterPolicy` literal,
  `superMajorityThreshold: 0.51` included, replaced with the same constant.

**Guards**

- `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` — asserts
  `options.clusterPolicy?.superMajorityThreshold` is `undefined` *and* that
  `options.clusterPolicy` is the shared `CONTROL_CLUSTER_POLICY` object by identity. The identity
  assertion is what catches "someone spreads a copy and adds a key".
- `packages/integration-tests/src/scenarios/basic-connectivity.integration.ts` — reads the
  threshold a **live** harness node resolved (`coordinatedRepo.effectiveSuperMajorityThreshold`)
  and asserts it equals `DEFAULT_SUPER_MAJORITY_THRESHOLD` from `@optimystic/db-core`. Runs after
  `createLibp2pNode` has threaded `clusterPolicy` through, which the config-layer test cannot see.
- The `satisfies` on the constant — added during review; see findings below.

**Docs** — `docs/architecture.md` → "Replication cluster size" names `CONTROL_CLUSTER_POLICY`, why
the threshold is set by omission, and why it is shared rather than copied.

## The honest scope limit

Behaviour-neutral today, and verified so. Every harness control cohort is size 1, where the
coordinator's `peerCount > 1 && approvalCount < superMajority` guard never fires. A green suite is
therefore **not** evidence that multi-peer approval is covered — it is not.
`backlog/debt-harness-control-cohort-never-multi-peer` tracks that larger gap and was explicitly
out of scope. What this bought is that *when* harness cohorts do become multi-peer they will be
measured against the production bar without anyone remembering to change a number.

The runtime guard has the same shape of limit: it asserts the node *resolved* 0.75, not that a
3-peer cohort *behaved* like 0.75. It is a wiring assertion, which is all a self-only-cohort
harness can offer.

## Review findings

### Checked

Read the implement diff (`1401208`) before the handoff summary. Scrutinised the constant's typing,
freezing, and export path; both new tests; the comment blocks at all three touched call sites; the
docs bullet; every other `createLibp2pNode` call site in the repo; and whether any doc or ticket
still asserted the old 0.51 divergence as current fact. Verified against Optimystic source
(`../optimystic/packages/db-p2p`) rather than trusting the handoff's claims about it.

### Fixed in this pass (minor)

- **The shared constant was structurally unchecked.** `Object.freeze({ … })` with no target type
  meant a mistyped or obsolete key would compile at the definition *and* at every consumer —
  TypeScript only excess-property-checks fresh object literals, never a shared constant handed to
  an optional property. For a constant whose entire purpose is "the thing consumers cannot get
  wrong", that is the wrong default. Added `satisfies NonNullable<NodeOptions['clusterPolicy']>`
  inside the freeze (type-only import; erased at build) and *proved* it bites: injecting
  `sizeTolerence: 0.5` produced `TS2561 … Did you mean to write 'sizeTolerance'?`, then reverted.
- **Double cast in the new integration test.** `coordinatedRepo as unknown as CoordinatorRepo`
  narrowed to `as CoordinatorRepo` — the `unknown` hop was unnecessary (the declared type is
  `IRepo`, which `CoordinatorRepo` implements) and it disabled the one check that would catch the
  target type going away. Typechecks clean.
- **Overclaiming comment on that test.** It said the assertion covers "both the coordinator and
  the cluster member" while reading only the coordinator. It does cover both, but transitively:
  `createLibp2pNode` calls `assertSuperMajorityCoupling` at construction and throws if the two
  resolve differently. Comment now states that reason instead of asserting the conclusion.
- **Comment restating a docblock.** The 10-line block above `clusterPolicy:` in `test-party.ts`
  re-told the constant's own docblock (why shared, the 0.51 history) before reaching the one thing
  that only lives there — the cohort-size caveat. Trimmed to a pointer plus the caveat.

### Factual correction to the handoff (no code impact)

The handoff claimed `ceil(n × 0.75)` and `ceil(n × 0.51)` "only differ at odd cohort sizes ≥ 3".
That is wrong, and wrong in the direction that *understates* the old divergence: they differ at
n = 3, 5, 6, 7, 8 … — every cohort size ≥ 3 except n = 4. The conclusion the handoff drew from it
(no behaviour change here, because harness cohorts are size 1) is unaffected and independently
confirmed by the runs below. Recorded so the record is not carried forward wrong.

### Verification gap in the handoff, now closed

The implementer ran three harness scenarios and explicitly flagged the rest as not run. For a
change to a *commit approval threshold*, the scenarios that actually exercise control-DB commit
and convergence are the ones that matter most, and none of them had been run. Ran them: all pass.
Also ran the strand e2e suite the handoff listed as unrun. Full command list below.

### Recorded as tripwires, not tickets

- **Strand cluster policy is still hand-copied.** `strand-instance-manager.ts` and
  `quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts:93` each carry their own
  `{ allowDownsize: true, sizeTolerance: 0.5 }` for strand networks — the same duplication class
  this ticket just removed for the control network. They agree today and neither names a
  consensus threshold, so there is nothing wrong now; hoisting a second constant purely on
  symmetry would be churn, and the implementer's call to keep strand and control policy separate
  is correct (different networks, different reasoning). Parked as a `NOTE:` at the
  `strand-instance-manager.ts` call site saying: if either grows a `superMajorityThreshold` or
  any other consensus knob, hoist a shared `STRAND_CLUSTER_POLICY` rather than editing both.
- **Frozen shared object.** `Object.freeze` is safe because every `options.clusterPolicy`
  reference in `db-p2p/src/libp2p-node-base.ts` is a read, and real nodes constructed from it
  across nine integration scenarios without throwing. If a future Optimystic revision mutates it
  the failure is a loud `TypeError` at construction, not a silent misconfiguration. Already
  reasoned about in the constant's docblock; no new note needed.

### Filed as new tickets

None. Nothing found rose to major: the implementation is correct, the divergence is genuinely
closed, and the one real scope limit (self-only cohorts) already has a backlog ticket.

### Checked and found clean

- **Other node-creation sites.** `cadre-node.ts` is the only control-network `createLibp2pNode`
  caller in the repo; `cadre-cli`, `cadre-host`, `cadre-provider` and the reference apps all go
  through `CadreNode`. `connect.ts` / `connect-browser.ts` create strand nodes and pass no
  `clusterPolicy` at all, which resolves to the same `allowDownsize`/`sizeTolerance` defaults —
  no divergence hiding there.
- **Stale references to the old 0.51 harness.** `tickets/backlog/debt-control-write-unanimity-at-
  three-nodes.md` already reads "Now aligned"; nothing in `docs/` or in code still describes the
  harness as running a looser threshold.
- **Docs.** `docs/architecture.md`'s new bullet is accurate against Optimystic source: the single
  resolved `consensusConfig` at `libp2p-node-base.ts:718` does feed both coordinator and cluster
  member. `docs/cadre-consistency.md` covers replication breadth only and needed no change.

## Verification performed

All from a clean tree, after rebuilding the stale linked `@quereus/quereus` workspace the
integration suite's build-freshness guard flagged (external reference workspace, not this repo).

- `yarn workspace @serfab/quereus-plugin-sereus build`, then `yarn workspace @serfab/cadre-core
  build` (order matters — cadre-core imports the plugin, never the reverse).
- `typecheck` on `quereus-plugin-sereus`, `cadre-core`, `integration-tests` — all clean.
- `yarn lint` (repo-wide) — clean.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 7 files, 68 passed, 1 todo.
- `yarn workspace @serfab/quereus-plugin-sereus test:e2e` — 3 files, 15 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test` — 76 files, 1199 passed, 1 skipped.
- From `packages/integration-tests`, control-path scenarios (none previously run):
  `control-cohort-auto-convergence`, `control-cohort-cold-start-retry`,
  `control-db-two-node-convergence`, `control-write-while-alone-convergence` — 4 files, 5 passed.
- From `packages/integration-tests`: `control-cohort-three-node-isolation`, `basic-connectivity`,
  `happy-path`, `multi-party-sync` — 4 files, 14 passed, including the new threshold test.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

**Still not run:** the `cadre-host-*`, enrollment, seed, push-wake, websocket-chat and
convergence-stress integration scenarios. The suite is sequential with 60-second timeouts and the
full run exceeds the agent idle budget. Nothing in the diff reaches those paths, but that is
reasoning rather than measurement.
