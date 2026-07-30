description: There is no automated test proving that a node's network settings actually reach the networking layer when it starts up, so a wiring mistake there would only show up as a mysterious runtime failure.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts
difficulty: medium
----

# Test coverage: control-network node options

`CadreNode.start()` builds the options for the control network's libp2p node — identity key,
storage, profile, relay, replication cluster size, and more — and hands them to
`createLibp2pNode`. Nothing asserts that the values an embedder configures actually arrive there.

The equivalent path for strand networks *is* covered:
`packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts` mocks `createLibp2pNode`
and asserts on the options object. `StrandInstanceManager` is cheap to construct, so that test is
a few lines. `CadreNode` is not — starting one pulls in the control database, key resolution,
watchers, and more, so the same trick needs either a heavier set of test doubles or a small
refactor that makes the options object independently reachable (e.g. a pure function that maps
config to node options, called by `start()` and asserted directly).

The most recent motivation: the replication cluster size was mis-wired for months and was only
caught by reading debug logs. That specific value now has strand-side coverage and input
validation, but the control-network side is still trusted rather than verified.

## What "done" looks like

A test that fails if a configured value stops reaching the control network's node options, without
standing up a real libp2p node. Cluster size is the obvious first case; the same seam should make
the other options assertable.
