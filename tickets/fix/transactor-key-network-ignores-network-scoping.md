description: The database layer builds a second, unconfigured copy of the peer-discovery component, so when it picks which machines a write goes to it forgets which network it is on and how wide the group should be.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/cadre-core/src/cadre-node.ts, packages/quereus-plugin-sereus/src/cluster-size.ts
difficulty: hard
----

# The transactor's key network is constructed with default arguments

## What was found

Every Cadre node ends up with **two** `Libp2pKeyPeerNetwork` objects over the same libp2p
node. A key network is the component that answers "which peers should this key's data live
on?" (`findCluster`) and "which peer should coordinate this write?" (`findCoordinator`).

1. The node-attached one, built in optimystic's `libp2p-node-base.ts:695`, gets every
   configured argument — cluster size, network mode, persistence, reputation, and the
   **protocol prefix** that scopes discovery to peers actually serving this network.
2. A second one, built by the Quereus collection factory at
   `quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:312`, as
   `new Libp2pKeyPeerNetwork(libp2pNode)` — **no arguments at all**.

The second one is the one the `NetworkTransactor` uses, so it is the one that decides the
peer set and the coordinator for every actual database write.

The same factory function computes the correct protocol prefix one line later
(`collection-factory.ts:181`) and passes it to `RepoClient.create(...)`. It just never
passes it to the key network. This reads as an oversight, not a decision.

## Why it matters

Two concrete consequences, both visible in `Libp2pKeyPeerNetwork`:

- **No network scoping.** With `protocolPrefix` unset, `findCluster`/`findCoordinator` skip
  the "does this peer serve my network?" filter entirely (the `serves` check and the
  foreign-peer drop). Any peer in the routing table — a relay, a bootstrap node, a peer of
  a different party — is eligible to be picked as a cohort member or coordinator for a
  write it cannot serve.
- **Wrong group width for strands.** The constructor defaults `clusterSize` to 16. Cadre
  configures the *control* network at 16 as well (`CONTROL_REPLICATION_BREADTH`), so control
  writes are accidentally unaffected — but strand networks are configured at
  `DEFAULT_STRAND_CLUSTER_SIZE = 2`. Strand writes therefore assemble their peer group at
  width 16 instead of 2. Reputation and persistence are likewise dropped.

## How it was found

While reviewing `debt-control-write-availability-degraded-cohort-member`. That work needed
to force a deterministic peer group in a test and found that patching the node-attached
instance had no effect on writes — which is what exposed the second instance. The test-side
consequence is handled there (a prototype patch); this ticket is about the production
consequence, which is untested and unaddressed.

## What resolving this looks like

- Confirm the reachability of each consequence before fixing. Strand writes at width 16 in a
  2-node strand should be observable; whether a foreign peer can actually be selected depends
  on what is in the routing table at the time.
- Decide the layer. The clean fix is upstream (pass the configured arguments through from the
  collection factory, which already has them). Sereus can also register a custom key network
  via `collectionFactory.registerCustomKeyNetwork()`, but that duplicates optimystic logic.
- Whatever lands, the two instances should agree on network scoping and cluster size, or the
  reason they legitimately differ should be written down.

## Not in scope

Whether a single node should have two key-network instances at all. Consolidating them is a
larger change; this ticket is about the two making the same decisions.
