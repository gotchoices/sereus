----
description: Our integration tests can either build a big network of machines that cannot hold a workspace, or a real workspace shared by exactly two machines — never both. That is why we have no test of the network sizes we actually want to ship.
prereq: harness-one-node-config-builder
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/vitest.config.ts, docs/testing.md
difficulty: hard
----

# One way to ask for a topology, instead of two harnesses that each refuse half the question

## The problem, stated once

The integration harness is two disjoint worlds, and neither can express the shapes we want to
ship. Audited 2026-09-07.

**World A — `TestCadreNetwork` / `TestParty`.** Declarative and scalable, but control-plane only.
`createParty({name, droneCount, droneProfile})` (`test-network.ts:80`, `test-party.ts:92`) is the
only topology knob in the suite. Its drones are **not `CadreNode`s at all** — they are bare
libp2p nodes built by `createLibp2pNode` (`test-party.ts:41-65`), so they cannot run a strand.
There is exactly one `ControlDatabase` per party, on the owner (`test-party.ts:139-144`, stated
at `test-network.ts:233-240`). Wiring is a hard-coded star: drones dial the owner and never each
other (`test-party.ts:125-128`), which permanently caps a drone's cohort at two — asserted at
`harness-party-control-cohort.integration.ts:188-193`. And `createStrand`/`joinStrand`
(`test-network.ts:104`, `:178`) write control rows only; `joinStrand` even mints a throwaway
identity for the joiner's `PeerKey` (`test-network.ts:206`), so the joining party is not really
the joiner.

**World B — `CadreNode` fixtures.** Real strands, real data, but fixed arity. `bootPair` /
`bootConnectedPair` (`node-fixtures.ts:252`, `:319`) are two nodes; `bootControlTrio`
(`control-trio.ts:101`) is three in one hard-coded A/B/C ordering. Nothing takes an N. The
three-party strand in `strand-formation-e2e.integration.ts:670-720` is hand-rolled inline.

The consequence is measurable: the largest strand cohort any test reaches is **three machines**
(`strand-formation-e2e.integration.ts:770-773`) — three parties of one machine each. No test
reaches four. No party contributes more than one machine to a cross-party strand. Multi-machine
parties exist only in tests that launch no strand instance.

## What to build

A builder that takes a topology description and returns started, wired, real `CadreNode`s.
Roughly: *N parties, M machines each, this subset joined to strand S, connected in this order.*

The four capabilities missing today:

- **Multi-machine parties made of real `CadreNode`s**, enrolled through the production membership
  path (`authorizePeer` then `createSeed` then `applySeed`, as `control-trio.ts:140-163` does),
  not bare libp2p drones and not hand-wired config.
- **Mesh control wiring for M above 2.** `connectControlNodes` (`node-fixtures.ts:229`) is a
  both-sides-confirmed pairwise link and is the right primitive; callers loop it by hand today.
  The star in `test-party.ts:125-128` is what caps drone cohorts at two, so the builder must not
  reproduce it.
- **A "these machines join strand S" step**, with the founder/non-founder split as a parameter
  rather than a per-call decision (`CadreNode.addStrand`, `cadre-node.ts:3951`).
- **An N-node readiness barrier**, generalizing the hard-coded wait for two in
  `bootConnectedPair` (`node-fixtures.ts:343-349`). `readCohort` (`control-cohort.ts:120`)
  already works for any Optimystic network including strands and is the primitive to build on;
  `waitForControlCohort` (`control-cohort.ts:153`) currently takes a `TestParty`, so a
  `CadreNode` topology cannot use it as-is.

Compose existing seams rather than inventing parallel ones: `controlNodeConfig`
(`node-fixtures.ts:121`), `makeOwnOwner` (`:161`), `createSignedSAppConfig` (`:34`),
`wsTransports` (`:26`), `connectControlNodes` (`:229`), `waitForControlConnection` (`:211`),
`signMessageEd25519` (`test-network.ts:38`), `stopStartedNodes` (`node-fixtures.ts:368`, exported
by the prerequisite ticket).

