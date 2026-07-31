---
description: When someone ends their borrowed node while the host is restarting that node after a crash, the ending now wins — the record stays ended and the half-started replacement is shut down and cleaned up.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, docs/cadre-host.md, docs/STATUS.md
difficulty: medium
---

# Review: ending a loan mid-restart wins over the restart

## What the bug was

`DonationService.respawn` read the donation record at entry, spent seconds inside
`orchestrator.createContainer(...)`, then wrote back a whole row built from that entry-time copy.
`DonationStore.put` replaces the whole row, so a `terminated` write that landed during the spawn was
silently overwritten — the ended loan came back to life, kept holding a quota slot, and the freshly
spawned child was left running with nothing tracking it.

A second half made it worse: the real orchestrator (`HostProcessOrchestrator.createContainer`) calls
`dropStaleHandle(containerId)` *while* spawning, which drops the previous handle and releases its
ports. So the concurrent `terminate`'s own `stopContainer`/`removeContainer` hit "Container not
found" and were swallowed as best-effort no-ops — the ending cleaned up **nothing**, and the new
child became the only holder of that node's four ports and its workdir.

## What changed

All inside `packages/cadre-host/src/donation/`.

**`donation-service.ts`**

- New module-level `RESPAWNABLE_STATUSES` (`awaiting_seed | seeded`), used for both the entry guard
  and the post-spawn check, so "may this loan come back" is stated once.
- New exported `RespawnResult` union — `respawn` no longer returns `DonationView | undefined`,
  which conflated "abandoned" with "record predates persisted spawn inputs":
  ```ts
  export type RespawnResult =
    | { outcome: 'respawned'; donation: DonationView }
    | { outcome: 'not_respawnable' }
    | { outcome: 'abandoned'; status?: DonationStatus };   // status absent = row is gone
  ```
- The success path re-reads the record after `createContainer` and decides with **no `await` between
  the read and the write** (the store is synchronous, so that pair is atomic against the event loop
  — same discipline as `storeAttempt` and `DonationSupervisor.refillBudgetIfHealthy`). Only the new
  handles and the attempt counters are merged onto the on-disk row.
- New `abandonRespawn`: stops the new child, and **reclaims** it unless the record went `error`.
  Reclaim is the load-bearing part — per the `dropStaleHandle` finding above, merely stopping would
  leak that spawn's ports and workdir. The `error` exception matches `DonationSupervisor.giveUp`,
  which deliberately keeps the workdir; it is defensive only (the supervisor serializes its passes,
  so `giveUp` cannot actually overlap a respawn).

**`donation-supervisor.ts`** — `attemptRespawn` switches on `result.outcome`, logs abandonment
distinctly from not-respawnable, and returns `undefined` for both. Nothing throws on the abandoned
path, so the backoff/give-up path is never entered and no attempt counter is persisted.

**`donation/index.ts`** — exports the `RespawnResult` type.

**Docs** — `docs/cadre-host.md` § Respawn gained a paragraph stating the mid-respawn rule (including
*why* reclaim rather than stop); `docs/STATUS.md` had its "Known gap" sentences replaced with what
now happens.

**Tripwire recorded, not filed as a ticket** — the success path bumps `updatedAt`, and on an
`awaiting_seed` record that is exactly the field the stale-seed reap measures age from, so each
respawn defers that reap. Bounded today (5 attempts, ≤80s backoff ≈ 2.5 minutes against a 30-minute
TTL, then give-up moves the record to `error`). Parked as a `NOTE:` comment at the write site in
`donation-service.ts`, aimed at anyone raising `DONATION_RESPAWN_MAX_ATTEMPTS`.

## Use cases to exercise when reviewing

- **Borrower ends the loan mid-restart.** A donated node crashes; the supervisor starts respawning
  it; the borrower's `DELETE /grants/:id` lands during the spawn. Expected: record stays
  `terminated` with its original handles, the grant's quota slot frees, and the new child is stopped
  *and* removed. No attempt counter is recorded.
- **The 30-minute stale-seed reap fires mid-restart.** Same shape, but the ending comes from
  `reapStaleAwaitingSeed`. Additionally: the record's `updatedAt` must stay at the reap's timestamp,
  not be pushed forward — otherwise the TTL clock restarts and the reap can never converge.
- **Ordinary respawn still works.** New `dockerId` / `seedEndpoint` / `seedToken` written, status
  untouched (`seeded` stays `seeded`, `awaiting_seed` stays `awaiting_seed`), attempt counter
  incremented, nothing stopped or reclaimed.
- **Legacy record with no persisted spawn inputs** → `{ outcome: 'not_respawnable' }`, no
  orchestrator call, sweep keeps going.
- **Supervisor give-up unaffected.** A genuinely failing respawn still counts attempts, backs off,
  and gives up to `error` after 5.

## Validation run

From `packages/cadre-host`:

- `yarn vitest run src/donation` — 4 files, **68 passed**.
- `yarn test` (whole package) — 58 files, **494 passed, 4 skipped**.

From the repo root:

- `yarn typecheck` — clean.
- `yarn lint` — **0 errors**. The 6 warnings it prints are unused `eslint-disable` directives in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, untouched by
  this work and present before it.

## Known gaps — read these before trusting the tests

- **`FakeOrchestrator` does not model `dropStaleHandle`.** In the tests the concurrent `terminate`
  successfully stops and removes the *old* handle, because the fake keeps it alive through the
  in-flight create. Against the real `HostProcessOrchestrator` that cleanup is a no-op, which is the
  entire reason `abandonRespawn` must reclaim. So the tests assert the new child is reclaimed, but
  **nothing in the suite proves the premise** that the ending's own reclaim was lost. A reviewer who
  wants that nailed down should either teach the fake to drop the prior handle on create (matching
  `host-process-orchestrator.ts:230`) or add a real-orchestrator test.
- **No integration coverage.** Nothing drives this race against a real child process, so "ports and
  workdir are actually released" is reasoned, not observed. The donation surface generally is only
  exercised end-to-end by `cadre-host-node-donation.integration.ts`, which does not cover respawn.
- **Two `abandonRespawn` branches are untested**: the record going `error` mid-spawn (skip reclaim),
  and the record vanishing entirely (`{ outcome: 'abandoned' }` with no `status`). Both are
  defensive; neither is reachable through the current callers.
- **The race tests depend on fake timing.** They rely on `orch.onCreate` firing before
  `createDelayMs` elapses and on `terminate`/`reapStaleAwaitingSeed` running synchronously up to
  their first `await`. That holds today, but the tests would silently stop testing the race (and
  still pass) if either changed — they would just become ordinary sequential-ending tests.
- **`respawn`'s "not serialized" caveat is unchanged.** Two overlapping `respawn` calls for one id
  still both spawn. The supervisor serializes its passes, which is the only production caller; this
  ticket did not touch that.
- **Return-shape change is a breaking API change** to `DonationService.respawn`, exported from
  `@serfab/cadre-host`. Per repo policy (no backwards compat yet) no shim was added; the supervisor
  is the only in-repo caller and was updated.
