----
description: On a strand of two machines we expect every machine to hold a copy of everything, and we are about to test that. On a larger strand only some machines hold each piece, and we have no test that checks the right number of copies exist.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts
----

## The gap

A strand aims to keep 4 copies of each block (`DEFAULT_STRAND_CLUSTER_SIZE`), and the set
of machines that hold a given block is capped at the machines actually serving that
strand. So:

- on a strand of 4 machines or fewer, every machine should hold every block, and
- above 4, each block should live on 4 of them — which four depends on the block.

The ticket `debt-strand-replication-vs-visibility-proof` covers the first case, at two
machines, by looking directly inside the second machine's block store. Nothing covers the
second case. Above four machines, a machine outside a block's holder set answers reads by
going over the network, and the durability question ("do 4 copies really exist?") becomes
a genuinely different measurement than "can everyone see it?".

The related suite `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` builds
meshes of 1–4 peers and asserts *visibility* from every peer, explicitly noting it does not
inspect local storage. It stops at four.

## Why it is parked rather than urgent

Nothing ships on a strand larger than four machines today, and the four-and-under case is
the one production hits. This becomes real work when strands grow, or when the target
number of copies changes again.

## What would need answering first

- How to name the expected holder set for a block from outside the node — the test needs
  to know which 4 of N machines *should* hold a block before it can check that they do.
- Whether the same probe covers the **control** database, which uses a much wider breadth
  (`CONTROL_REPLICATION_BREADTH`) and a different peer set than any strand.
- Whether a copy that arrived because someone read it (the read path can fetch and keep a
  block on demand) should count toward the durability claim, or whether the test needs to
  distinguish copies placed at write time from copies pulled in later.
