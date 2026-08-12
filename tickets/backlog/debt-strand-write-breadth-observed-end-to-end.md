----
description: We configure how many machines each piece of strand data is copied to, and we check that the number is passed along correctly — but no test in this repository ever counts how many machines actually ended up holding a block. A wrong number would go unnoticed here.
prereq:
files: packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-backfill.ts
difficulty: hard
tradeoffs: The upstream unit spec plus a now-required constructor argument already make the known failure mode unrepresentable, so this test buys defence-in-depth against a future regression rather than covering a live gap — and every similar physical-replication test in this suite has been flaky.
----

# Nothing here observes the cohort width a strand write actually used

## What is covered today, and what is not

Replication breadth for a strand is `DEFAULT_STRAND_CLUSTER_SIZE` (`cluster-size.ts`). Two things
already hold it in place:

- `packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts` and
  `packages/quereus-plugin-sereus/test/plugin.spec.ts` assert the configured number reaches
  `createLibp2pNode` — but they mock that function, so they stop at the boundary.
- `../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`
  asserts the SQL collection factory reuses the node's own key network rather than building a
  second one from defaults, and that the reused one carries the configured width and the network's
  protocol prefix.

What no test in this repository does is **count**. Nothing observes how many machines physically
hold a block after a strand write, so nothing here would notice if the effective breadth diverged
from the configured one. `strand-formation-e2e.integration.ts` comes closest — it waits for the
authoring node's cohort to reach three members — but it reads the cohort off the node's own key
network, which is the instance that has always been configured correctly. It is a floor check
(`>= 3`), not a width check, and it would have passed throughout the two-key-networks defect that
`transactor-key-network-ignores-network-scoping` fixed.

## What the test should prove

On a three-machine strand configured with a breadth of **2**, a write must land on exactly **2** of
the three machines — not on all three. That is the assertion that distinguishes a correctly scoped
transactor from one silently running at Optimystic's default breadth, and it needs three machines
because at two the configured width and the default are indistinguishable.

## Two confounds the design has to handle, both known

- **Reading through a node can pull the block into it.** `packages/integration-tests/src/harness/block-store-probe.ts`
  exists for this exact problem and its header states the rule: write on the author, then poll the
  other nodes' RAW stores, never their databases.
- **Peer-join block catch-up copies blocks to every connected peer.** `strand-backfill.ts` pushes a
  strand's blocks to peers as they connect, which by itself would put the block on all three
  machines and make the count meaningless. It is configurable
  (`CadreNodeConfig.strandBackfill`), so the test must disable it and say why in a comment —
  otherwise the next reader will "fix" the test by re-enabling it.

## Why this is filed rather than done

Weighed during `transactor-key-network-ignores-network-scoping`'s implement pass and deliberately
not built there: the upstream unit spec covers the defect that pass was fixing, and
`Libp2pKeyPeerNetwork`'s constructor now takes `clusterSize` as a **required** argument, so a
caller silently defaulting the width is a compile error rather than a runtime surprise. That makes
this test defence-in-depth. The other half of the reason is cost: the comparable physical test in
`strand-membership-closed-strand-e2e.integration.ts` passed 1 of 4 runs when it was last measured,
so a three-node physical-holder assertion is a real flakiness risk that needs its own repetition
budget rather than being bolted onto an unrelated pass.
