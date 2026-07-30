description: A new three-node network test still fails intermittently — finish making it reliable, then note it in the docs.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts (EDITED, still failing), packages/integration-tests/src/harness/wait-utils.ts, packages/integration-tests/src/harness/test-party.ts, packages/cadre-core/src/cadre-node.ts, docs/cadre-consistency.md, docs/architecture.md
difficulty: hard
----

## Status carried over (second implement run — budget-capped)

This run type-checked, ran, and diagnosed the scenario, and landed two fixes.
The file **has not yet had a green run**. Remaining work is below.

The prior run wrote the file but never executed it. This run:

- `yarn workspace @serfab/integration-tests typecheck` — **passes** (before and
  after the edits). No compile errors ever existed in the draft.
- `yarn build` at repo root — passes.
- Ran the scenario file three times (whole file once, then each `it()` alone with
  `DEBUG='sereus:cadre:node'`). Both cases failed, in three different ways.
- Applied two fixes based on what the debug logs showed. Not yet re-run.

Note: the stale-build guard tripped mid-session on `@quereus/quereus` — the
sibling working copy at `C:\projects\quereus` has uncommitted edits from someone
else (`packages/quereus/src/func/builtins/scalar.ts`,
`packages/quereus/src/schema/function.ts`, a new spec file). Cleared by running
`yarn workspace @quereus/quereus build` in that repo. Expect to need that again.

## What the scenario is for (context, no prior session needed)

`reconcileControlCohort` on a cadre node proactively dials the party's other
nodes so the control-database collections form a connected, replicating group.
In a two-node party that routine can never be the thing that forms the first
connection — the cold-start seed path always gets there first. So the case where
the reconcile dial is the *only* reason a connection exists had no end-to-end
proof.

The scenario builds a three-node party: A (owner + storage, listens), B
(client-only, listens on **nothing**), C (listens). B and C each cold-start from
a seed A mints. B learns C exists only because C's signed address row replicated
to B through A. Because B listens on nothing, C physically cannot dial B, so any
B↔C connection is one B opened.

Two test cases in one file:
- **automatic** — B's reconcile interval set to 2s; the test waits for B to
  acquire an outbound connection to C.
- **load-bearing** — B's reconcile interval set to 10 minutes so the recurring
  timer never fires; a ~5s negative window asserts B has no connection to C and
  no libp2p peerStore address for C *while* C's record resolves fine, then
  explicit `reconcileControlCohort()` passes form the link.

Neither case calls `dial()` from the test.

## Observed failures, with the cause established from debug logs

### 1. The negative window is defeated by B's eager start reconcile pass — FIXED (unverified)

`CadreNode.scheduleSelfRegistration` runs `registerSelf()` ~1s after `start()`
and then fires **one** unawaited `reconcileControlCohort()` pass. On the fast
path the whole `bootTrio` finishes in ~1.2s from `B.start()`, so that eager pass
lands right on top of the negative window and dials C itself. Debug log, case 2:

```
16:15:16.208 Record refresh wired (heartbeat=450000ms, cohortReconcile=600000ms)   <- B
16:15:16.360 Record refresh wired (heartbeat=450000ms, cohortReconcile=15000ms)    <- C
16:15:16.362 reconcileControlCohort: dialing sibling <C> (1 addr(s))               <- B's EAGER pass
16:15:16.374 reconcileControlCohort: pass complete (siblings=2, selected=2, dialed=1)
```

Fix applied in `bootTrio`: A now vouches B **before** `B.start()` (so B's
start-time `registerSelf` has a row to refresh instead of skipping), and a new
step **2b** waits for B's row to gain a self-signed revision, sleeps 1s, then
`await B.reconcileControlCohort()` — which returns the in-flight pass, so it
resolves only once no pass is running. All of that happens before C is created,
so the eager pass provably cannot be what forms B↔C.

The logs also positively confirm the isolation claim itself: C's own pass reports
`no dialable control address for sibling <B>; skipping`. C genuinely cannot dial B.

### 2. Control writes fail on a transient stream reset — PARTLY FIXED (unverified)

Case 1 failed once with a commit error out of Optimystic:

```
Error: Some peers did not complete: <B>[block:...](in-flight) cause=The stream has been reset,
  <C>[block:...](in-flight) cause=Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections), ...
  ❯ NetworkTransactor.pend  ❯ Collection.updateAndSync  ❯ Tree.sync
  ❯ TransactionBridge.commitTransaction
```

