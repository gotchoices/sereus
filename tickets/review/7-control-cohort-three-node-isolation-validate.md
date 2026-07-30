----
description: A three-node network test that proves the background "connect to your party" routine really is what forms the connection is now reliable; review the test's claims and stability.
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/harness/wait-utils.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md, tickets/backlog/debt-harness-supermajority-threshold-diverges-from-production.md
----
## What this delivers

`reconcileControlCohort` (the recurring routine on a `CadreNode` that dials the
party's other members so the control database replicates) previously had no
end-to-end proof that *it* forms connections — in a two-node party the
cold-start seed dial always makes the first connection, so the routine never
had one of its own to make. The new scenario builds a three-node party where a
client-only node B (listens on **nothing**, so nobody can dial it) learns that
sibling C exists only through replicated `CadrePeer` records, and the only way
a B↔C connection can exist is B's reconcile dial. Two cases:

- **automatic** — B's reconcile cadence set to 2s; the test waits for B to hold
  an outbound connection to C, then checks the 3-member cohort still converges
  (C republishes its record, B observes the new revision).
- **load-bearing** — B's cadence set to 10 min so the timer never fires; a ~5s
  negative window asserts B has **no** connection to C and **no** libp2p
  peerStore address for C while C's signed record stays resolvable — then
  explicit `reconcileControlCohort()` passes form the link.

Neither case ever calls `dial()` from the test.

## Validation performed

- Scenario file run **three times**, all green, both cases each time
  (case 1: 4.8s / 14.6s / 14.6s; case 2: 9.4s / 9.5s / 9.4s). Single-file runs
  are the intended validation — the full integration-tests suite is long and
  was **not** run this session.
- `yarn lint` — clean. `yarn workspace @serfab/integration-tests typecheck` and
  root `yarn build` — clean (verified in the prior implement session; no source
  edits since, only docs/tickets).
- Docs: the "cohort auto-connects" bullet in `docs/architecture.md` (Convergence
  prerequisites block) now names this scenario as the end-to-end proof that the
  reconcile dial is the sole connector.
- Operational note: the stale-build guard tripped twice across sessions on
  `@quereus/quereus` — the sibling `C:\projects\quereus` working copy has
  live human edits. `yarn workspace @quereus/quereus build` there clears it;
  expect to need it again.

## What the assertions actually prove (review this honestly)

- **Wire-level proofs:** B holds zero connections to C and zero peerStore
  addresses for C at every pre-dial checkpoint; the eventual connection is
  `direction === 'outbound'` on B's side; C physically cannot dial B (no listen
  addrs — debug logs confirm C's own pass reports "no dialable control address
  for sibling B; skipping").
- **Ordering properties, not wire proofs:** the claim that B's ONE eager
  start-time reconcile pass (fired by `scheduleSelfRegistration` ~1s after
  `start()`) cannot be what forms B↔C rests on `bootTrio` draining that pass
  **before C exists** — observable via B's row gaining a self-signed revision,
  a 1s sleep, then awaiting `reconcileControlCohort()` (which joins any
  in-flight pass). Sound as ordering, but a reviewer should confirm the
  drain logic against `cadre-node.ts` rather than trusting the comment.
- **Explicitly out of scope (stated in the file):** case 1's end-state
  convergence check does not prove the new revision traveled over the B↔C wire
  (it may arrive via A); the peerStore-emptiness assertions apply only pre-dial
  (libp2p identify populates it after).

## Stability and known fragilities

- The case-2 **negative window was stable in all three runs** — the prior
  session's failure (B's eager start pass landing inside the window) is fixed
  by the drain above and did not recur.
- **Three-member unanimity fragility (real product behaviour, now tracked):**
  `CadreNode` runs Optimystic's default 0.75 super-majority; a 3-member control
  cluster therefore needs unanimous approval, so one transient stream reset
  fails a control write outright (observed once during diagnosis). The test
  absorbs this the way production does — polling `registerSelf()` like the
  record heartbeat — and case 1's 4.8→14.6s run variance is consistent with
  one absorbed retry cycle. Filed as
  `backlog/debt-harness-supermajority-threshold-diverges-from-production`
  (the slug a `test-party.ts` comment already pointed at, previously dangling);
  it also covers the harness overriding the threshold to 0.51, which lets
  regressions pass tests and fail real parties.
- **One unreproduced timeout:** the very first cold run (prior session) timed
  out at 45s waiting for B to resolve C's record; every later attempt resolved
  in milliseconds across both sessions. No cause established. If it recurs,
  capture `DEBUG='sereus:cadre:node'` and check whether C's row reached B at
  all — a genuine A→B replication failure would deserve its own `fix/` ticket.
- Tripwire (recorded in the scenario's comments, not a ticket): if the negative
  window ever fails again, the next suspect is a `self:peer:update`-triggered
  reconcile pass on B — B listens on nothing so its own record should never
  change mid-test, and no run has shown it, but the trigger exists.

## Review suggestions

- Re-run the file once or twice
  (`yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-three-node-isolation.integration.ts 2>&1 | tee /tmp/cohort3.log`;
  rebuild `@quereus/quereus` in the sibling repo first if the freshness guard
  trips).
- Check `bootTrio`'s step-2b drain against `CadreNode.scheduleSelfRegistration`
  — the negative-window claim rests on it.
- Do not weaken the isolation assertions (`connectionsTo(B, C) === 0`, empty
  peerStore pre-dial, `direction === 'outbound'`) to fix any flake; widen a
  poll instead, per the file's comments.
