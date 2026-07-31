description: The database layer built a second, unconfigured copy of the peer-discovery component, so writes forgot which network they were on and how many machines to replicate to. The fix is written and unit-proven, but it makes one three-node integration scenario fail reproducibly — that regression must be diagnosed and resolved before this can hand off to review.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: hard
----

# Transactor key network must be the node's own key network — REGRESSION FOUND, resume here

A prior agent run completed Phase 1 and most of Phase 2 validation, then hit its token
budget. **Current state: the fix is in place and built, five of six control-write
integration suites are green, but `control-cohort-three-node-isolation` fails
reproducibly with the fix and passes without it.** The remaining work is to diagnose and
resolve that regression, then finish the deferred validation and documentation below.

## Background (confirmed cause — unchanged from the original ticket)

A "key network" answers *which peers should this key's data live on* (`findCluster`) and
*which peer coordinates this write* (`findCoordinator`). `createLibp2pNode` builds one per
node with every configured argument — cluster size, network mode, persistence, reputation,
and the protocol prefix that scopes discovery to peers serving this network — and attaches
it as `node.keyNetwork` (`../optimystic/packages/db-p2p/src/libp2p-node-base.ts`). The
Quereus collection factory ignored it and built a second one from defaults
(`new Libp2pKeyPeerNetwork(libp2pNode)`), so every database write ran with a 16-wide
cohort and network scoping disabled. Reproduced by
`../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`.

## What is DONE (verified this run — do not redo)

Phase 1 complete:

- **Diff re-read cold**: the uncommitted `../optimystic` change is exactly the two
  described edits in `collection-factory.ts` (`resolveKeyNetwork` prefers
  `node.keyNetwork`; `protocolPrefix` computed one line earlier and passed in) plus the
  new spec. **That tree also carries unrelated in-flight edits from its own runner
  (db-core network-transactor/coordinator, db-p2p repo files) — touch only these two
  files.** Those foreign edits are already built into the db-core/db-p2p dists (dist
  mtimes newer than src — verified), so they are in every test run's runtime either way.
- **Fallback decision made and documented in the code**: the no-attached-key-network
  fallback KEEPS the protocol prefix. Rationale (now in the comment in
  `resolveKeyNetwork`): the same prefix string is what `getRepo` hands every
  `RepoClient.create` dial the transactor makes, so a peer excluded by scoping could
  never have negotiated the transactor's repo protocol anyway — scoping only removes
  guaranteed-failure candidates.
- **Package validated and built**: `yarn typecheck` exit 0;
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --exit`
  green — 328 passing, 11 pending, 0 failing; `yarn build` succeeded. The dist Sereus
  links against currently CONTAINS THE FIX.
- **`cluster-size.ts` tripwire confirmed**: the overfetch note on
  `CONTROL_REPLICATION_BREADTH` still reads correctly; numbers unchanged
  (`max(16*4, 16+16)` = 64). No edit needed.
- **Sereus injection paths confirmed**: both `cadre-core/src/control-database.ts` and
  `quereus-plugin-sereus/src/compose-strand.ts` register nodes built by
  `createLibp2pNode`, so both hit the attached-`keyNetwork` branch.
- **Sibling rebuilds done** (stale-build guard): `@serfab/cadre-host` and
  `@quereus/quereus` were rebuilt after their runners' edits made dists stale. Expect
  this to recur mid-run; the guard names the exact remedy.

Phase 2, partially complete — suites run from `packages/integration-tests` via
`yarn vitest run src/scenarios/<file>`:

- `control-db-two-node-convergence` — green.
- `control-cohort-auto-convergence` — green.
- `control-cohort-cold-start-retry` — green.
- `control-write-degraded-cohort-member` — green (4/4, including the named
  super-majority error cases).
- `control-write-while-alone-convergence` — green.
- `control-cohort-three-node-isolation` — **FAILS with the fix, passes without it.**

## The regression (the actual work now)

Symptom: both tests in `control-cohort-three-node-isolation.integration.ts` time out in
`bootTrio` at the step-6 wait — `B.resolvePeerAddrs(cPeerId)` never returns an address
within 45s ("B resolves C's signed CadrePeer address record"). The file's own NOTE at
that wait says a recurrence means C's row never replicated A→B and is a product bug.

Evidence it is caused by this fix (A/B tested):

- With fix built: failed 3 of 4 valid runs (first batch run: 1 of 2 tests; solo re-run:
  1 of 2; a later solo run: 2 of 2). The one pass was with `DEBUG` logging enabled,
  which slows everything — and even that pass took 18.8s for the load-bearing test.
- With pre-fix `collection-factory.ts` (rebuilt from git HEAD of that one file, then
  restored — the working tree holds the FIXED version again): green first try, 23.6s
  total, load-bearing test 9.6s.
- The A/B isolates the collection-factory change specifically: the foreign db-core/db-p2p
  in-flight edits were in the dist in BOTH runs.

Debug-run classification histogram (namespace
`optimystic:db-p2p:libp2p-key-network`, `findCluster:membership` lines, from the one
passing debug run — capture a FAILING run's log to go further):

```
387x  serves=0 unknown=0 foreignDropped=0 kept=1   (self-only cohort — cold FRET)
111x  serves=1 unknown=0 foreignDropped=0 kept=2
 22x  serves=2 unknown=0 foreignDropped=0 kept=3
 14x  serves=0 unknown=0 foreignDropped=1 kept=1   (a peer classified FOREIGN, dropped)
