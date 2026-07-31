description: The database layer built a second, unconfigured copy of the peer-discovery component, so writes forgot which network they were on and how many machines to replicate to. The fix is written and unit-proven, but it makes one three-node integration scenario fail reproducibly — a failing debug run has now pinpointed the failure to a signature-verification error on a replicated peer record, which must be root-caused and resolved before hand-off to review.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: hard
----

# Transactor key network must be the node's own key network — regression root-cause narrowed, resume here

Two prior agent runs. Run 1 completed the fix (Phase 1) and most validation; run 2
captured a **failing run of the regression WITH debug logging** and pinpointed the actual
failure mechanism before hitting its token budget. **Current state: the fix is in place
and built (verified in dist), five of six control-write suites are green, and the
three-node isolation failure is now known to be a SIGNATURE-VERIFICATION failure on a
replicated `CadrePeer` row — not a replication failure.** Resume at "The regression —
narrowed" below.

## Background (confirmed cause — unchanged)

A "key network" answers *which peers should this key's data live on* (`findCluster`) and
*which peer coordinates this write* (`findCoordinator`). `createLibp2pNode` builds one per
node with every configured argument — cluster size, network mode, persistence, reputation,
and the protocol prefix that scopes discovery to peers serving this network — and attaches
it as `node.keyNetwork` (`../optimystic/packages/db-p2p/src/libp2p-node-base.ts`). The
Quereus collection factory ignored it and built a second one from defaults
(`new Libp2pKeyPeerNetwork(libp2pNode)`), so every database write ran with a 16-wide
cohort and network scoping disabled. Reproduced by
`../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`.

## What is DONE (verified across both runs — do not redo)

Phase 1 complete:

- **Fix in place and in dist**: `resolveKeyNetwork` in `collection-factory.ts` prefers
  `node.keyNetwork`; the no-attached-key-network fallback keeps the protocol prefix
  (rationale documented in the code comment there). Verified in run 2 that the built
  chunk (`../optimystic/packages/quereus-plugin-optimystic/dist/chunk-QHJJETV4.js`,
  around line 246) contains the attached-keyNetwork branch. The `../optimystic` tree also
  carries unrelated in-flight edits from its own runner (db-core network-transactor/
  coordinator, db-p2p repo files) — **touch only the two owned files**
  (`collection-factory.ts` + its spec); if a fix must land elsewhere in optimystic, file
  a ticket into `../optimystic/tickets/` instead.
- **Package validated** (run 1): optimystic plugin `yarn typecheck` exit 0; its mocha
  suite green (328 passing, 11 pending); `yarn build` succeeded.
- **Config facts confirmed in run 2** (save re-derivation): the control network's
  clusterSize is `CONTROL_REPLICATION_BREADTH` = 16 — the SAME as the pre-fix default —
  so the regression delta is NOT cohort width. The delta is: (a) network scoping now on
  (protocolPrefix `/optimystic/control-<partyId>`), (b) the transactor now SHARES the
  node's own key-network instance (shared coordinator cache, network high-water mark,
  reputation, networkMode). Also: all four db protocols (cluster/repo/sync/
  block-transfer) are registered unconditionally by `createLibp2pNodeBase` regardless of
  Cadre profile, so even a transaction-profile node advertises them after identify.
- `cluster-size.ts` overfetch tripwire re-confirmed correct; no edit needed.
- Sereus injection paths confirmed (`cadre-core/src/control-database.ts` +
  `quereus-plugin-sereus/src/compose-strand.ts` both register `createLibp2pNode`-built
  nodes, so both hit the attached-keyNetwork branch).
- Sibling stale-dist rebuilds were needed mid-run in run 1 (`@serfab/cadre-host`,
  `@quereus/quereus`); expect recurrence — the integration-tests stale-build guard names
  the remedy.

Phase 2, partially complete — suites run from `packages/integration-tests` via
`yarn vitest run src/scenarios/<file>`:

- `control-db-two-node-convergence`, `control-cohort-auto-convergence`,
  `control-cohort-cold-start-retry`, `control-write-degraded-cohort-member` (4/4),
  `control-write-while-alone-convergence` — all green (run 1).
- `control-cohort-three-node-isolation` — fails with the fix, passes without. A/B tested
  in run 1 by rebuilding the one file from git HEAD then restoring; the working tree and
  dist hold the FIXED version now.

