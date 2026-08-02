description: When a second machine joins a shared strand, everything written from then on is copied to it immediately, but data written before it joined is never copied — the newcomer can still read that older data by asking the original machine over the network, so if that machine goes offline the older data becomes unreachable.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/harness/block-store-probe.ts
difficulty: medium
----

## What was measured

`debt-strand-replication-proof-headers-and-validate` added a test that reads a node's raw
block store directly (never its database, so the probe itself cannot cause data to be
fetched). On a two-node closed strand where both nodes run in `networked` mode:

| moment | founder's own store | joiner's own store |
| --- | --- | --- |
| strand-level libp2p dial completes | 18 blocks | 7 blocks |
| after founder-only writes (invite, join, one app row) | 27 blocks | 23 blocks |

Of the 9 blocks the founder gained plus the 4 it advanced to a higher revision, **all 13
were physically present in the joiner's own store on the first poll, roughly 1 ms after
the last write returned.** Ongoing replication works, and it is part of the commit rather
than a later sweep.

The 9 blocks the joiner never received were all committed **before** the dial — the
founder's bootstrap `Header` / `Member` / `Manager` data and index blocks, written while
the cohort was one node. Nothing ever pushed them afterwards. Two of those nine are not a
gap at all: they are collection root blocks, and a root's identifier is a fresh random
value minted locally, so each node's root for the same collection carries a different
identifier and could never match. The remaining seven are the real gap.

## Why it matters

The joiner can still `select` those bootstrap rows — all three visibility tests in that
file pass — because a read resolves a coordinator peer per block and that coordinator is
the founder, answering from its own storage. So today the gap is invisible to an
application. It becomes visible the moment the founder is unavailable: the joiner holds no
copy of the strand's founding membership rows and cannot serve or verify them alone. A
strand whose founder is offline is a normal state, not an exotic one.

Notably, the joiner's reads of those rows during the visibility tests did **not** cause it
to keep a copy — the blocks stayed absent from its raw store across the whole run. So
read-through is not an accidental backfill either.

## The control database already solves the analogous problem — strands do not

`CadreNode.drainPendingControlReplication` is a "write-while-alone re-replication queue":
control-DB writes that committed with no other peer available are remembered and
**re-issued** once the cohort grows past zero. It works at the row level, not the block
level, and it exists only for the control database. A strand has no equivalent, which is
exactly why the founder's pre-dial bootstrap rows stay put. See
[`docs/cadre-consistency.md`](../../docs/cadre-consistency.md) → *What Ships Today*, which
now records both the measurement above and this asymmetry.

## What a fix would look like (not a plan — context for triage)

Some form of catch-up when a peer joins a cohort: the newcomer learns which blocks the
cohort already holds and pulls them, existing members push their committed blocks to a
newly-seated peer, or the strand grows a row-level re-issue queue mirroring the control
one. Whether that belongs in optimystic's cohort/coordinator layer or in cadre-core's
strand join path is the open question; the durability model this repo wants (how many nodes
must hold a block before it counts as durable) should probably be settled first, since it
determines whether "one node holds it" is a defect at all.

## Expected behaviour to test against

The natural regression test is a fourth-test sibling: bring up the two-node closed strand,
let it converge, **stop the founder**, then read the bootstrap membership rows from the
joiner's database and require them to resolve. That test would fail today.

A cheaper version already exists in shape: widen
`compareBlockCoverage(founderStore, joinerStore)` in the closed-strand file's physical test
back to the whole store (drop the `include` narrowing). Do not do that until the backfill
exists — it is currently a deliberate, documented narrowing, explained in that test's
`WHAT IS AND IS NOT CLAIMED` comment.
