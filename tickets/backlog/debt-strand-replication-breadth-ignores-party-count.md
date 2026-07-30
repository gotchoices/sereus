----
description: In a shared workspace with three or more parties, each piece of data is stored on only two of them; adding more parties never increases how many copies exist, so if those two are offline the others cannot read their own workspace.
files: packages/cadre-core/src/cadre-node.ts (~line 2748), packages/cadre-core/src/types.ts (~line 299), packages/cadre-core/src/strand-instance-manager.ts (~line 269), packages/quereus-plugin-sereus/src/cluster-size.ts, docs/strands.md
difficulty: hard
----

# A strand stores each block on two members no matter how many parties it has

## What was measured

While confirming that the three-party strand scenario passes, the underlying
replication behaviour was instrumented. In
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`
("should form a strand with three parties"), with all three parties connected in a
full mesh, **every** cohort selection returned at most two peers:

```
findCluster:done ... peers=1   x459
findCluster:done ... peers=2   x16
findCluster:done ... peers=3   x3
```

The third party still ends up able to read the data, but not because it was sent a
copy. It obtains it on demand at read time:

```
cluster-fetch:synced { blockId: 'default/Data', rev: 1 }
```

That fetch-on-read path is new — it is `../optimystic` commit `559df6a`, and before
it existed this scenario failed with a replication timeout. So the test passing is
genuine, but it is passing because a member that lacks the data can now go and get
it, not because all three members hold it.

## Why it happens

Two numbers that should be independent were the same number. **Since
`control-db-replicates-to-whole-party` landed they are separate settings** —
`CONTROL_REPLICATION_BREADTH` for the control network, `CadreNodeConfig.strandClusterSize` /
`DEFAULT_STRAND_CLUSTER_SIZE` for strands — but the strand default is still the control
network's old value of 2, so the behaviour below is unchanged. The populations differ:

- The **control network** is one party's own devices — typically one or two.
- A **strand** is the set of *parties* sharing a workspace — which is whatever people
  chose, and is the whole point of a three-party strand.

`cadre-node.ts` passes the configured value into strand startup unchanged, and
`strand-instance-manager.ts` resolves it through `resolveStrandClusterSize`, whose
default and floor is 2 (`packages/quereus-plugin-sereus/src/cluster-size.ts`). Nothing
in the strand path derives a value from strand membership, so a strand of any size gets 2.

Downstream, that number is the width of the cohort: `libp2p-key-network.ts` calls
`assembleCohort(coord, wants)` with `wants` set to the configured size, and the
membership-scoped branch keeps `clusterSize - 1` peers plus self. Two parties are in
every cohort, so nothing is ever missing locally — which is why the two-party
scenarios always passed and only the three-party one ever failed.

The value of 2 was chosen for the control network, in `bug-cluster-size-exceeds-cadre-size`
(now in `complete/`), and that choice was right for the problem it addressed. It was
simply never revisited for strands, where the population is different.

## Why it is worth fixing

Today's consequence is availability, not data loss:

- Adding parties to a strand never increases the number of copies. A five-party
  strand still stores each block on two members.
- A party that is outside a block's cohort can only read that block while at least
  one cohort member is reachable. For a workspace shared between people whose phones
  and laptops come and go, "both of the two members holding this happen to be offline"
  is an ordinary Tuesday, not an edge case.
- Every read from a non-holder is a network round trip that a local copy would not
  need.

Whether a strand *should* replicate to every member is a genuine design question and
not obviously yes — full replication costs storage and write amplification, and
`docs/strands.md` already contemplates strands larger than the replication factor
("LM: Large-scale mixed: More nodes than the DHT replication factor"). But the current
situation is not a considered position; it is a control-network default leaking into a
different problem.

## What makes this hard, and why it is filed here rather than as ready work

Raising the number is not a one-line change, and getting it wrong breaks writes
outright.

- **Members must agree.** As documented on `CadreNodeConfig.strandClusterSize`, a node
  configured *higher* than the cohort it is shown refuses to vote on the write, and a
  single refusal fails the commit. Under-configuring is safe; over-configuring is not.
  So a value derived from party count is only safe if every member derives the same
  one.
- **It is frozen at node creation.** The value is fixed when the strand's libp2p node
  is built. Party count is not fixed — parties join. A derived value therefore needs a
  story for what happens between "a party joins" and "every member has restarted its
  strand instance with the new number", during which members disagree, which is
  precisely the unsafe direction.
- **Upstream has not settled it either.** `../optimystic` tracks the same conflation
  as `clustersize-conflates-replication-factor-and-admission-yardstick` in its
  `tickets/plan/`: the number is simultaneously the replication factor and the
  yardstick a member uses to judge whether an inbound write came from a legitimately
  sized group. A clean fix here probably wants those separated upstream first, so this
  side can ask for "replicate to all members" without also telling every member to
  reject smaller cohorts.

The first step that avoids all of the above — stop having one knob serve two populations,
so the right value becomes expressible — is **done**: `control-db-replicates-to-whole-party`
split the control breadth out into its own constant and renamed the remaining knob
`strandClusterSize`. What is left is the decision this ticket is about: what value a strand
should use, and how members agree on it. That is a decision to take deliberately, not to
sneak in under a bug fix.

## Not in scope

Nothing here is a regression, and the three-party scenario currently passes. This is
about how many copies exist, not about whether members can read.