## Constraints that are already known — design around them, do not rediscover them

- **Time is the first wall, not memory.** Building three 3-node parties already needs a **180 s**
  `beforeAll` (`harness-party-control-cohort.integration.ts:168`) against a 30 s default
  `hookTimeout` (`vitest.config.ts:22`). Ring warm-up is the cost: sub-second for a three-node
  party, ~5 s worst observed (`test-party.ts:56-59`, repeated at `control-cohort.ts:14-19`).
  A topology of any size needs an explicit hook timeout or it fails in setup alone.
- **Every `CadreNode` on a strand is two libp2p nodes**, not one — a control node plus a strand
  node with its own derived transport key (`cadre-node.ts:4280-4311`). Budget accordingly: six
  parties of two machines each, all on one strand, is 24 libp2p nodes in a single fork.
- **One file at a time, one fork.** `pool: 'forks'`, `fileParallelism: false`
  (`vitest.config.ts:29-30`); no `maxForks`, no `poolOptions`, no `max-old-space` setting
  anywhere in the repo. Everything a scenario builds lands in one process.
- **`forceFullCohort` and live strand traffic do not mix.** It patches
  `Libp2pKeyPeerNetwork.prototype` process-wide (`forced-cluster.ts:51-55`), and
  `control-cohort.ts:46-49` says outright that suites creating strand databases should not use
  these helpers while strand traffic is live. A topology carrying real strands cannot lean on
  forced cohorts for determinism; it needs the real barrier instead. Patch restores are
  last-applied-first (`forced-cluster.ts:57-64`).
- **The one-probe-key cohort argument holds only below 16.** `control-cohort.ts:27-36` —
  the probe stays representative under `CONTROL_REPLICATION_BREADTH`, and `minPeers` is
  hard-capped at the party's own node count (`control-cohort.ts:170-174`).
- **Ports are not the constraint in-process.** `port-allocator.ts` is a no-op that returns `0`
  (`:15`, `:31-33`) so the OS assigns ephemeral ports. They *are* a constraint for
  child-process scenarios, which hard-code disjoint bands by unenforced convention
  (`port-allocator.ts:18-26`).
- **A mid-setup throw leaks proportionally.** `waitForControlCohort` starts and stops nothing
  (`control-cohort.ts:148-152`) and `bootPair` leaves cleanup to the caller
  (`node-fixtures.ts:254`). At a dozen nodes the builder owns teardown, including on the failure
  path — `bootConnectedPair` (`:326-364`) is the only self-cleaning fixture today and is the
  model.

## Edge cases & interactions

- **A party of one must still work**, and must produce exactly what `bootPair` produces today —
  the degenerate case is the one most scenarios use.
- **Asymmetric parties** (one party of three machines, one of one) are the realistic shape, not
  the uniform grid. The description format should not force uniformity.
- **A machine in a party that does *not* join the strand** must be expressible; that negative is
  what makes "the strand landed on the right machines" mean anything.
- **Failure during enrollment of the kth machine** must tear down the ones already started, not
  leave them listening.
- **The builder must not silently become the only ordering.** Write-while-alone and
  connect-then-write prove different things (`node-fixtures.ts:291-300`); both must remain
  expressible.

## Second deliverable: a coverage map, so the next gap is visible

`docs/testing.md` documents gate policy but says nothing about which *topologies* the integration
suite covers. That is why gaps this size — no strand above three machines, no multi-machine cadre
on either side of a cross-party strand, no relayed strand at all — sat unnoticed. Add a short
section naming the topology classes we intend to cover and pointing each at the scenario that
covers it, with the uncovered ones named as uncovered and pointing at their ticket. Keep it a map,
not a status board: one line per class, no pass/fail state, consistent with that document's own
rule that current state lives in the suites and in `tickets/`.
