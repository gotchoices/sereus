description: The database layer built a second, unconfigured copy of the peer-discovery component, so writes forgot which network they were on and how many machines to replicate to. A fix is written and proven against a new test; it still needs to be checked against the real multi-node test suites.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: hard
----

# Transactor key network must be the node's own key network

## Confirmed cause

A "key network" is the component that answers *which peers should this key's data live on*
(`findCluster`) and *which peer coordinates this write* (`findCoordinator`).

`createLibp2pNode` builds one per node with every configured argument — cluster size, network
mode, persistence, reputation, and the protocol prefix that scopes discovery to peers actually
serving this network — and attaches it as `node.keyNetwork`
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:695,1301`).

The Quereus collection factory ignored it and built a second one from defaults:
`new Libp2pKeyPeerNetwork(libp2pNode)`
(`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`,
`resolveKeyNetwork`). That second instance is what `NetworkTransactor` holds, so it decided the
peer set and coordinator for **every** database write.

Both consequences are reproduced, not inferred, by the new spec
`../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`
(mock libp2p node, mock FRET returning one foreign peer + three serving peers, node configured
with `clusterSize` 2 and prefix `/optimystic/mynet`). Before the fix:

- **No network scoping** — the foreign peer (advertising `/optimystic/othernet/repo/1.0.0`) was
  returned as a cohort member. It can never negotiate this network's repo dial, so it is a
  guaranteed lost promise against the super-majority.
- **Wrong cohort width** — cohort came back with 5 members instead of the configured 2, because
  the constructor defaults `clusterSize` to 16. Reputation, persistence and network mode
  (`joining` vs the default `forming`, which controls retry-futility) were dropped too.

Why the collection factory could not simply "pass its configured arguments through": it does not
have them. `LibP2PNodeOptions` (`quereus-plugin-optimystic/src/types.ts`) carries only `port`,
`networkName`, `bootstrapNodes` — no cluster size, no persistence, no reputation. For a node
injected via `registerLibp2pNode` (every Sereus path — `cadre-core/src/control-database.ts` and
`quereus-plugin-sereus/src/compose-strand.ts`) the factory never sees the node's configuration at
all. The node itself is the only source of truth, so reusing `node.keyNetwork` is the fix, not a
consolidation-for-its-own-sake refactor.

## What is already in the tree (uncommitted, `../optimystic`)

Sereus consumes Optimystic through `resolutions`, so both changes live uncommitted in the
`../optimystic` working tree — the same arrangement as `complete/bug-control-db-stale-revision-not-retryable`.
**That tree also has unrelated in-flight edits from its own runner; touch only these two files.**

1. `collection-factory.ts` — `resolveKeyNetwork` now takes the protocol prefix and returns
   `node.keyNetwork` when present; the `protocolPrefix` computation moved one line up so it can be
   passed in. Fallback (a node injected by a host that did not build it through
   `createLibp2pNode`, so it carries no key network) constructs `Libp2pKeyPeerNetwork` with the
   protocol prefix supplied — cluster size and reputation remain unknowable there.
2. `test/collection-factory-key-network.spec.ts` — new, the reproduction above.

Validation run so far: the two new cases fail before the change and pass after; the full
`quereus-plugin-optimystic` suite is green (328 passing, 11 pending, 0 failing) via
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --exit` from
`../optimystic/packages/quereus-plugin-optimystic`. `yarn typecheck` clean in that package.

## What is NOT yet verified — the actual work of this ticket

The fix changes production behaviour on the **control** network in a way the unit test cannot see.
Control writes were accidentally unaffected by the width bug (`CONTROL_REPLICATION_BREADTH` is 16,
which happens to equal the constructor default) but they *were* running unscoped. After the fix
they are scoped, which means:

- A cohort member whose libp2p `identify` has not completed classifies as `unknown` and is
  **excluded**, not gambled on (see the long comment in `findCluster`,
  `../optimystic/packages/db-p2p/src/libp2p-key-network.ts`). On a cold FRET table this can produce
  a narrower cohort than before, especially early in a party's life.
- Cohort selection now over-fetches: `membershipOverfetch()` asks FRET for
  `max(clusterSize * 4, clusterSize + 16)` candidates and does a peerStore protocol lookup per
  candidate — 64 for the control network, where the unscoped path previously asked for 16 and did
  no protocol lookups. The tripwire for this is already recorded on `CONTROL_REPLICATION_BREADTH`
  in `packages/quereus-plugin-sereus/src/cluster-size.ts`; confirm it still reads correctly and
  extend it if the numbers move.
- `findCoordinator` now skips `foreign` and `unknown` peers and can raise
  `NO_NETWORK_COORDINATOR`. Sereus error paths that match on Optimystic coordinator failures should
  be checked for that code.

The strand-side consequence (cohort width 16 against a configured `DEFAULT_STRAND_CLUSTER_SIZE` of
2) is the one with a real behavioural delta and no coverage at all today.

## TODO

Phase 1 — land and prove the upstream change

- Re-read the two uncommitted `../optimystic` files cold and confirm the diff is exactly the two
  changes described above and nothing else.
- Decide and document whether the fallback branch should pass the protocol prefix at all. It is a
  behaviour change for any embedder injecting a foreign node, and the `protocolPrefix` parameter's
  own doc comment says it is left optional precisely because most call sites don't know the network
  name. This call site does. Either keep it and say why in the code comment, or drop it and say why.
- Build `@optimystic/quereus-plugin-optimystic` (`yarn build` in that package) so Sereus picks the
  change up through `resolutions`; Sereus's stale-build guard (`test-harness/`) will otherwise fail
  the integration suites for the wrong reason.

Phase 2 — verify against Sereus

- Run the `packages/integration-tests` suites that exercise real control writes across a multi-node
  party. This is the only place the scoping change on the control network is observable. Stream
  output with `tee`; if a suite routinely exceeds ~10 minutes wall-clock, skip it here and say so.
- Add coverage for the strand consequence: a strand network configured at
  `DEFAULT_STRAND_CLUSTER_SIZE` should assemble a 2-wide cohort, not 16. The unit-level shape in
  the new optimystic spec is the cheap model; a Sereus-level assertion against a real strand node
  is the honest one. Pick one and state which.
- Check `cadre-core`/`quereus-plugin-sereus` unit suites for anything that constructed the
  transactor path against a node without `keyNetwork`.

Phase 3 — documentation

- `packages/integration-tests/src/harness/forced-cluster.ts` header is now wrong: it documents the
  two-instances-per-node situation at length and justifies the prototype patch by it. The prototype
  patch is still needed (cold FRET), but the reason must be rewritten — one instance now, patched
  on the prototype because it is simpler than reaching each node's instance.
- `docs/architecture.md` → "Replication cluster size" should state that the transactor and the
  node's own consensus path share one key network and therefore one cluster size and one network
  scope. Update in place, do not add a new doc.

## Out of scope

The collection factory's own `createLibp2pNode` path still hardcodes `clusterSize: 1`
(`collection-factory.ts`, `createNetworkTransactor`). That path is not used by Sereus — every
Sereus node is injected via `registerLibp2pNode` — and after this fix the node and its transactor
at least agree with each other. Leave it.
