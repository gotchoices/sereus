----
description: The database layer built a second, unconfigured copy of the peer-discovery component, so writes forgot which network they were on and how many machines to replicate to. That fix is written and unit-proven, but it exposed a latent bug in the sibling optimystic repo — a node that starts before connecting to anyone elects itself as data coordinator and remembers that for 30 minutes, serving stale reads — which makes one three-node integration scenario fail. Blocked until the optimystic fix lands.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: medium
----

# Transactor key network must be the node's own key network — REGRESSION ROOT-CAUSED, blocked on an optimystic fix

**Why this is in blocked/:** the three-node regression is fully root-caused (evidence
below) and the defect lives in `../optimystic/packages/db-p2p/src/libp2p-key-network.ts`
— outside the two optimystic files this ticket owns. The fix is filed as
`../optimystic/tickets/fix/coordinator-cache-poisoned-by-boot-time-self-selection.md`.
**Unblock condition:** that optimystic ticket lands and `../optimystic` is rebuilt
(its dist is what sereus consumes via workspace resolutions). Then move this ticket back
to `implement/` and run the "Remaining work after unblock" checklist below — the
remaining work is validation + docs, no new design.

Three prior agent runs. Run 1 completed the Sereus-side fix and most validation. Run 2
narrowed the three-node failure to a signature-verification symptom. **Run 3 (this one)
root-caused it with decisive log evidence — it is NOT a crypto or replication-atomicity
defect; it is a coordinator-cache poisoning bug in optimystic's `Libp2pKeyPeerNetwork`.**

## Background (confirmed cause of the original bug — unchanged)

A "key network" answers *which peers should this key's data live on* (`findCluster`) and
*which peer coordinates this write* (`findCoordinator`). `createLibp2pNode` builds one per
node with every configured argument — cluster size, network mode, persistence, reputation,
and the protocol prefix that scopes discovery to peers serving this network — and attaches
it as `node.keyNetwork` (`../optimystic/packages/db-p2p/src/libp2p-node-base.ts`). The
Quereus collection factory ignored it and built a second one from defaults
(`new Libp2pKeyPeerNetwork(libp2pNode)`), so every database write ran with a 16-wide
cohort and network scoping disabled. Reproduced by
`../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`.

## What is DONE (verified across runs — do not redo)

- **Fix in place and in dist**: `resolveKeyNetwork` in `collection-factory.ts` prefers
  `node.keyNetwork`; the no-attached-key-network fallback keeps the protocol prefix
  (rationale in the code comment there). The `../optimystic` tree carries unrelated
  in-flight edits from its own runner — **touch only the two owned files** there.
- **Package validated** (run 1): optimystic plugin `yarn typecheck` exit 0; mocha suite
  green (328 passing, 11 pending); `yarn build` succeeded.
- Five of six control-write suites green (run 1): `control-db-two-node-convergence`,
  `control-cohort-auto-convergence`, `control-cohort-cold-start-retry`,
  `control-write-degraded-cohort-member`, `control-write-while-alone-convergence`.
- `cluster-size.ts` overfetch tripwire re-confirmed correct; no edit needed.
- Sereus injection paths confirmed (`cadre-core/src/control-database.ts` +
  `quereus-plugin-sereus/src/compose-strand.ts` both register `createLibp2pNode`-built
  nodes, so both hit the attached-keyNetwork branch).
- **Run 3: permanent debug instrumentation added to
  `packages/cadre-core/src/cadre-node.ts`** (uncommitted working-tree edits, build
  verified in `dist/`): the `resolvePeerAddrs` signature-verification failure log now
  includes the row's `updatedAt`, `addrs`, and a `sig` prefix; both `registerSelf`
  success logs now include a `sig` prefix. Keep these — they are what made the root
  cause visible, debug-gated and cheap.
- Sibling stale-dist rebuilds were needed mid-run in run 1 (`@serfab/cadre-host`,
  `@quereus/quereus`); expect recurrence — the integration-tests stale-build guard names
  the remedy.

## The regression — ROOT-CAUSED (run 3 evidence)

Failing suite: `control-cohort-three-node-isolation` (from `packages/integration-tests`,
`yarn vitest run src/scenarios/<file>`, ~80s, fails ~4 of 5 runs). Topology: A
(storage+owner, dialable), B (client-only, `listenAddrs: []`, dials A outbound), C
(dialable, vouched by A). Failure point: step-6 wait "B resolves C's signed CadrePeer
address record" (45s timeout).