Cause: `CadreNode` leaves Optimystic's default `superMajorityThreshold` of 0.75,
and the control cluster downsizes from `CONTROL_REPLICATION_BREADTH` (16) to the
3 peers actually present. `ceil(0.75 × 3) = 3` — every control write needs
**unanimity**. One reset stream during the churn of B↔C forming fails the whole
commit. This is why the integration harness (`harness/test-party.ts`) overrides
`superMajorityThreshold: 0.51` and says so in a comment there; this scenario
builds `CadreNode` directly and so runs the production threshold.

Fix applied: case 1's end-state `C.registerSelf()` is now polled through
`waitUntil` instead of called once. `waitUntil` catches and debug-logs predicate
throws (`sereus:integration:wait`), so a transient commit failure retries rather
than failing the test — mirroring production, where the record heartbeat retries
the identical call. Steps 4–5 of `bootTrio` were already polled.

**Judgement call for the next agent:** this is a real fragility of three-member
control parties, not a test artifact. It is *pre-existing product behaviour*,
partially documented in that harness comment, and the backlog slug the comment
points at (`debt-harness-supermajority-threshold-diverges-from-production`) is
**not present in `tickets/backlog/`** — so nothing currently tracks it. If the
retry above is not enough to make the scenario stable, do **not** loosen the
isolation assertions; file a `fix/` or `backlog/debt-` ticket describing "a
three-member control party requires a unanimous commit, so any transient stream
reset drops a control write", and say so in the review handoff.

### 3. `B resolves C's signed CadrePeer address record` timed out at 45s — NOT DIAGNOSED

The very first run (whole file, cold) failed case 1 at step 6 of `bootTrio` after
45s. Every later run resolved that same condition in milliseconds. Not reproduced
since, so no cause established. It may be cold-start cost (that run spent 11.4s
just importing) or a genuine intermittent. Watch for it; if it recurs, capture
`DEBUG='sereus:cadre:node'` output for the window and check whether C's row ever
reached B at all. Per the original ticket: if C's self-published record genuinely
fails to replicate A → B, that is a **product finding worth its own `fix/`
ticket** — do not work around it by having A write C's row with a test-held key
(an owner-written row carries a null self-signature and `resolvePeerAddrs`
rejects it, which would silently gut the test).

## Remaining work

- Re-run the file, at minimum twice, streaming output (the runner kills on a
  10-minute idle — never silent-redirect):
  `yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-three-node-isolation.integration.ts 2>&1 | tee /tmp/cohort3.log`
  Running the single file is the intended validation; the full package suite is
  long, and the handoff should say that is what was run.
  Add `DEBUG='sereus:cadre:node'` when something fails — that is what made every
  diagnosis above possible.
- Expect to need `yarn workspace @quereus/quereus build` in `C:\projects\quereus`
  first if the stale-build guard trips.
- Get both cases green and stable. Do not weaken the isolation assertions
  (`connectionsTo(B, C) === 0`, empty peerStore for C pre-dial, `direction ===
  'outbound'`) to achieve it.
- `yarn lint` — not yet run this session.
- Add one line to `docs/cadre-consistency.md` (or the Control Network section of
  `docs/architecture.md`, whichever already describes the cohort reconcile)
  noting that the reconcile-as-sole-connector path now has an end-to-end proof,
  naming the scenario file.
- Hand off to `review/` with an honest note on: which assertions are ordering
  properties versus wire proofs; whether the negative window in case 2 was stable
  across runs; and the unanimous-commit fragility from failure 2 above.

## Other known risks still standing from the original ticket

- **`self:peer:update` can fire a reconcile pass on B outside the timer.** B
  listens on nothing so its own address record should not change mid-test, and no
  run has shown this happening — but if the negative window still fails after fix
  1, this is the next thing to check. Either the trigger is legitimate (then
  re-scope the case-2 claim and say so plainly) or it is a real product finding
  worth its own ticket.
- **Transient inbound deny on C.** If B dials C before B's membership row has
  replicated to C, C refuses the inbound and the connection dies moments after the
  dial resolves. The file already polls rather than asserting on a dial's return
  value; if it still flakes, widen the poll, don't assert on a single pass.
- **peerStore emptiness is only assertable pre-dial.** After the dial, libp2p
  identify populates B's peerStore with C. Keep the emptiness assertions at the
  pre-dial checkpoints only.

## TODO

- Run the file twice; fix remaining ordering flake without weakening the
  isolation assertions.
- Decide and act on the unanimous-commit fragility (retry sufficed / needs a
  ticket).
- `yarn lint`.
- Add the one-line docs note.
- Write the `review/` handoff.
