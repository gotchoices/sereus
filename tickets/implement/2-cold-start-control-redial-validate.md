---
description: Code that lets a newly-joined machine keep retrying its first connection is written but has not been run yet — the tests and checks still need to be executed, and anything they turn up fixed.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, docs/architecture.md
difficulty: medium
---

# Validate the cold-start bootstrap retry

The implementation for `cold-start-control-redial` is written and typechecks. The prior run hit
its token budget before executing any test. **Nothing here needs redesigning** — the work is to
run the checks, fix whatever they surface, and hand off to review.

## What already landed (uncommitted, in the working tree)

- **`packages/cadre-core/src/cadre-node.ts`**
  - New field `controlBootstrapPeers: Map<string, string[]>` — peerId → the multiaddr strings a
    seed listed for that peer. Holds only the **owner-flagged** peers of seeds this node applied.
    Chosen over reading the shared libp2p peer store because the peer store accumulates
    everything libp2p discovers, so "dial every entry" would drift into dialing arbitrary peers;
    this map is exactly what a signature-checked, trust-anchored seed nominated. The rationale is
    written into the field's doc comment.
  - `recordSeedBootstrapPeers(seed)` populates it. Called from **both** intake paths: the
    `CadreNode.applySeed` wrapper (via the new `noteAppliedSeed` helper — the wrapper can run on a
    throwaway `SeedBootstrapService`, which is why retention lives on the node, not the service)
    and the inbound `/sereus/seed/1.0.0` handler through `onSeedApplied`.
  - `runReconcileControlCohort` no longer returns immediately when `siblings.length === 0`; it
    calls the new `dialColdStartBootstrap()`, which skips already-connected peers and dials the
    rest best-effort via `dialBootstrapPeer`. It logs
    `reconcileControlCohort: cold-start pass complete (bootstrap=…, connected=…, dialed=…)`,
    distinct from the steady-state `pass complete` line.
  - **Retry bound decision: unbounded, no backoff.** The branch is already gated by "the control
    database still has no siblings", so it stops the moment the node is really in the party, and a
    stranded node must keep trying. A tripwire `NOTE:` sits on `dialColdStartBootstrap` — add
    per-peer backoff if seeds ever carry many owner peers or the reconcile cadence drops well
    below its 15 s default.

- **`packages/cadre-core/src/types.ts`** — `ApplySeedResult` gains `ownerDialsAttempted` and
  `ownerDialsFailed`. `success` keeps its existing meaning ("the seed was accepted"); the counters
  are what distinguish "seeded and connected" from "seeded and stranded". Documented caveat: zero
  failures is *not* proof of a live connection, because the receiver's membership gate denies
  after the dialer's upgrade completes.

- **`packages/cadre-core/src/seed-bootstrap.ts`** — the owner-dial loop counts attempts/failures;
  a `seedRejected(error)` helper builds the pre-dial rejection results; `SeedEventCallbacks.
  onSeedApplied` gained a third argument (the applied seed) so a node can see a wire-delivered
  seed's contents.

- **`packages/cadre-core/test/control-stream-authorization.spec.ts`** — the one existing caller of
  `onSeedApplied` updated for the new third argument.

- **`packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts`** —
  new scenario. A vouches a decoy peer first (so A's inbound gate is armed and no longer admits
  everyone), B applies A's seed while still unvouched and is refused, A vouches B afterwards, and
  B must dial its own way back in. B runs with `listenAddrs: []` so A cannot dial B, and the
  assertion additionally requires `direction === 'outbound'` on B's connection — together those
  make the cold-start branch the only thing that can produce the connection. Then a row A writes
  afterwards must converge to B.

- **`docs/architecture.md`** — new "Cold-start bootstrap retries" bullet in the Control Network
  status list.

## What to do

- [ ] Run the new scenario:
      `yarn workspace @serfab/integration-tests test -- control-cohort-cold-start-retry`
      (stream output with `2>&1 | tee`, never a silent redirect).
- [ ] **Confirm it fails without the fix** — temporarily restore the early `return` in
      `runReconcileControlCohort`'s `siblings.length === 0` branch, re-run, see step 5 of the
      scenario time out, then restore the branch. Record the observed failure in the handoff.
- [ ] Run `yarn workspace @serfab/cadre-core test` (the `onSeedApplied` signature change and the
      `ApplySeedResult` shape both touch existing specs).
- [ ] Run `yarn lint`.
- [ ] Run the full integration suite from `packages/integration-tests` and compare against the
      post-`scenario-vouch-reader-before-seed` baseline. If a failure is plainly unrelated, follow
      the pre-existing-failure procedure — do not skip or loosen a test.
- [ ] Fix anything the above turns up.

## Known risks the prior run did not get to check

- **The forced denial may not hold.** The scenario relies on A's `admitInboundControlConnection`
  denying B once A knows of at least one authorized member — hence the decoy peer vouched at
  step 1. If A still admits B (e.g. `listAuthorizedMembers` does not count the decoy row because
  it was written while A was alone), step 3 will fail and the scenario needs a different way to
  arm the gate.
- **Timing.** B's reconcile cadence is 2 s and the recovery wait is 45 s; the convergence wait is
  another 45 s, inside a 120 s test timeout. If the suite is slow on CI these may need widening.
- **The decoy and B's own membership rows are both written while A is alone**, so they ride the
  write-while-alone re-issue path. The scenario deliberately writes the convergence subject (X)
  only *after* B is connected, to keep the subject isolated — but that ordering is worth
  re-checking if convergence flakes.

## Handoff

Output goes to `review/`. Be honest about what was and was not run, and about the two decisions
recorded above (bootstrap-address source, unbounded retries) so the reviewer can challenge them.
