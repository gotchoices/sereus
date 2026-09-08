description: Add a test where two people, each with two machines, share one workspace across all four machines — writes from any machine reach every machine, a write still goes through with one machine switched off, and the returning machine catches up.
files: packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts (new), packages/integration-tests/src/harness/topology.ts, packages/integration-tests/src/harness/strand-join.ts, packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/testing.md
difficulty: hard
----

# Two parties × two machines, one strand across all four

New scenario `strand-two-party-two-machine.integration.ts`. The first test to reach four
machines on one strand — the designed operating point of `DEFAULT_STRAND_CLUSTER_SIZE = 4`
(`cluster-size.ts`), and the first topology that can lose a machine and keep committing
(a write commits on `ceil(4 × 0.75) = 3` approvals). Every cross-party strand test today
gives each party exactly one machine; every multi-machine strand stays inside one party.

## Design (settled during plan)

**One narrative `it`, phased, one topology.** Later phases depend on earlier state (a
stopped machine, a restart), so separate `it`s would each pay the ~80–120 s bring-up
(8 libp2p nodes: 4 control + 4 strand — see the `TIME BUDGET` header in
`harness/topology.ts`). Model the phase structure on `strand-late-cadre-join.integration.ts`.
Explicit test timeout ~420 s; do not touch `vitest.config.ts`.

**Bring-up.** `bootTopology` with two parties `a` and `b`, two machines each,
`genesis: 'genesis-first'` (the default, the production ordering), `controlMesh: 'full'`.
Every machine's spec carries its own `storageProvider: captureRawStorage().provider` so raw
stores are probeable. Then `joinStrandOn` with `members: [a0, a1, b0, b1]` (a0 founds), an
**open** strand (`type 'o'` — this scenario is about replication and availability, not
membership; the membership variant is `scenario-two-by-two-strand-membership`), a signed
sApp config (`createSignedSAppConfig`, simple key/value schema like the chat schema in
`convergence-stress.integration.ts`), `mesh: 'full'`, default barrier — it waits for
cohort `min(4, DEFAULT_STRAND_CLUSTER_SIZE) = 4` on every member, which is itself the
first time any test barriers a strand at four.

**Phases, in order:**

1. **Founder-party write reaches everyone, physically.** Insert on a0's strand DB. Gate
   with `awaitBlockCoverage(a0Store, xStore, …)` for each of a1, b0, b1 — raw stores
   FIRST, before any cross-machine database read (the probe rule: a read through a node
   can pull blocks into it). Only then read the row back through a1, b0, and b1's
   databases. At exactly four machines and breadth four, full coverage is the expected
   steady state, so no holder-set arithmetic is needed.

2. **A write from the joining party's second machine.** Insert on b1's strand DB — a
   non-founding machine of a party that did not form the strand, a path nothing exercises
   today (cross-party writes are always issued by the machine that formed the strand).
   Gate raw-store coverage from b1's store to the other three, then visibility everywhere.

3. **Both parties writing.** Rapid-sequential bursts and read-then-write interleaving per
   `convergence-stress.integration.ts` — NEVER `Promise.all` across machines (Optimystic
   replication is synchronous per write; truly simultaneous writes from both sides
   mutually block, and the failure would not be a defect). Modest counts (e.g. 5 per
   machine, all four machines taking turns, UUID keys). Converge to identical row sets on
   all four databases.

4. **One machine down, the strand still commits.** Stop a1 (`node.stop()` on the whole
   CadreNode — machine off, not just a hangup). Wait for the other strand nodes to drop
   the connection. Insert on b0. Expected timing: the cohort may still include the dead
   peer, so the write can pay ~2 × 10 s ClusterClient response deadlines before
   committing on 3-of-4 approvals — budget ~90 s, and wrap the insert in a bounded retry
   (the upstream lost-conflict race, `../optimystic/tickets/fix/lost-conflict-race-abstains-and-orphans-the-block`,
   can orphan a pend; a retry distinguishes that known flake from a genuine
   cannot-commit-degraded regression). Gate visibility on the three live machines. This
   assertion is impossible below four machines — at three, every holder must vote — so no
   existing test could have caught a regression here.

