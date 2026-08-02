description: Fix for donations stuck mid-setup permanently consuming a friend's allowed-machine quota is implemented, tested, and documented — ready for review.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, docs/cadre-host.md
---

# Stuck-`provisioning` reap for donated nodes — implementation complete

## What this fixes

`DonationService.provision` writes a donation record with status
`provisioning` *before* it asks the orchestrator to spawn the child. If
cadre-host crashes or is killed in that window (including mid-spawn), nothing
was left to ever advance that record — no in-flight `provisionLocked` call
remains after a restart, and no existing reap sweep looked at `provisioning`
rows. The record sat in `provisioning` forever, permanently holding one slot
of the grantee's node quota (`GrantValidator.validateForProvision` counts
`provisioning` as live) with no way for the borrower to reclaim it short of a
host operator manually editing `donations.json`.

## What changed

- **`DonationOrchestrator`** (`donation-service.ts`) — extends the base
  `Orchestrator` with an optional `resolveDockerId(containerId): string |
  undefined`. Lets a reap sweep find and reclaim a child that actually got
  spawned before the crash (the record itself never got the `dockerId`
  written). Optional because only `HostProcessOrchestrator` implements it;
  absent on a test double, the reap just terminalizes the record with nothing
  to reclaim.
- **`DONATION_PROVISIONING_TTL_MS`** (5 min) — new constant, same shape as the
  existing `DONATION_AWAITING_SEED_TTL_MS` (30 min). 5 minutes is generously
  past "any plausible spawn" (identity key read/gen, port allocation, process
  spawn — normally well under a second) without false-reaping one genuinely
  in flight under heavy load.
- **`DonationService.reapStaleProvisioning(ttlMs)`** — new public method,
  same shape as `reapStaleAwaitingSeed`: snapshot candidates, re-read each one
  immediately before acting (an in-flight same-process `provisionLocked` call
  can still legitimately advance a record between the snapshot and the write),
  terminalize to `error` with an explanatory message, best-effort per record
  so one failure doesn't stop the sweep.
- **`bin/host.ts`** — the existing `reapStale` closure (already called at
  startup and on a 5-minute timer, per `DONATION_REAP_SWEEP_MS`) now also
  calls `reapStaleProvisioning` alongside the existing
  `reapStaleAwaitingSeed` call. Same trigger, same cadence — no new timer.
- **`FakeOrchestrator.resolveDockerId`** (`__tests__/fake-orchestrator.ts`) —
  looks up its internal `children` map by `containerId`, so the "orchestrator
  can still find the crashed child" test case is exercisable without a real
  orchestrator.
- **`docs/cadre-host.md`** — three spots updated: the `DonationSupervisor`
  paragraph (still skips `provisioning` records, but now explains the
  separate reap that exists for the crash case); the "ending that lands
  mid-operation wins" bullet list gained a bullet for the new reap, matching
  the existing bullets' prose style (re-read discipline, why skipping it would
  be wrong); the "Status of the donation surface" paragraph now mentions the
  stuck-`provisioning` reap sweep alongside the pre-existing
  stale-`awaiting_seed` one.

## Tests — how to exercise this

Four new tests in `donation-service.test.ts`, in
`describe('DonationService.reapStaleProvisioning', ...)`:

1. **Reaps a stuck record past TTL, marks it `error`** — the no-`dockerId`
   case (crash before the orchestrator call ever returned). Asserts nothing
   is stopped/reclaimed (nothing to reclaim) and the quota slot frees
   (`liveNodeCount` drops).
2. **Stops + removes the child when the orchestrator can resolve a
   `dockerId`** — the resource-leak case from the original ticket (crash
   *after* the orchestrator spawned the child but *before*
   `provisionLocked` wrote the `dockerId` back onto the record). Built by
   calling `orch.createContainer(...)` directly, then a raw `store.put` of a
   `provisioning` row with no `dockerId` — simulating exactly that crash
   window. Asserts `stopped`/`removed` both contain the orchestrator's
   `dockerId`.
3. **Leaves a fresh (within-TTL) record alone.**
4. **Leaves a record alone that legitimately advances between the sweep's
   snapshot and its per-record re-read** — injects the race via
   `FakeOrchestrator.onStop`, mirroring how the existing
   `reapStaleAwaitingSeed` race test is built. Confirms the re-read discipline
   actually does something, not just that it's present in the code.

Run: `yarn workspace @serfab/cadre-host test` (whole suite — confirmed below,
not just these four).

## Verification done this pass

- `yarn workspace @serfab/cadre-core build` — cadre-host's tests run compiled
  `cadre-core` output and were blocked by a stale-build guard; rebuilt clean.
- `yarn workspace @serfab/cadre-host test` — **60 test files passed, 516
  tests passed, 4 skipped** (the 4 skips are pre-existing/unrelated to this
  change — not introduced here).
- `yarn workspace @serfab/cadre-host typecheck` (`tsc --noEmit` on both the
  server and UI tsconfigs) — clean, no output.
- `yarn eslint` on all five touched files — clean, no output.

The prior implement pass had flagged one open question: an editor diagnostic
claiming `DONATION_PROVISIONING_TTL_MS` was "declared but never read" at the
test file's import line, despite it clearly being used later in the file. A
clean `tsc --noEmit` this pass confirms that was a stale/false-positive editor
diagnostic, not a real problem — same conclusion as the other diagnostics from
that session (which turned out to be a lagging line number on an unrelated,
pre-existing warning in `bin/host.ts`).

## Known gaps / things the reviewer should look at with fresh eyes

- **No integration-level coverage.** The `donation-service.test.ts` suite
  exercises `reapStaleProvisioning` only against `FakeOrchestrator` — no real
  child process, no real crash/restart. The cross-package integration
  scenario (`cadre-host-node-donation.integration.ts`, per
  `docs/cadre-host.md` § Status of the donation surface) does not cover this
  reap at all. If a reviewer wants higher confidence on the real
  `HostProcessOrchestrator.resolveDockerId` implementation specifically
  (not exercised by any test in this pass — only the fake's version is), that
  would be the place to add it.
- **`reapStaleProvisioning`'s TTL is a hardcoded module constant**, same as
  its `awaiting_seed` sibling — not operator-configurable. Consistent with
  existing precedent, not a new gap, but worth knowing if a reviewer expects
  `host.config.json` tunability.
- **`resolveDockerId` is a linear scan** over `FakeOrchestrator`'s internal
  `children` map (fine for a test double) — the real
  `HostProcessOrchestrator` implementation was not touched or reviewed as
  part of this ticket (it predates this change; see the ticket's `files:`
  list, which does not include the orchestrator implementation itself). Worth
  a reviewer's independent look if its performance/correctness at scale
  matters.
- **A sibling bug in `cadre-provider` was found but is explicitly out of
  scope for this ticket** (cadre-host only). Filed as
  `tickets/backlog/debt-cadre-provider-stuck-provisioning-quota.md` — grepped
  first and confirmed nothing else open touches
  `ContainerService.provisionContainer`. Not fixed, not reproduced against
  cadre-provider directly — filed as forward-looking debt based on code-shape
  similarity, not an observed incident.

## Review findings

(none yet — this section is for the review stage to fill in)