```

Open hypotheses, in rough priority order:

- The `foreignDropped=1 kept=1` lines are suspicious: this scenario runs a single
  (control) network, so NO peer should ever classify `foreign`. If a same-network peer's
  peerStore record can carry protocols that fail the prefix match (e.g. recorded before
  namespaced identify completed, or a prefix-string mismatch between what the node
  advertises and what the key network filters on), scoping silently drops legitimate
  members. Find which peer/protocols those 14 drops saw.
- Topology sensitivity: in this scenario B listens on NOTHING (outbound-only) and B↔C
  never connect before the link forms. Under scoping, C classifies B as `unknown`
  (no identify ever) and excludes it from every write cohort, so C's `registerSelf`
  updates stop being pushed to B; B can only converge by pulling from A. Work out why
  B's pull (reconcile at 2s cadence in test 1) still does not converge — that is the
  unexplained part; B's own cohort for the read should be {A, self} with A `serves`.
- The write path on A may also narrow (step 4 `authorizePeer` write) — check whether
  C's row lands on B at all (the file's NOTE says diagnose with
  `DEBUG='sereus:cadre:node'` and check whether C's row reached B).

Possible outcomes, all acceptable if argued and evidenced: a genuine defect in the
scoped-path classification (fix belongs in
`../optimystic/packages/db-p2p/src/libp2p-key-network.ts`, which is the optimystic
runner's territory — if the fix cannot live in the two owned files, file a ticket into
`../optimystic/tickets/` rather than editing); a Sereus-side consequence to absorb
(e.g. push-replication to an addressless, never-identified peer no longer happens and
the pull path must carry it); or — least likely given the A/B — an interaction with the
foreign in-flight optimystic edits.

## Remaining TODO (after the regression is resolved)

- Re-run all six control suites green, plus `happy-path`.
- Strand cohort-width coverage: a strand network configured at
  `DEFAULT_STRAND_CLUSTER_SIZE` (2) should assemble a 2-wide cohort, not 16. The
  unit-level shape exists in the new optimystic spec; the prior run leaned toward a
  Sereus-level assertion against a real strand node as the honest one but implemented
  neither. Pick one and state which in the handoff.
- Check `cadre-core` / `quereus-plugin-sereus` unit suites for anything constructing the
  transactor path against a node without `keyNetwork` (not yet run).
- `NO_NETWORK_COORDINATOR`: a repo-wide grep found no Sereus code matching Optimystic
  coordinator error codes beyond `forced-cluster.ts` and the degraded-cohort scenario
  (both green) — finish the check by confirming nothing pattern-matches on the older
  codes in a way the new code breaks.
- Rewrite the `forced-cluster.ts` header: it documents the two-instances-per-node
  situation at length; after the fix there is ONE instance per node, and the prototype
  patch survives because it is simpler than reaching each node's instance (cold FRET
  still justifies the patch itself).
- `docs/architecture.md` → "Replication cluster size": state that the transactor and the
  node's own consensus path now share one key network — one cluster size, one network
  scope. Update in place.
- Handoff to `review/` with an honest account: the reviewer must know the three-node
  regression existed and how it was resolved.

## Out of scope (unchanged)

The collection factory's own `createLibp2pNode` path still hardcodes `clusterSize: 1`.
Not used by Sereus (every Sereus node is injected). Leave it.
