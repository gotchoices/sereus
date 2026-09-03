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

## Second arm — a *security* consequence of the same gap, not only a durability one

Added 2026-09-02 from the plan pass of `strand-seal-binds-a-second-node`, which measured
this boundary from the other side.

Committing a write needs approval from a super-majority of the block's cohort. On a strand
of two machines, the cohort *is* both machines, so a write cannot commit unless the other
machine has already taken part in it. Measured: a founder whose only peer was unreachable
could not seal the strand at all — `Failed to get super-majority: 1/2 approvals (needed 2,
0 rejects)` on the `Manager` block, and, when the `Revocation` collection had never been
written before, `Block default/Revocation is unavailable (cohort-unreachable)`. Both fail
closed and leave the strand unsealed on both sides.

Above the cohort size that stops holding, and the consequence is not only "fewer copies".
A machine outside a given block's cohort never has to approve the write, so it can hold a
stale view of that block for an unbounded time while the write commits elsewhere. For
membership blocks that stale view is an **authorization** input: the schema's admission
gates (`ConsumedInvite.NotSealed`, `Manager.Authorized`, the last-member floor) are all
evaluated against locally visible rows. A machine that has not heard that a strand was
sealed still satisfies `NotSealed` and would admit the holder of an invitation issued
before the seal.

So whatever fixture answers the questions above should also be able to stage a *stale
non-cohort reader* deliberately, not only count copies. Today no fixture in the repo can:
the two-node closed-strand scenario cannot produce a divergent-commit partition at all,
for the reason measured above. That is worth knowing before anyone tries to test the
`MemberExists`-under-partition or `Revocation`-replay hazards that
`docs/architecture.md` lists beside seal propagation — they need this fixture first.