## The regression — NARROWED (this is the work now)

**New decisive evidence (run 2).** A failing run was captured WITH debug logging — so
the failure is not debug-masked. Repro (from `packages/integration-tests`, ~80s
wall-clock, failed 4 of 5 valid runs so far across both agent runs):

```
DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node,sereus:integration:wait' \
OPTIMYSTIC_VERBOSE=1 yarn vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

In that run, test 1 ("B automatically dials C…") failed at the step-6 wait
("B resolves C's signed CadrePeer address record", 45s timeout); test 2 passed the same
run (18.8s). Peer ids that run: A=`12D3KooWRGJR…`, B=`12D3KooWRrC7…`, C=`12D3KooWHf2o…`.

**The smoking gun:** throughout the 45-second step-6 window, this line repeated at
exactly the step-6 poll cadence (~250ms):

```
sereus:cadre:node resolvePeerAddrs: signature verification failed for 12D3KooWHf2o…   (= C)
```

So **C's row DID replicate to B** — a record for C is present and readable on B — but
B's signature verification of it FAILS, so `resolvePeerAddrs` returns empty and both the
test gate and B's own `reconcileControlCohort` (which logs "no dialable control address
for sibling <C>; skipping") treat C as unreachable. Run 1's hypotheses (row never
replicated; cohort scoping starving B of pushes; foreign-classification drops) are
superseded — replication happens; the replicated row's signature does not verify on B.
Context: the first such line appears the moment C's `registerSelf` lands, and C refreshed
its record TWICE in quick succession right before the window (`updatedAt=…766843` with
1 addr, then `…767112`) — a real window for revision mixing.

**Next steps, in order:**

- Read the signature-verification path in `packages/cadre-core/src/cadre-node.ts`
  (`resolvePeerAddrs`; the reconcile/dial call sites sit around lines 1674-1830) and the
  row-signing side (`registerSelf` / `updateSelfPeerRecord`): exactly which fields the
  signature covers (addrs, updatedAt, publicKey…).
- Determine WHAT row content B actually holds vs what C signed. Leading hypotheses:
  - **Torn / mixed-revision read**: B's tree read assembles the row from blocks at
    different revisions (one block served fresh from A, another from B's stale local
    replica), pairing one revision's fields with another revision's `Sig`. The fix's
    instance-sharing/scoping changes which peers serve which block reads, which could
    surface such a mix; C's back-to-back double refresh makes the window real.
  - **Stale intermediate revision with mismatched sig** reaching B via a replication
    path (spread-on-churn / reconcile-block / read-repair) that moves per-block state
    without row-level atomicity.
  - Least likely: interaction with the foreign in-flight optimystic edits in db-core's
    network-transactor/coordinator (in the dist for both the failing and passing A/B
    runs, but they touch the read/coordination path now implicated).
- The same verification-failure line also appears transiently in PASSING tests (test 2
  healed within seconds), so the defect is likely a transient inconsistency that the fix
  makes PERSISTENT on B specifically — B is the addressless, pull-only node. Find why it
  never heals there.
- Log attribution caveat: all three nodes share one process and the db-p2p log lines
  carry no self id. `OPTIMYSTIC_VERBOSE=1` makes `findCluster:detail` print full cohort
  peer-id lists (self included) for attribution. Run 2's log lived in a session
  scratchpad that is gone — re-capture is ~80s.
- Useful next instrumentation: on verification failure, log the exact row fields + sig B
  read for C and compare against C's two written revisions. Check whether
  `DEBUG='sereus:cadre:*'` already carries enough before adding anything.

Possible outcomes, all acceptable if argued and evidenced: a Sereus-side defect in how
the row is signed/verified across rapid successive revisions (fix in cadre-core); a
torn-read / replication-atomicity defect in optimystic's read path (file a ticket into
`../optimystic/tickets/` — do not edit beyond the two owned files); or a test-side race
the fix merely exposes (then argue why the pre-fix pass was the accident, and fix the
scenario).

## Remaining TODO (after the regression is resolved — unchanged from run 1)

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
  regression existed, its signature-verification root cause, and how it was resolved.

## Out of scope (unchanged)

The collection factory's own `createLibp2pNode` path still hardcodes `clusterSize: 1`.
Not used by Sereus (every Sereus node is injected). Leave it.
