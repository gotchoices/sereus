----
description: Someone starts a workspace on their phone, then adds a second machine to their account. Nothing in our tests checks that the workspace's existing contents actually show up on that new machine.
files: packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts
difficulty: medium
----

# A machine that joins the cadre *after* a strand exists must receive that strand

## The use case

A person creates a workspace (a **strand**) on their phone and writes to it. Their phone is
the only machine in their **cadre** — the set of machines that represent them. Later they add a
second machine: a hosted node, a laptop, a donated node from someone running `cadre-host`.

The expectation a user has is simple: the new machine shows them the workspace, including
everything written before it existed.

## Why this needs its own scenario

Audited across all 41 integration scenarios and every `packages/*/test/` spec on 2026-09-07.
The mechanism is covered along two axes that never meet:

- **A machine joins the cadre late, and reads data written before it arrived — but only on the
  control database, never a strand.** `control-offline-read-after-restart.integration.ts:88-153`
  is the genuine article: node A writes an `OwnerKey` while alone (`:88-92`), node B is
  constructed and started only afterwards (`:96-97`), and B later reads that pre-join row while
  offline (`:152-153`). No strand is involved anywhere in the file.
  `cadre-host-node-donation.integration.ts` also adds a real second node to an existing party
  (`provision` `:159`, `applySeed` `:206-209`) and asserts control-plane facts only (`:230`,
  `:246`, `:261-267`) — the string "strand" does not appear in it.
- **A machine joins a strand late — but it is a machine that already existed, belonging to a
  different party.** `strand-membership-closed-strand-e2e.integration.ts:535-587` is the closest
  thing in the repo, and its whole-store block check at `:1134-1139` cites
  `peer-join-backfill.ts` directly. But founder and joiner are separate parties
  (`:510`, `:513`), both nodes are up before either joins, and the joiner is a strand-level
  member, not a machine added to a cadre.

Every other scenario that runs two real strand instances starts **both** nodes before the strand
is created: `strand-addr-seed-convergence.integration.ts` (A `:88`, B `:100`, `addStrand` `:139`
and `:181`), `websocket-chat.integration.ts` (`:83`, `:106`, `addStrand` `:121`/`:124`),
`convergence-stress.integration.ts` (`:170`, `:188`, `addStrand` `:201`/`:204`),
`strand-formation-e2e.integration.ts` (`:455`/`:461` then `:493`/`:499`).

And the scenarios that *do* build multi-machine parties — `happy-path`, `multi-party-sync`,
`strand-creation` — reach strands only through `TestCadreNetwork.createStrand`
(`harness/test-network.ts:104-137`), which inserts a control-database row and launches no strand
instance at all. There is no strand data in them to converge.

So: no test anywhere creates a strand on a one-machine party and then grows that party's cadre.

## What the scenario must prove

One party. One machine (call it the phone) with a real `CadreNode`. Ordering matters and is the
whole point — every step must happen in this sequence:

1. The phone founds the party, creates a strand, and **writes rows into it** while it is the only
   machine in the cadre. Those writes commit local-only (cohort of one).
2. A second machine is enrolled into the cadre through the **production membership path** —
   `authorizePeer` → `createSeed` → `applySeed`, the way `control-trio.ts:140-163` does it — not
   by hand-wiring config.
3. The second machine calls `addStrand` for the same strand, learning what it needs through the
   product's own path rather than a test-side dial of the founder's strand address.
4. The rows written in step 1 become readable on the second machine.

Two assertions distinguish this from the coverage that already exists, and both should be made:

- **Read-through is not enough.** Assert against the second machine's **raw block store**, using
  `harness/block-store-probe.ts` (its header states the rule: write on the author, then poll the
  other node's raw store, never its database), so a row fetched on demand over the network does
  not pass for a row that was actually delivered.
- **Then prove it survives alone.** Stop the founder, or take the second machine offline, and read
  the strand rows from the newcomer by itself — the same shape as
  `control-offline-read-after-restart.integration.ts:152-153`, which is what makes the claim
  about durability rather than reachability.

## Edge cases & interactions

- **Which direction does the strand travel?** `peer-join-backfill.ts` is a *push* from the holder
  to the newly connected peer (it was renamed from `strand-backfill.ts` in `50c39aa` when it was
  generalized to serve both networks; live call sites are `cadre-node.ts:4309`,
  `strand-instance-manager.ts:96`, `types.ts:489`). If the newcomer instead pulls on read, the
  raw-store assertion above is what tells the two apart.
- **The named collection-header blocks.** A block written while the writer was alone has a cohort
  of one, and collection headers are written exactly once at creation — the same hazard
  `control-offline-read-after-restart.integration.ts` was built for, now on a strand.
- **The newcomer joins before the strand is fully quiet.** Enrolling the second machine while the
  first is mid-write is a distinct ordering worth one case, not a variant of the main one.
- **A strand the newcomer is not meant to run.** `addStrand` is per-node and gated by the
  embedding app registering its sApp config; a machine in the cadre that never calls `addStrand`
  must not end up holding the strand's blocks. Worth one negative assertion so the positive one
  means something.
- **`bug-strand-join-dies-on-missing-block` is live and adjacent.** A joining peer's strand setup
  fails roughly one attempt in nine with `Missing block`. Expect to meet it. If this scenario
  reproduces it, that is evidence for that ticket — record it there, do not re-diagnose it here,
  and do not weaken this scenario's assertions to get a green run.

## Out of scope

Relayed reachability (neither machine directly dialable) is
`strand-network-nat-relay-reachability`. Multi-machine cadres on *both sides* of a cross-party
strand is `scenario-two-multi-node-cadres-share-one-strand`. Keep this one to a single party
growing from one machine to two.
