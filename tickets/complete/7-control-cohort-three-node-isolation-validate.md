----
description: A three-node network test proving that a device's background "connect to your party" routine is what actually forms the connection — reviewed, tightened, and passing.
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md, tickets/backlog/debt-cohort-edge-carries-data-coverage.md, tickets/backlog/debt-harness-supermajority-threshold-diverges-from-production.md
----
## What landed

`control-cohort-three-node-isolation.integration.ts` — a three-node party where
node B listens on **no** network address (the client-only phone/RN shape), so
nobody can dial B, and B learns sibling C exists only through replicated
`CadrePeer` records. Any B↔C connection is therefore necessarily one B opened,
and the only code that can open it is `CadreNode.reconcileControlCohort`. Two
cases:

- **automatic** — B's reconcile cadence set to 2s; the test waits for B to hold
  an outbound connection to C, then checks the 3-member cohort still converges.
- **load-bearing** — B's cadence set to 10 min so the timer never fires; a ~5s
  negative window asserts B has no connection to C and no libp2p peerStore
  address for C while C's signed record stays resolvable at every checkpoint —
  then explicit `reconcileControlCohort()` passes form the link.

Neither case calls `dial()` from the test. `docs/architecture.md` names the
scenario in the "cohort auto-connects" bullet.

## Review findings

### Verified against source (the claims the handoff asked to be checked)

- **Step-2b drain is sound.** `scheduleSelfRegistration` (`cadre-node.ts:1244`)
  fires ~1s after `start()`: `await registerSelf()` → `startRecordRefresh()` →
  `void reconcileControlCohort()`, all in one chain. The database write inside
  `publishSelfRecord` commits *before* `registerSelf()` resolves, so the test's
  `updatedAt > bVouchedAt` poll can at worst observe it a beat before the eager
  pass is issued — which the 1s sleep covers. `reconcileControlCohort` sets its
  single-flight promise synchronously (`cadre-node.ts:1609-1620`), so the
  following `await B.reconcileControlCohort()` genuinely joins any in-flight
  pass. The ordering claim holds.
- **B→C really has no other origin.** Audited every path that could dial from B:
  `applySeed` dials only `isOwner` peers (`seed-bootstrap.ts:768`) and B's seed
  predates C; `dialColdStartBootstrap` uses retained owner addresses only;
  `handleControlConnectionChange` (`cadre-node.ts:2214`) triggers the
  re-replication drain, which calls `registerSelf` and never dials. The only
  dialer is `dialControlSibling`, reached only from a reconcile pass.
- **Test run.** File run three times this session, all green, both cases each
  time (case 1: 4.5s / 5.2s / 5.1s; case 2: 9.5s / 10.3s / 10.1s) — the last two
  with the strengthened assertion below. `yarn lint` clean.
  `yarn workspace @serfab/integration-tests typecheck` clean. The full
  integration suite is long and was not run — the same deferral the implement
  stage made.

### Minor — fixed in this pass

- **Comment overclaimed the negative-window assertion.** The comment said "the
  record stayed resolvable throughout" but the assertion was
  `resolvedDuringWindow > 0` — satisfied by a single resolvable checkpoint out
  of twenty. Strengthened rather than reworded: the loop now counts checkpoints
  and asserts `resolvedCheckpoints === checkpoints`. Stable across two runs.
- **Dead surface.** `NodeOpts.enableRelay` had no caller (the scenario
  deliberately runs relay-free); `Trio` returned `A`, `aPeerId`, `bPeerId` and
  `seedB`, none of which any test body consumed. Both trimmed, and the
  now-unused `ControlNetworkSeed` type import with them.
- **Duplicated, throw-fragile teardown.** Both tests repeated the same three
  `handles.X?.stop()` lines; a throw from `C.stop()` would have leaked B's and
  A's listeners *and* masked the failure that sent control into `finally`.
  Extracted `stopTrio`, which logs a per-node stop failure and keeps going.
- **Two tripwires the handoff claimed were in the file were not.** Added both as
  `NOTE:` comments at their sites: the `self:peer:update`-triggered reconcile
  pass as first suspect if the negative window ever fails, and the single
  unreproduced cold-run timeout waiting for C's record to reach B.

### Major — filed as a ticket

- **Nothing proves the reconcile-formed connection carries data.** The scenario
  proves the routine *forms* B↔C, but its end-state convergence check is
  satisfied whether C's new revision travelled B↔C or took the older route
  through A — the file says so itself, twice. A regression that opened a useless
  connection would pass. Filed
  `backlog/debt-cohort-edge-carries-data-coverage`, marked `hard`: the obvious
  fix (stop A) also removes the storage node holding the blocks, so the topology
  needs real thought.

### Tripwires — recorded, not ticketed

Both are in the scenario file as `NOTE:` comments (see Minor above): the
`self:peer:update` reconcile trigger, and the one-off unreproduced timeout.
Neither is a defect today; each names the next diagnostic step if it trips.

### Checked and clean — nothing found

- **Isolation assertions.** None weakened; the one that changed got stricter.
- **Resource cleanup.** Every node booted is registered in `handles` before its
  `start()`, so a mid-boot throw still stops what came up; `stopTrio` now makes
  that survive a stop failure too.
- **Error handling / type safety.** `peerStoreAddrsFor` rethrows anything that
  is not `NotFoundError` rather than degrading to a false "empty peerStore",
  which is the direction that fails loudly. No `any` in the file.
- **Docs.** Read `docs/architecture.md`'s Convergence-prerequisites block; the
  "cohort auto-connects" bullet names this scenario and accurately describes it
  as proving the reconcile dial is the sole connector. No other doc references
  the scenario or the reconcile routine in a way this change dates.
- **Dangling reference resolved.** `test-party.ts:61` pointed at
  `debt-harness-supermajority-threshold-diverges-from-production`, which the
  implement stage created — it now exists and describes both the production
  unanimity-at-3 fragility and the harness's 0.51 override.
- **File hygiene.** 440 lines, comment-dense (~40%). Left as is: the density is
  carrying the ordering argument that makes the test's claim reviewable, and
  every block earns its place. Worth watching if the file grows further.

### Not run

Full `@serfab/integration-tests` suite — wall-clock exceeds the agent idle
budget, so it is CI's to run, per the same call the implement stage made.
No pre-existing failures surfaced in what was run; `tickets/.pre-existing-error.md`
not written.
