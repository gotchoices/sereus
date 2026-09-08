----
description: We have never run a shared workspace with more than three machines on it, so we do not know how the product behaves at the size a small team or family would actually use.
prereq: harness-topology-builder
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/vitest.config.ts, docs/architecture.md
difficulty: hard
tradeoffs: Nothing ships on a strand larger than four machines today, the run would be among the slowest in the suite, and a maintainer may reasonably want the four-machine scenario green and stable before paying for a twelve-machine one.
----

# A medium private network: several parties, several machines each, one closed strand

## The use case

A handful of people — a family, a small team, a working group — share one invitation-only
workspace, and several of them own more than one machine. Call it four to six parties of one to
three machines each: eight to twelve machines on one strand.

We have no idea what this does. The largest strand cohort any test has ever reached is three
machines (`strand-formation-e2e.integration.ts:770-773`), and the largest set of machines the
suite builds at all is nine control-plane nodes with no strand on them
(`harness-party-control-cohort.integration.ts:165-167`, whose own comment calls that "the whole
port budget this file takes").

## Why this size is qualitatively different, not merely bigger

Above four machines the system stops being one where everyone holds everything. Strand
replication breadth is four (`DEFAULT_STRAND_CLUSTER_SIZE`, `cluster-size.ts`), so on a strand of
eight, each block lives on four of them and which four depends on the block. A machine outside a
block's holder set answers reads by going over the network. Three consequences worth naming
before anyone writes this scenario:

- **Read latency and read failure become topology-dependent** in a way they never are below five
  machines. A read that always resolved locally now sometimes does not.
- **Durability stops being observable by looking at any one machine.** The measurement problem
  this creates is already written up in `debt-replication-proof-above-cohort-size` — including
  the unanswered question of how a test names the expected holder set for a block from outside
  the node. That ticket is the prerequisite thinking for any count-based assertion here.
- **The super-majority bar moves.** Commit requires approval from three-quarters of the cohort a
  block was offered to, so what a losing machine costs changes with cohort width.

## What this scenario should establish first

Deliberately modest, because nothing at this size has ever been observed:

- The topology **forms at all** — every machine reaches a steady cohort, within a stated time
  budget, without the run timing out in setup.
- A write from any machine converges to every machine, including ones outside the block's
  holder set (which must fetch it).
- Losing one machine, then two, does not stop writes; the surviving set still commits.
- A machine that was offline through several writes catches up when it returns.

Numbers rather than pass/fail are the point of the first run: how long formation takes at eight
and at twelve machines, how many libp2p nodes are actually alive (every machine on a strand is
two — a control node plus a strand node, `cadre-node.ts:4280-4311`), and where the wall is.
Record them in the scenario, dated, the way the storage-op budgets do.

## Known limits to design against

- **One fork, one file at a time** (`vitest.config.ts:29-30`), so twelve machines means
  twenty-four libp2p nodes in a single process.
- **Setup time is the first wall.** Three 3-node parties already need a 180 s `beforeAll`
  (`harness-party-control-cohort.integration.ts:168`). If a run of this scenario routinely
  exceeds about ten minutes it is not agent-runnable and belongs to a human or to CI, not inside
  a ticket.
- **The one-probe-key cohort barrier is only valid below sixteen** (`control-cohort.ts:27-36`),
  which twelve still satisfies — but it is close enough that the margin should be stated rather
  than assumed.
- **`forceFullCohort` cannot be used** to make this deterministic: it patches the key network
  prototype process-wide and must not be live while strand traffic is
  (`forced-cluster.ts:51-55`, `control-cohort.ts:46-49`).

## What this is not

Not the public-network case — this strand is closed, every party arrived by invitation, and every
machine is directly dialable. Openness is `feat-scenario-public-open-strand-network`;
reachability is `strand-network-nat-relay-reachability`. Not the durability-count measurement
either; that is `debt-replication-proof-above-cohort-size`.
