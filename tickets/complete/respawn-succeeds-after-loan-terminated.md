---
description: When someone ends their borrowed node while the host is restarting that node after a crash, the ending now wins — the record stays ended and the half-started replacement is shut down and cleaned up.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, docs/cadre-host.md, docs/STATUS.md
---

# Ending a loan mid-restart wins over the restart

## What shipped

`DonationService.respawn` used to read the donation record at entry, spend seconds inside
`orchestrator.createContainer(...)`, then write back a whole row built from that entry-time copy.
`DonationStore.put` replaces the whole row, so a `terminated` write landing during the spawn was
silently overwritten: the ended loan came back, kept holding a grant quota slot, and the freshly
spawned child was left running with nothing tracking it. Worse, the real
`HostProcessOrchestrator.createContainer` calls `dropStaleHandle(containerId)` *while* spawning, so
the concurrent `terminate`'s own stop/reclaim hit "Container not found" and cleaned up nothing.

The fix, all inside `packages/cadre-host/src/donation/`:

- `respawn` re-reads the record after `createContainer` and decides with **no `await` between the
  read and the write** — the store is synchronous, so that pair cannot be interleaved. Only the new
  handles and the attempt counters are merged onto the on-disk row.
- New `RespawnResult` union (`respawned` / `not_respawnable` / `abandoned`) replaces
  `DonationView | undefined`, which conflated "abandoned" with "record predates persisted spawn
  inputs". Exported from `@serfab/cadre-host`. Breaking API change; no shim, per repo policy.
- New private `abandonRespawn` stops the new child and **reclaims** it unless the record went
  `error`. Reclaim is load-bearing: merely stopping would leak that spawn's ports and workdir,
  because the ending's own cleanup already found nothing.
- `DonationSupervisor.attemptRespawn` switches on the outcome; the abandoned path throws nothing, so
  no attempt counter is persisted and the backoff/give-up path is never entered.
- `docs/cadre-host.md` § Respawn and `docs/STATUS.md` updated.

## Review findings

### Checked

Read the implement diff (`166480d`) before the handoff summary, then the full
`donation-service.ts`, `donation-supervisor.ts`, `donation-store.ts`, `fake-orchestrator.ts`, and
`host-process-orchestrator.ts` — the last to verify the diff's central premise about
`dropStaleHandle` rather than take it on trust. Confirmed: `dockerId` is
`encodeDockerId(pid, token)`, unique per spawn, and `dropStaleHandle` runs synchronously inside
`createContainer` before `launchChild`, so the premise holds exactly as stated.

Traced every interleaving of `respawn` against `terminate` / `reapStaleAwaitingSeed` /
`applySeed` / `giveUp`, including endings landing *before* `dropStaleHandle` (converges — the
respawn re-keys the workdir and then reclaims it) and store-read failures in the re-read window
(unreachable: `DonationStore` caches, so `get` cannot throw after a successful earlier `load`).
Verified the `return this.abandonRespawn(...)` inside `try` cannot reject, so the JS gotcha where a
returned promise's rejection bypasses the enclosing `catch` is harmless here.

Docs: read both changed sections in full plus the surrounding `§ Respawn` prose and the STATUS
donation checklist. No other doc names `respawn`'s return type.

Ran from `packages/cadre-host`: `yarn vitest run src/donation` — 4 files, **70 passed** (68 before,
+2 added below). `yarn test` — 58 files, **496 passed, 4 skipped**. From the repo root:
`yarn typecheck` clean; `yarn lint` **0 errors**. The 6 lint warnings are unused `eslint-disable`
directives in `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`,
untouched by this work and present before it. No pre-existing failures surfaced, so no
`.pre-existing-error.md` was written.

### Fixed in this pass (minor)

- **`abandonRespawn`'s docstring justified the `error` branch with a claim that is false.** It said
  skipping the reclaim matches `giveUp`, "which keeps the workdir so a later `terminate` can still
  reclaim the same node". A later `terminate` cannot: the `error` record still names the *previous*
  `dockerId`, so it cleans up the old handle and the new spawn's four ports leak permanently. The
  behaviour is still right — both spawns share one workdir (`<rootDir>/<containerId>`), so
  reclaiming would delete exactly the identity key `giveUp` means to keep — but the reasoning was
  wrong. Rewrote it to state the real reason, and parked the leak as a tripwire (below). Corrected
  the same claim in `docs/cadre-host.md` § Respawn.
