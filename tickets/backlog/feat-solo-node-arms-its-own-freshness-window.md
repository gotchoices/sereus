description: A user running a single machine re-checks with the network on every read of every piece of data, even though there is no other machine that could have changed it — because the node describes itself as a two-machine group rather than the one machine it is.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/cadre-node.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts
tradeoffs: The saving is invisible to anyone but a genuinely solo user, and the node cannot tell "I am the only machine" apart from "my membership records have not caught up yet" — so a maintainer may reasonably prefer the current always-recheck behaviour, which is never wrong, over one that is cheaper but relies on local records being complete.
----

# Let a genuinely solo node trust its own writes

Split out of `feat-repair-yardstick-strand-nodes`, which deliberately floors the declared repair
yardstick at 2 so its change can only ever raise the number relative to today.

## What a solo node does now

After a node commits a block, Optimystic decides whether that commit is evidence that nobody else
committed a competing version — if it is, the node remembers the block as fresh and skips re-checking
with the network on the next read for a while. The test is
`approvals > max(observedCohortSize, declaredSize) / 2` (`CoordinatorRepo.commitQuorumRulesOutRivals`).

A one-machine cadre gets 1 approval and declares 2, so `1 > 1` is false and the window never arms.
Every read of every block it wrote consults a cohort that does not exist, once per read-repair window
per block. If it declared the honest 1, `1 > 0.5` holds and the commit is trusted — which for a
machine that is genuinely alone is simply true. Optimystic removed an internal floor specifically so
this case would work; the remaining floor is Cadre's.

Declaring 1 instead of 2 changes nothing about block repair: the corroboration floor is identical at
1 and 2 for every visible-peer count.

## Why it was not done in the first pass

A node with zero authorized peers is *usually* a genuine founder-alone party, but the same reading is
produced by a freshly seeded node whose membership rows have not replicated yet, and by one whose
trusted-owner anchor is empty. This node cannot tell those apart. In the first two, trusting its own
solo commits as evidence about the whole group is wrong — a sibling may have committed something it
has not seen.

So this needs a way to say "alone **and** I know it" that the ambiguous cases cannot satisfy. Some
candidate signals, none evaluated: this node founded the party (it holds the genesis, rather than
having applied a seed); the node has been enrolled and connected at least once and has since observed
no other machine; an explicit single-machine declaration from the embedding application.

## What "done" looks like

A solo cadre node stops consulting a nonexistent cohort on reads of its own writes, and none of the
ambiguous cases above ever reaches that state. Worth confirming first that the consults are
measurably costing something — nobody has profiled a solo node — since the change buys latency, not
correctness.
