description: The code that restarts a donated machine after it crashes has now been compiled, tested, and documented — ready for a code-review pass.
files: packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/bin/host.ts, docs/cadre-host.md, docs/STATUS.md
---

# Donated-node respawn supervisor — ready for review

Finishes `16.5-donated-node-respawn-supervisor` / `16.6-donated-node-respawn-supervisor-finish`.
The code (`donation-supervisor.ts` + wiring + tests) was already committed at `a01b1e8`
("ticket(implement): donated-node-respawn-supervisor") but had never been compiled, run, or
documented. This ticket did that last mile: build, test, lint all pass with **zero code changes**
needed; only `docs/cadre-host.md` and `docs/STATUS.md` were updated (uncommitted — runner commits).

## What this is

`DonationSupervisor` (`packages/cadre-host/src/donation/donation-supervisor.ts`) owns the invariant
*a non-terminal donation is expected to be running*. A donated node is a child process on a
stranger's home PC — it can crash, get OOM-killed, or die in a reboot — and nothing else in
cadre-host brings it back. The supervisor:

- Considers only donation records with status `awaiting_seed` or `seeded` **and** an orchestrator
  handle (`dockerId`). `provisioning` records are left alone (provision still owns them); `error`
  and `terminated` are terminal.
- Runs one `reconcile()` pass behind three triggers — host startup, an orchestrator exit event, and
  a 1-minute periodic sweep — serialized through a tail promise so no id is ever double-spawned by
  two overlapping triggers.
- Backs off exponentially per id (5s doubling, 5-minute cap) and gives up after 5 consecutive
  failed attempts, at which point it writes the record to `status: 'error'` (frees the grant's quota)
  and stops (but does **not** remove) the still-named child, preserving its workdir/identity key for
  a later `terminate()`.
- Refills a donation's attempt budget once it has stayed up 10 minutes past a respawn, without
  touching `updatedAt` (that field is the stale-`awaiting_seed` reap's clock, and a liveness
  observation is not borrower activity).

Wired into `packages/cadre-host/src/bin/host.ts`: constructed alongside `donationService` (now
sharing one hoisted `donationStore`), `start()`ed after the orchestrator initializes, `stop()`ped
next to `clearInterval(reapTimer)` on shutdown.

`packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts` is the `FakeOrchestrator` used by
both `donation-service.test.ts` and the new `donation-supervisor.test.ts` — moved out of the former,
extended with per-`dockerId` liveness, an `onStateChange` subscription, and a `crash(dockerId)`
helper. `docs/cadre-host.md` gained a "Respawn (keeping a donated node up)" subsection under "Node
donation (the primary role)", right after "The donate-a-node lifecycle" and before "Status of the
donation surface" (which was also corrected to mention the supervisor). `docs/STATUS.md`'s `[~]`
respawn bullet is now `[x]`.

## Validation done this ticket

- `yarn workspace @serfab/cadre-host build` — clean (tsc + vite, no errors).
- `yarn workspace @serfab/cadre-host test` — **58 test files passed (58)**, **487 tests passed, 4
  skipped**. Includes all 12 new `donation-supervisor.test.ts` cases and the edited
  `donation-service.test.ts` (confirmed the `FakeOrchestrator.isRunning` semantics change — was
  hardcoded `true`, now reflects real per-child liveness — did not break any existing
  `donation-service` assertion).
- `yarn lint` — 0 errors. 6 pre-existing warnings, all in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts` (unused
  eslint-disable directives), unrelated to this change — not touched.
- No fixes were needed anywhere in the donation code, tests, or wiring; everything the prior
  (interrupted) session wrote was already correct.

## Use cases for testing / validation

- **Crash-and-respawn**: a `seeded` donation's child dies (crash, not `terminate()`) → next
  reconcile pass gives it a new `dockerId`/`seedToken`, keeps `status: 'seeded'` (borrower's loan is
  untouched, no re-seed needed). Covered by
  `donation-supervisor.test.ts` → "respawns a seeded-but-stopped node...".
- **awaiting_seed crash**: same, but status stays `awaiting_seed` so the borrower's pending seed
  request still lands on the new endpoint. Covered by "...so the borrower can still seed it".
   - **Give-up path**: 5 consecutive failed respawns → record becomes `error`, child is `stopped` but
  never `removed` (workdir survives), grant quota frees (`liveNodeCount` drops), no further attempts.
  Covered by "gives up after the attempt cap...".
- **Healthy reset**: a donation with a prior failed-attempt count that has been up ≥10 minutes gets
  its attempt budget refilled to 0 on the next observation, without moving `updatedAt`. Covered by
  "refills the attempt budget...".
- **Never touches terminal records**: a `terminated` loan, a `provisioning` record, or a record with
  no `dockerId` yet is never respawned. Covered by three separate cases.
- **Trigger wiring**: `start()` sweeps once at startup and again on a real exit event via
  `FakeOrchestrator.crash()`; `stop()` unsubscribes so a later crash goes unnoticed until the next
  start. Owner-node exits (`info.owner === true`) are ignored — `bin/host.ts` owns respawning that
  one, not this supervisor. Covered under `describe('DonationSupervisor start/stop')`.
- **Concurrency**: two overlapping `reconcile()` calls on the same crashed id produce exactly one
  respawn, not two. Covered by "serializes overlapping passes...".

## Honest gaps carried forward (not fixed here, by design)

- **No real-child coverage.** Every supervisor test runs against `FakeOrchestrator` — nothing proves
  a *real* respawned child process actually rejoins the borrower's cadre end-to-end. That needs the
  cross-package `cadre-host-node-donation` integration scenario
  (`packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`), which does not
  yet exercise a mid-loan crash/respawn. Out of scope here; flagging for whoever extends that
  scenario next.
- **`backlog/debt-failed-respawn-strands-donated-workdir` is now reachable in production.** The
  give-up path's `giveUp()` (`donation-supervisor.ts:316`) calls `orchestrator.stopContainer()` on a
  child whose respawn already failed — in the real `HostProcessOrchestrator` this is expected to
  throw "container not found" (the failed respawn dropped the handle), which `giveUp` catches and
  logs. That backlog ticket describes exactly this leaked-workdir scenario. Not fixed here — it's
  filed and tracked separately.
- **Startup-sweep / stale-reap interleaving is reasoned about, not tested.** `bin/host.ts` runs the
  supervisor's startup sweep and the stale-`awaiting_seed` reap sweep both at boot; they can
  interleave. Believed safe because `DonationService.respawn` re-reads the record and refuses any
  status other than `awaiting_seed`/`seeded`, so a record the reap just terminated can't be
  resurrected by a racing respawn — but no test exercises that interleaving directly. If it ever
  turns out to matter, that's where to look.
- **`NOTE:` tripwire already in code, not re-filed as a ticket**: `donation-supervisor.ts` on
  `giveUp()` (~line 312) — an `error`-after-give-up record keeps its workdir until someone calls
  `terminate()`; if stale `error` workdirs ever pile up on real hosts, extend the reap sweep in
  `donation-service.ts` to cover them.

## Suggested review focus

- Whether the exponential-backoff / give-up numbers (5s base, 5min cap, 5 attempts, 10min healthy
  window, 60s sweep) are reasonable defaults for a residential-PC failure mode, or should be
  configurable.
- Whether the `giveUp` → `error` transition correctly interacts with every other code path that
  reads donation status (routes, reap sweep, quota accounting) — this ticket only verified it
  against the supervisor's own test suite plus the existing `donation-service` suite, not a
  system-wide status-transition audit.
