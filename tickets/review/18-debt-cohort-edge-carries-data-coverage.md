----
description: Review the new integration test proving that when a device automatically opens a connection to another member of its party, real data actually travels over that new connection — plus the two flake classes that hit it and how they are tracked.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, tickets/fix/control-read-over-fresh-edge-stream-resets.md, tickets/.pre-existing-known.md
difficulty: medium
----

# Review: control-cohort edge carries data (implement handoff)

## What was built

- **Scenario** `control-cohort-edge-carries-data.integration.ts` (~300 lines,
  heavily commented — the file header is the design doc). Proves by ORDERING
  that a `CadrePeer` revision authored on C while B was provably isolated
  reaches B only across the B→C connection that `CadreNode.reconcileControlCohort`
  formed. Steps: boot A/B/C (B listens on nothing) → baseline (r0 +
  time-independent asserts) → sever B↔A (test gater + hangUp, both sides
  drained) → 16-checkpoint negative window (B zero connections, A-side zero,
  B's peerStore empty for C, C's record still resolvable on B) → C authors R1
  under a write pin to C → unpinned `B.reconcileControlCohort()` forms B→C →
  carry pin to C, B observes R1 while every open connection B holds is to C
  and the link-time connection id is still the open one → closing (C seated in
  B's cohort, both pins' `callCount() > 0`).
- **Harness** (committed in earlier runs): `bootControlTrio`/`stopControlTrio`
  in `harness/control-trio.ts` (port of the isolation scenario's private
  `bootTrio`, plus `gaterB` support), `connectionsTo`/`hasOutboundTo`/
  `peerStoreAddrsFor` in `node-fixtures.ts`, exports in `harness/index.ts`.
- **This run's two scenario fixes**: (1) after the sever, wait for A's side of
  the closed connection to drain too — `hangUp` resolves when B's side closes,
  A learns a beat later, and the window's first `connectionsTo(A, bPeerId)`
  checkpoint deterministically raced it (3/3 failures before, gone after);
  (2) the carry-timeout error message now appends an `A=… B=… C=…` peer-id map
  so aggregate transactor errors naming a raw peer id are attributable without
  a debug rerun.
- **Isolation scenario untouched** (verified: no diff).

## Validation status — honest

- `yarn lint` and `yarn typecheck` clean at final state.
- **One full green end-to-end run** (18.8 s, well inside the 120 s budget):
  every assertion passed including both pin call-count closes, and the
  design's one empirical unknown resolved favorably — the negative-window
  `B.resolvePeerAddrs(cPeerId)` read succeeds on isolated, unpinned B (served
  from B's local pre-sever replicated state), so no weakening was needed.
- Two flake classes hit the scenario across ~15 runs; NEITHER was papered over:
  1. **Boot gate** ("B resolves C's signed CadrePeer address record", 45 s) —
     pre-existing, already tracked in `tickets/.pre-existing-known.md` against
     `transactor-key-network-ignores-network-scoping` (blocked; root cause is
     optimystic's boot-time coordinator self-pick cached 30 min). Fingerprint
     confirmed identical with the instrumented `sig=(empty)` log. The scenario
     is now listed there too. Failed ~half of runs; DO NOT re-triage.
  2. **Carry step** — on ~half of boot-green runs, B's pinned read to C fails
     for the full 60 s with repeated `Some peers did not complete: <C>[block:…]
     (in-flight) cause=The stream has been reset`. NEW finding, filed as
     `fix/control-read-over-fresh-edge-stream-resets` (prereq'd on the blocked
     ticket — all measurement happened against a half-edited sibling optimystic
     dist, twice caught mid-drift by the stale-build guard, so it must be
     re-measured after optimystic settles). Also listed in
     `.pre-existing-known.md`.
- Isolation scenario re-run unchanged this session: test 1 green (13.3 s),
  test 2 failed its already-tracked boot gate — matches its known state.
- NOT done (budget stop): a post-settle multi-run soak. Once
  `transactor-key-network-ignores-network-scoping` unblocks and optimystic is
  rebuilt, run the edge scenario ~6×; expect green except boot-gate residue,
  and see the fix ticket if the carry failure persists.

## Honest scope

Carriage is proven in the READ direction only (B pulls R1 across the edge).
The write direction (B promising a C-coordinated write over the same edge) is
implied by B's cohort seating assert, not separately proven — deliberate,
documented in the scenario header.

## Reviewer checklist

- Run: `yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-edge-carries-data.integration.ts`
  — a boot-gate timeout or the carry stream-reset error are the two KNOWN
  fingerprints above, not review findings; anything else is.
- Check the ordering argument holds: the pin scoping (write pin off during the
  reconcile pass — file header explains the chicken-and-egg), the negative
  window's four per-checkpoint claims, and the link-time connection-id assert.
- Check the severable gater covers all dial paths (`denyDialPeer`,
  `denyDialMultiaddr` last-p2p-component, `denyOutboundConnection`).