**Mechanism, proven by a captured failing run with the new instrumentation:**

1. B boots and, before its dial to A completes, performs early control-database reads.
   `findCoordinator`'s FRET tier always keeps SELF as a candidate (`id === self` bypasses
   the connected-peer filter), so with zero connections B picks **itself** as coordinator
   for the `CadrePeer` collection-tree key (log: `source=fret`, candidates = only B,
   `connected=[]`) — bypassing the `shouldAllowSelfCoordination` guard, which only
   protects the last-resort tier. `recordCoordinator` caches the pick for **30 minutes**.
   Captured timing: self-pick at `11:10:44.138`, B↔A connection up at `11:10:44.462` —
   a ~300ms race, which is exactly the observed ~4-of-5 flakiness.
2. Every subsequent B read of that key hits `source=cache` → self → served from B's own
   local replica. B's replica holds only the owner-vouch revision of C's row
   (`updatedAt=<vouch time>, addrs=[], sig=(empty)` — the instrumented log printed it),
   because C's later self-signed refresh committed on cohort {A, C} only — B is
   addressless, so writers exclude it (dial fails, cluster downsizes) and nothing pushes
   to B. B's ONLY path to the fresh revision is reading from A — blocked by the poisoned
   cache entry.
3. `resolvePeerAddrs` on B therefore fails signature verification forever (empty sig =
   the vouch revision, not a bad signature), the test gate and B's
   `reconcileControlCohort` both see C as unresolvable, timeout.

A control observation from the same run: a second key read moments AFTER the connection
was up cached A correctly and those reads were fine — confirming the boot race is the
whole story (not network scoping, not FRET membership, not torn reads, not the foreign
in-flight optimystic edits — run 2's remaining hypotheses are all dead).

**Why the Sereus fix exposed it:** pre-fix, the transactor's second (unconfigured)
instance had its own empty coordinator cache, created/used on a different schedule, so it
usually raced past the vulnerable window; post-fix the transactor SHARES the node's own
key-network instance, so cadre-core's early boot-time reads poison the very cache the
transactor then uses for all SQL reads. The sharing is correct (that was the point of the
fix); the cache behavior is the defect.

Repro/diagnosis command (from `packages/integration-tests`):

```
DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node,sereus:integration:wait' \
OPTIMYSTIC_VERBOSE=1 yarn vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

Look for `findCoordinator:done … source=fret` with `connected=[]` on B during boot, then
`source=cache` on the same key during the step-6 window, and the instrumented
`signature verification failed … addrs=[], sig=(empty)` line.

## Remaining work after unblock (move back to implement/, then:)

- Confirm the optimystic fix landed and rebuild `../optimystic` (at minimum db-p2p and
  the quereus-plugin-optimystic dist chain), then re-run the three-node suite ~3 times —
  it was flaky-failing, so one green run is weak evidence.
- Re-run all six control suites green, plus `happy-path`.
- Strand cohort-width coverage: a strand network configured at
  `DEFAULT_STRAND_CLUSTER_SIZE` (2) should assemble a 2-wide cohort, not 16. The
  unit-level shape exists in the new optimystic spec; run 1 leaned toward a Sereus-level
  assertion against a real strand node as the honest one but implemented neither. Pick
  one and state which in the handoff.
- Check `cadre-core` / `quereus-plugin-sereus` unit suites for anything constructing the
  transactor path against a node without `keyNetwork` (not yet run).
- `NO_NETWORK_COORDINATOR`: repo-wide grep found no Sereus code matching Optimystic
  coordinator error codes beyond `forced-cluster.ts` and the degraded-cohort scenario
  (both green) — finish by confirming nothing pattern-matches on the older codes in a
  way the new code breaks.
- Rewrite the `forced-cluster.ts` header: it documents the two-instances-per-node
  situation at length; after the fix there is ONE instance per node, and the prototype
  patch survives because it is simpler than reaching each node's instance (cold FRET
  still justifies the patch itself).
- `docs/architecture.md` → "Replication cluster size": state that the transactor and the
  node's own consensus path now share one key network — one cluster size, one network
  scope. Update in place.
- Handoff to `review/` with an honest account: the reviewer must know the three-node
  regression existed, its coordinator-cache root cause (this section), that the fix
  landed in optimystic (name the ticket), and that the shared-instance change is what
  surfaced it.

## Out of scope (unchanged)

The collection factory's own `createLibp2pNode` path still hardcodes `clusterSize: 1`.
Not used by Sereus (every Sereus node is injected). Leave it.