- **Added the two missing `abandonRespawn` tests** the handoff flagged as untested: the record going
  `error` mid-spawn (child stopped, *not* reclaimed, record keeps its old `dockerId`) and the record
  vanishing entirely (`{ outcome: 'abandoned' }` with no `status`, child stopped and reclaimed).
  Both drive the concurrent write from `FakeOrchestrator.onCreate`, matching the existing race tests.

### Filed as new tickets (major)

- **`tickets/fix/seed-write-resurrects-ended-loan.md`** — the bug this ticket fixed in `respawn` is
  still live in `DonationService.applySeed`, and it is reachable in normal operation. `applySeed`
  checks the status on its entry read, `await`s a `fetch` to the node, then writes
  `{ ...donation, status: 'seeded' }` from that entry-time copy. The stale-seed reap runs on a
  5-minute timer and targets precisely `awaiting_seed` records, so a borrower seeding near the
  30-minute TTL collides with it; `PUT /grants/:id/seed` and `DELETE /grants/:id` are also
  unserialized against each other. The consequences are worse than a stale field: the record returns
  to a *live* status (re-consuming the grant's quota), names a `dockerId` whose workdir `terminate`
  already deleted, and the supervisor then respawns it — fully reviving an ended loan.
  `provisionLocked` has the same shape with a much narrower window; the ticket covers both.
- **`tickets/backlog/debt-fake-orchestrator-handle-fidelity.md`** — `FakeOrchestrator` models
  neither `dropStaleHandle` nor `requireHandle`'s "Container not found" throw, so the concurrent
  `terminate` in the new race tests *succeeds* at cleaning up the old handle. The tests therefore
  assert the correct end state while nothing in the suite demonstrates the premise that made the
  reclaim necessary. The handoff disclosed this honestly; making the fake faithful is real work
  (several existing assertions in both donation test files would break and need re-deriving), so it
  is a ticket rather than an inline fix.

### Recorded as tripwires, not tickets

- **The `error` branch of `abandonRespawn` leaks the new spawn's four ports.** Unreachable today —
  `giveUp` is only reached from the supervisor's serialized pass, so it cannot overlap a respawn.
  Becomes real only if a second `respawn` caller ever appears. Parked as a `NOTE:` at the branch in
  `donation-service.ts`, with the remedy named (write the new `dockerId` onto the `error` record so
  the later `terminate` reclaims the right child).
- **The implementer's own tripwire, verified and left in place**: the success path bumps
  `updatedAt`, which on an `awaiting_seed` record is the field the stale-seed reap measures age
  from, so each respawn defers that reap. Bounded today (5 attempts, ≤80s backoff ≈ 2.5 minutes
  against a 30-minute TTL, then give-up moves the record to `error`). The `NOTE:` sits at the write
  site and is aimed at anyone raising `DONATION_RESPAWN_MAX_ATTEMPTS` — the right place and the
  right audience.

### Looked at and deliberately left alone

- **`RESPAWNABLE_STATUSES` (service) and `SUPERVISED_STATUSES` (supervisor) are the same two-element
  set with near-identical rationale comments.** Not consolidated: they answer different questions
  ("may this loan come back" vs "does the supervisor watch this record"), and `LIVE_STATUSES` in
  `donation-store.ts` is a third, deliberately wider set. Collapsing them would couple three
  independent policies for a two-line saving.
- **`respawn`'s "not serialized" caveat.** Two overlapping `respawn` calls for one id still both
  spawn. Unchanged by this work, correctly documented on the method, and the supervisor — the only
  caller — serializes its passes.
- **The race tests' dependence on fake timing** (`onCreate` firing before `createDelayMs` elapses;
  `terminate` running synchronously to its first `await`). Flagged in the handoff. It holds today,
  and hardening it would mean the same fake rework the fidelity ticket above already covers.

### Not covered

- **No integration coverage of this race.** Nothing drives it against a real child process, so
  "ports and workdir are actually released" remains reasoned rather than observed. Out of scope for
  a review pass; the fidelity ticket names the real-orchestrator option.