5. **The machine returns and catches up.** Rebuild a1 as a new `CadreNode` with the SAME
   identity and storage: `controlNodeConfig({ partyId: partyA.partyId, privateKey: a1.key,
   storageProvider: <a1's same capture>.provider, pinnedOwnerKeys: [partyA.ownerPublicKey],
   bootstrapNodes: <a0 addrs>, profile: 'transaction' })` — the recipe at
   `strand-late-cadre-join.integration.ts:602-632`. `addStrand` the same strand row +
   sApp config, then re-dial the three live strand nodes with `connectStrandNodes`
   (export it from `harness/strand-join.ts` — currently module-private; the harness
   change is part of this ticket). Gate `awaitBlockCoverage(b0Store, a1Store, …)` so the
   write it missed physically lands in its own store (peer-join backfill is the delivery
   mechanism under test — leave it enabled), then read the missed row through the
   restarted node's database.

6. **Teardown.** `topology.stop()` in `finally`, plus an explicit stop of the restarted
   node — it is NOT in the topology's started list. Track it in a handle the `finally`
   can see (the `LateJoinHandles` pattern).

## Edge cases & interactions

- **Which machines hold which blocks:** at four machines and breadth four, assert full
  coverage via `awaitBlockCoverage`; never a count. Counting is
  `debt-replication-proof-above-cohort-size` territory (parked — do not grow this
  scenario into it), and the peer-join backfill confound
  (`debt-strand-write-breadth-observed-end-to-end` has the full writeup) makes counts
  meaningless while it is enabled. For a coverage claim the backfill only helps.
- **Reading pulls blocks:** every physical claim gates on raw stores before any read
  through the target machine's database. `block-store-probe.ts`'s header is the rule.
- **Machines disagreeing about party size:** a non-issue by construction, and the test
  should say so in a comment rather than engineer it — strand nodes declare no repair
  yardstick (`strandClusterPolicy`'s unknown path is the production path; see
  `cluster-size.ts`), so control-plane count divergence
  (`control-divergent-repair-yardstick.integration.ts`'s subject) cannot touch a strand
  commit.
- **Simultaneous cross-party writes:** rapid-sequential / interleaved only (phase 3
  above); `Promise.all` across writers is a known mutual-block, not a defect.
- **Degraded-write timing:** first write after the stop may be slow (~20 s) or need one
  retry; a genuine failure is exceeding the ~90 s budget. Log wall-clock like
  `convergence-stress` does so future re-budgeting has numbers.
- **The restarted node is outside `Topology.stop()`:** it must have its own handle in
  `finally`, and the ORIGINAL a1 node must not be double-stopped (stopStartedNodes is
  idempotent per node, but the restarted node is a different object).
- **Storage capture reuse across restart:** `captureRawStorage` memoizes per scope, and
  its contract explicitly covers a `stop()`/`start()` cycle reaching the same durable
  backend — reuse a1's capture, never a fresh one, or the catch-up claim is vacuous.

## Out of scope

Machines that are not directly dialable (`strand-network-nat-relay-reachability`),
networks above four machines (`feat-scenario-medium-private-network`), block-count
assertions (`debt-replication-proof-above-cohort-size`,
`debt-strand-write-breadth-observed-end-to-end`), and membership actions from a second
machine (`scenario-two-by-two-strand-membership`, the sibling ticket).

## TODO

- Export `connectStrandNodes` from `harness/strand-join.ts` (it already has the right
  signature and labels; no behaviour change).
- Write `packages/integration-tests/src/scenarios/strand-two-party-two-machine.integration.ts`
  per the phases above.
- Run the new scenario in the foreground (no output redirection; `| tee tickets/.logs/…`
  only if grepping after) at least twice — the suite's physical-replication tests have a
  flakiness history, and one green run is not evidence of stability.
- Run `yarn lint` and `yarn typecheck`.
- Update `docs/testing.md` → `## Topology coverage map`: the line for this shape
  currently points at the `scenario-two-multi-machine-cadres-share-one-strand` plan
  ticket; rewrite it to name the new scenario file. Leave the membership variant's line
  pointing at its ticket until that lands.
