----
description: Two people who each own more than one machine share a workspace. Nothing we test looks like that — every shared-workspace test today gives each person exactly one machine.
prereq: harness-topology-builder
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/harness/block-store-probe.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md
difficulty: hard
----

# A strand shared by two parties that each bring two machines

## The use case

Two users each already have a small workspace of their own and more than one machine — a phone
and a laptop, or a phone and a hosted node. They form a shared strand. Both machines of both
parties serve it. Data written on either machine of either party reaches all four.

This is the ordinary shape of a working relationship between two people who use the product
seriously, and nothing in the suite resembles it.

## What is covered today, measured

Audited 2026-09-07 across all 41 integration scenarios. Two axes that never intersect:

- **Cross-party strands exist only with exactly one machine per party.** Every one of them:
  `strand-formation-e2e.integration.ts` at `:493`/`:499` (two parties) and `:718-720` (three
  parties), `strand-membership-closed-strand-e2e.integration.ts:535-536`,
  `rbac-signed-write.integration.ts:131-132`, `multi-party-workflows.integration.ts:136,139`.
- **Multi-machine strands exist only inside a single party, and only at two machines.**
  `websocket-chat.integration.ts:121,124`, `convergence-stress.integration.ts:201,204`,
  `strand-addr-seed-convergence.integration.ts:139,181`.

The largest strand cohort anything reaches is **three machines**, from three parties of one
(`strand-formation-e2e.integration.ts:770-773`, asserted as `readCohort(...).length >= 3`). No
test reaches four machines on a strand. No party has ever contributed a second machine to a
cross-party strand.

## Why four machines specifically, and not three

Four is the strand replication breadth (`DEFAULT_STRAND_CLUSTER_SIZE`, `cluster-size.ts`), and
`docs/architecture.md` explains why: a write commits on a super-majority, so a cohort of three
needs all three to approve, while four needs three — four is the smallest breadth that commits
while one holder is offline. Everything at three machines and below is therefore in the regime
where every machine holds everything and every machine must vote. Two parties of two is the first
topology that reaches the designed operating point, and it is also the first that can lose a
machine and keep working.

That gives this scenario a second assertion the smaller ones cannot make: **stop one of the four
machines and the strand must still accept a write.** At three machines that is impossible by
construction, so no existing test can have caught a regression in it.

## What the scenario must prove

Two parties, two machines each, all four serving one strand.

- A write on party A's first machine is readable on **both** of party B's machines, and on A's
  second machine.
- A write issued from party B's *second* machine — not its founder — is accepted and converges
  everywhere. Cross-party writes today are always issued by the one machine that formed the
  strand; a non-founding machine of a joining party is a path nothing exercises.
- With one of the four machines stopped, a write still commits, and when that machine returns it
  catches up.
- Membership actions (invite, join, manager rotation) driven from a party's non-founding machine
  behave as they do from its founder — `strand-membership-closed-strand-e2e.integration.ts`
  already proves this across parties at one machine each, so the new variable is the second
  machine, not the action.

## Edge cases & interactions

- **Which machines hold which blocks.** At exactly four machines and a breadth of four, every
  machine should still hold everything, so this scenario can assert full coverage via
  `harness/block-store-probe.ts` without needing to name an expected holder set. Above four that
  stops being true and becomes `debt-replication-proof-above-cohort-size`, which is parked — do
  not grow this scenario into that one.
- **Reading pulls blocks.** The raw-store probe rule applies: write on the author, poll the other
  machines' raw stores, never their databases.
- **Peer-join catch-up muddies a holder-set claim.** `peer-join-backfill.ts` pushes blocks to
  peers as they connect, which by itself would place a block everywhere. The existing writeup of
  this confound is in `debt-strand-write-breadth-observed-end-to-end`; consult it before
  designing any count-based assertion.
- **A party whose two machines disagree about the party's size.** The control network's repair
  yardstick is derived per machine from the machines it believes are enrolled
  (`control-divergent-repair-yardstick.integration.ts`). A second machine that joined recently
  may carry a different count; the strand must commit anyway.
- **Both parties writing at once.** Optimystic replication is synchronous per write, and
  `convergence-stress.integration.ts` records that truly simultaneous writes from both sides
  cause mutual blocking. Use its rapid-sequential and interleaved patterns rather than
  `Promise.all`, or the scenario will fail for a reason that is not a defect.

## Out of scope

Machines that are not directly dialable — that is `strand-network-nat-relay-reachability` and
the relayed scenario that depends on it. Networks larger than four machines — that is
`feat-scenario-medium-private-network`.
