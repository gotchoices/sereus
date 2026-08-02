description: A donation that got stuck halfway through setup used to hold one of a friend's allowed-machine slots forever; the host now automatically clears those out and frees the slot.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, docs/cadre-host.md, docs/STATUS.md
---

# Stuck-`provisioning` reap for donated nodes — complete

## The bug

`DonationService.provision` writes a donation record with status `provisioning`
*before* it asks the orchestrator to spawn the child. If cadre-host crashed or
was killed inside that window (including mid-spawn), nothing ever advanced the
record again: no in-flight `provisionLocked` call survives a restart, and no
existing sweep looked at `provisioning` rows. The record sat in `provisioning`
forever, permanently consuming one slot of the grantee's node quota
(`DonationStore.liveNodeCount` counts `provisioning` as live), with no recovery
short of a host operator hand-editing `donations.json`.

## What shipped

- `DonationService.reapStaleProvisioning(ttlMs)` — sweeps `provisioning` rows
  older than `DONATION_PROVISIONING_TTL_MS` (5 min), writes each `error` (which
  drops it out of the live-node tally, freeing the quota slot), and stops +
  reclaims the child when the orchestrator can still resolve one. Best-effort
  per record.
- `DonationOrchestrator` — `Orchestrator` plus an optional
  `resolveDockerId(containerId)`, so the sweep can find a child that was
  actually spawned before the crash (the record never got its `dockerId`
  written). `HostProcessOrchestrator` already had that method.
- `bin/host.ts` — the existing `reapStale` closure (startup + 5-minute timer)
  now calls the new sweep alongside `reapStaleAwaitingSeed`. No new timer.
- `FakeOrchestrator.resolveDockerId` for the unit tests.
- Docs: `docs/cadre-host.md` (supervisor paragraph, the "ending that lands
  mid-operation wins" bullet list, donation-surface status) and `docs/STATUS.md`.

## Review findings

**Diff read first, from the commits (`637dad7`, `58f1d32`), before the handoff
summary.** Everything below was checked against the source, not the summary.

### Correctness / concurrency — checked, nothing wrong found

- **Re-read discipline is genuinely atomic.** The sweep re-reads each record and
  then calls `reclaimStuckProvisioning`, whose first statement is the terminal
  `store.put`. `await f()` invokes `f` synchronously, and `DonationStore` is
  synchronous by design (its own docstring makes that a correctness
  requirement), so nothing can interleave between the decision and the write.
  The claim in the code comment holds.
- **Write-status-before-reclaim** matches `terminate`'s ordering rule, so a
  `DonationSupervisor` listening on `onStateChange` sees a terminal record and
  will not try to respawn. `error` is outside `SUPERVISED_STATUSES` and
  `RESPAWNABLE_STATUSES`.
- **Quota actually frees**: `LIVE_STATUSES` excludes `error`; asserted directly
  by two of the new tests via `store.liveNodeCount`.
- **Reap racing a genuinely slow in-flight provision** (past the 5-min TTL)
  resolves safely in both interleavings: `provisionLocked`'s own post-spawn
  re-read sees the non-`provisioning` record, reclaims its child, and throws
  `invalid_state` (409 to the grantee). Transient over-quota by one is possible
  in that window and self-heals — same shape as the pre-existing
  `awaiting_seed` reap, not a regression.
- **`resolveDockerId` semantics verified against the real implementation**
  (`host-process-orchestrator.ts:214`), not just the fake: donation ids are
  friendly `containerId`s, never dockerIds, so the containerId branch is the one
  that fires; a re-attached-but-dead handle still stops and reclaims cleanly
  (ports released, workdir removed — correct here, since the workdir was created
  by the very spawn being abandoned).
- **Sweep wiring order** in `bin/host.ts` is right: `orchestrator.init()` runs
  before the service is built and before the startup sweep, so re-attached
  handles are resolvable on the first pass. The two sweeps operate on disjoint
  statuses, so running them concurrently is safe.

### Fixed inline (minor)

- `donation-service.test.ts` header docstring listed the suite's coverage and
  had not been updated for the new reap. Fixed.
- `docs/STATUS.md` donation checklist mentioned only the stale-`awaiting_seed`
  reap. Added an entry for the stuck-`provisioning` reap, including the
  unit-tests-only coverage caveat.

### Tripwire recorded (not a ticket)

- The reclaim can only reach a child the orchestrator holds a handle for.
  `HostProcessOrchestrator.launchChild` spawns and persists in one synchronous
  step, so the only miss is a host death between the OS spawn and that write —
  an orphan process whose record gets terminalized but whose ports stay held
  until a reboot. Microscopic today; becomes real only if an async step is ever
  added between spawn and persist. Parked as a `NOTE:` on
  `DonationService.reclaimStuckProvisioning`.

### Considered and deliberately left alone

- **`resolveDockerId` is optional on `DonationOrchestrator`**, while the
  sibling `SupervisedOrchestrator` declares its extra member required. Every
  implementor in the repo (`HostProcessOrchestrator`, `FakeOrchestrator`, the
  route-test stubs) has it, so requiring it would type-check today — but the
  optional form keeps a bare cross-package `Orchestrator` usable as a donation
  test double, and the degraded path (terminalize, reclaim nothing) is correct
  rather than merely tolerated. Not worth the churn.
- **TTL is a hardcoded module constant**, not `host.config.json`-tunable —
  identical to `DONATION_AWAITING_SEED_TTL_MS`, which already carries a `NOTE:`
  saying to promote both if hosts need to tune them. No new gap.
- **No integration-level coverage** of a real crash/restart, so the real
  `HostProcessOrchestrator.resolveDockerId` is exercised by no test on this
  path. Not filed: there is no defective code site to name, the identical gap is
  already documented for `DonationSupervisor`, and it is now stated in
  `docs/STATUS.md` where the next reader of the donation surface will meet it.

### Empty categories

- **No new tickets filed.** Nothing found rose to major: no incorrect behavior,
  no missing cleanup, no type-safety hole.
- **No source-hygiene findings.** `donation-service.ts` grew 89 lines to 836;
  the new method mirrors its `awaiting_seed` sibling in shape and length, the
  reclaim step is factored into its own short private method, and the staleness
  predicate is stated once and applied twice (matching `isReapable`). No
  duplication introduced, no function needing a split.
- **No security findings.** The change touches no secret, no wire surface, and
  no trust decision — the reaped record's `seedToken` is redacted by the same
  `redact` as every other view.

## Verification

- `yarn workspace @serfab/cadre-host test` — **60 test files passed, 516 tests
  passed, 4 skipped**. The 4 skips pre-date this change.
- `yarn eslint` on all five touched source files — clean.
- The stale-build guard demanded a rebuild of the linked `../quereus` workspace
  (`@quereus/quereus` dist stale, unrelated to this ticket); rebuilt, then the
  suite ran green. No pre-existing test failures surfaced, so no
  `tickets/.pre-existing-error.md` was written.
- Post-review edits were comment- and docs-only (one JSDoc `NOTE:`, one test
  docstring, one `docs/STATUS.md` entry) — no executable code changed after the
  green run.

## Follow-on already on the board

`tickets/backlog/debt-cadre-provider-stuck-provisioning-quota.md` — the same
crash window exists in cadre-provider's `ContainerService.provisionContainer`.
Filed by the implement stage; confirmed still present and untouched by this
ticket, which is cadre-host only.
