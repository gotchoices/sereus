description: Add a three-node test proving that a party member can automatically connect to a sibling it only learned about second-hand, with no shortcut connection helping it.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts (existing 2-node acceptance test — pattern to follow), packages/cadre-core/src/cadre-node.ts (reconcileControlCohort), packages/integration-tests/src/harness/index.ts (waitUntil / waitForCadrePeerConverged helpers)
difficulty: medium
----

## Problem

The `control-cohort-proactive-dial` work added an in-node `reconcileControlCohort`
routine that proactively dials a node's cadre siblings so the `CadreControl`
collections form a connected, replicating cohort. Its acceptance test
(`control-cohort-auto-convergence.integration.ts`) proves end-to-end convergence
through production APIs with **zero test-side `dial()`**, which is good — but in a
**2-node party the very first connection is necessarily made by the cold-start
path** (`applySeed`'s authority dial), not by `reconcileControlCohort`. The routine
can only dial siblings already present in the converged `CadrePeer` table, so it
cannot be the *sole* connector in a 2-node topology.

As a result, the scenario where the **reconcile dial is the only thing that forms
a connection** is not covered by any integration test. The orchestration unit
tests (`cadre-node-control-cohort.spec.ts`) cover the select/skip/resolve/dial
logic in isolation with fakes, and the pure policy is covered in
`control-cohort.spec.ts`, but the live-network "reconcile is load-bearing" path
has no end-to-end proof.

## Desired behavior

A ≥3-node topology that isolates the reconcile dial as the sole connector:

- Authority **A** (storage, holds the `CadrePeer` blocks).
- Member **B** — connects to A only via the production cold-start path (`applySeed`).
- Member **C** — also a member of the party, connected to A, but **B is never given
  any way to reach C directly** (no seed for C, no shared bootstrap, B's peerStore
  has no C entry).

The test should assert that **B connects to C purely because B learned C's `CadrePeer`
row (with a dialable address) by replication through A, and `reconcileControlCohort`
then dialed C** — i.e. B↔C is established with no cold-start assist and no test-side
`dial()`. Verifying the live B→C connection (e.g. via `getControlNode().getConnections()`
showing C's peerId on B) is the crux; a converged row that C authored after B↔C formed
is a stronger end-state assertion.

Watch for the cold-start fallback in `resolveControlDialAddrs`: the test must ensure
B reaches C via the **signed `CadrePeer` record** path (`resolvePeerAddrs`), not the
peerStore fallback — otherwise it doesn't prove the steady-state production path. That
means C must self-publish (or A must vouch for) a fresh, trust-gated address record B
can resolve, and B's peerStore must NOT already hold C.

## Notes

- This is test-strengthening, not a correctness fix — the routine's logic is unit-tested
  and end-to-end convergence is proven; this closes the one isolation gap the
  implementer explicitly flagged in the review handoff.
- Mind relay/NAT realism: with three local nodes a relay can introduce unstable
  circuit links (see the design notes in `push-wake-e2e.integration.ts`); prefer
  direct WebSocket dials and keep A non-relay unless the test specifically needs relay.
