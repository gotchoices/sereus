---
description: The code that restarts a donated machine after it crashes has been reviewed; two last-write-wins bugs were fixed here and a third, harder one filed as its own ticket.
files: packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/bin/host.ts, docs/cadre-host.md, docs/STATUS.md
---

# Donated-node respawn supervisor — complete

Closes `16.5-donated-node-respawn-supervisor` / `16.6-donated-node-respawn-supervisor-finish` /
`donated-node-respawn-supervisor-finish`.

## What shipped

`DonationSupervisor` (`packages/cadre-host/src/donation/donation-supervisor.ts`) owns the invariant
*a non-terminal donation is expected to be running*. A donated node is a child process on a
stranger's home PC — it can crash, be OOM-killed, or die in a reboot — and nothing else in
cadre-host brings it back.

- Supervises only donations with status `awaiting_seed` or `seeded` **and** an orchestrator handle
  (`dockerId`). `provisioning` belongs to the in-flight provision; `error` and `terminated` are
  terminal.
- One `reconcile()` pass behind three triggers — host startup, an orchestrator exit event, and a
  1-minute sweep — serialized through a tail promise so no id is double-spawned.
- Exponential backoff per id (10s before the first retry, doubling) and give-up after 5 consecutive
  failures, at which point the record becomes `error` (freeing the grant's quota) and the child is
  stopped but not removed, preserving its workdir/identity key for a later `terminate()`.
- Refills a donation's attempt budget once it has stayed up 10 minutes past a respawn, without
  touching `updatedAt` (that field is the stale-`awaiting_seed` reap's clock).

Wired into `packages/cadre-host/src/bin/host.ts` alongside `donationService` (both sharing one
hoisted `donationStore`), started after `orchestrator.init()`, stopped next to
`clearInterval(reapTimer)`. Documented in `docs/cadre-host.md` § "Respawn (keeping a donated node
up)"; `docs/STATUS.md`'s respawn bullet is `[x]` with the one known gap named.

## Review findings

Read the implement diffs (`a01b1e8`, `d3511f8`) before the handoff summary. Everything below is
what the review pass turned up; empty categories are called out as empty.

### Fixed in this pass (minor)

- **`DonationSupervisor.refillBudgetIfHealthy` wrote back a stale snapshot.** `reconcileOnce`
  snapshots the store once per pass and then awaits per record; `DonationStore.put` replaces the
  whole row. A borrower's seed landing mid-pass would therefore be undone — the record reverted to
  `awaiting_seed` with an old `updatedAt`, so the stale-`awaiting_seed` reap could later terminate a
  live, seeded loan. Now re-reads the record and re-checks before writing. The staleness predicate
  is factored out as `budgetRefillDue`, which also documents why an unparsable timestamp means
  *not* due here (erasing real attempt history) while it means *eligible* in `backoffElapsed`
  (never wedge a node on bad data). Regression test: "does not undo a seed that lands while the
  pass is mid-flight".
- **`DonationService.storeAttempt` had the same defect on the respawn failure path**, and it was
  worse: it wrote the entry-time copy of the whole row back after a failed spawn, so a `terminate`
  that landed during the spawn was silently resurrected as `seeded`. Now merges only the attempt
  counters onto whatever is on disk. (This file was not in the implement diff, but the supervisor is
  its first production caller — the race was unreachable until this ticket.)
- **`DonationSupervisor.giveUp` could rewrite a terminal record as `error`.** It re-read the record
  but did not re-check its status, so a loan the borrower ended mid-attempt would have the host's
  give-up reason written over it, and `stopContainer` fired against a child `terminate` had already
  reclaimed. Now bails when the record is no longer in a supervised status. Regression test: "leaves
  a record that went terminal mid-attempt alone instead of marking it error".
- **Backoff documentation was wrong.** `DONATION_RESPAWN_BACKOFF_BASE_MS` was described as the wait
  before the first retry; the actual first-retry wait is `base * 2^1` = 10s, because one attempt is
  already recorded by then. Corrected in the constant's docstring and in `docs/cadre-host.md`.

### Filed as a new ticket (major)

- **`tickets/fix/respawn-succeeds-after-loan-terminated.md`** — the *success* half of the same
  last-write-wins family: `DonationService.respawn` writes a row built from its entry-time copy after
  the spawn returns, so a `terminate` landing during that spawn is overwritten. Result: an ended loan
  reads live again, holds grant quota, and the freshly spawned child is orphaned (the terminate
  stopped and removed only the *old* handle). Reachable from both the borrower's `DELETE /grants/:id`
  and the 5-minute stale-`awaiting_seed` reap racing the 1-minute supervisor sweep. Not fixed inline
  because a correct fix has to decide the fate of the child it just spawned — reclaiming a workdir
  destroys the node identity key, so the unwinding needs its own design and tests.

### Recorded as tripwires (conditional — deliberately not tickets)

- **`DONATION_RESPAWN_BACKOFF_MAX_MS` is currently dead configuration.** The 5-minute ceiling never
  clamps anything: with a 5-attempt budget the longest wait actually served is `5s * 2^4` = 80s, and
  the cap only starts doing work once a record can reach 6 recorded attempts. Someone raising the
  attempt cap and expecting the ceiling to matter would be surprised. Parked as a `NOTE:` on the
  constant in `donation-supervisor.ts` and reflected in the `docs/cadre-host.md` wording.
- The implementer's existing `NOTE:` on `giveUp()` — an `error`-after-give-up record keeps its
  workdir until someone calls `terminate()` — was checked and left in place. It is the right shape
  (conditional on stale `error` workdirs actually piling up) and duplicates
  `backlog/debt-failed-respawn-strands-donated-workdir`, which stays the tracked home for the
  broader leak.

### Tests added

The implementer's 12 cases covered the happy paths, backoff, give-up, and the trigger wiring. Added
4 more for gaps in the error/edge/interaction directions:

- a `provisioning` record is left alone (the handoff claimed this was covered; it was not — the
  three "skip" cases were terminated / no-spawn-inputs / no-`dockerId`);
- the mid-pass seed regression above;
- the mid-attempt terminate regression above;
- a pass over a store whose `list()` throws (malformed `donations.json`) resolves empty instead of
  escaping as an unhandled rejection from the timer.

`FakeOrchestrator` gained `onCreate` / `onIsRunning` observation hooks, mirroring the existing
`onStop`, so a test can mutate the store mid-`await` without real concurrency.

### Checked and found clean

- **Serialization.** The tail-promise chain in `reconcile()` swallows outcomes correctly (a failed
  pass defers rather than rejects the next caller), and the `exitPassQueued` coalescing cannot wedge
  — the flag clears in a `finally`, and the 1-minute sweep is the backstop for any exit event dropped
  during a crash storm.
- **`bin/host.ts` wiring.** Constructed after `orchestrator.init()` (so re-attached children are
  visible to the startup sweep), `stop()`ped before `server.stop()` and `stopOwnerNode()`, so
  shutdown-time child exits cannot trigger a respawn. Both `donationService` and the supervisor share
  one `DonationStore` instance — required, since the store caches the file in memory; two instances
  would have produced genuine split-brain writes.
- **Owner-node exits** are correctly ignored (`info.owner === true`); `bin/host.ts` owns that one.
- **Resource cleanup.** Timer `unref()`ed and cleared, listener unsubscribed, `disposed` flag lets an
  in-flight pass abandon its remaining records. Nothing else to release.
- **Type safety.** No `any`, no non-null assertions; `SupervisedOrchestrator` narrows the shared
  `Orchestrator` with cadre-host's own `onStateChange` rather than casting.
- **Source hygiene.** `donation-supervisor.ts` is ~370 lines, every method single-purpose and named
  for its job; comments explain *why* (ordering, workdir preservation) rather than restating code.
  No DRY violations found — `FakeOrchestrator` was already deduplicated out of
  `donation-service.test.ts` by the implement pass.
- **Docs.** Read `docs/cadre-host.md` § Node donation and `docs/STATUS.md` § cadre-host in full
  against the code. Both were accurate apart from the backoff wording fixed above; `docs/STATUS.md`
  now also names the filed race. No other doc mentions donation respawn.

### Not resolved, deliberately

- **No real-child coverage.** Every supervisor test runs against `FakeOrchestrator`; nothing proves a
  real respawned child rejoins the borrower's cadre end-to-end. That belongs to
  `packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`, which does not
  yet exercise a mid-loan crash. Carried forward from the implement handoff, unchanged — the
  scenario extension is out of scope for a review pass, and the gap is stated in `docs/STATUS.md`.
- **Startup-sweep / stale-reap interleaving** is still reasoned about rather than tested. The
  reasoning in the implement handoff (that `respawn` re-reads and refuses a non-supervised status)
  turned out to be only half true — it re-reads at entry but not after the spawn — which is exactly
  the filed ticket. With that fixed, an interleaving test belongs there, not here.
- **Whether the tuning numbers should be operator-configurable** (5 attempts, 10-minute healthy
  window, 60s sweep) was on the suggested-review-focus list. Left as module constants, matching
  `DONATION_AWAITING_SEED_TTL_MS` next door, which carries the same "promote to `host.config.json` if
  hosts need to tune it" note. No evidence yet that any host does.
- **`supervisor.stop()` mid-pass abandonment** has no direct test. The `disposed` flag is checked at
  the top of each record's iteration; asserting it needs a hook purely for the test's benefit, and
  the failure mode (a pass finishing one record too many during shutdown) is harmless — the next
  start's sweep is authoritative.

## Validation

- `yarn workspace @serfab/cadre-host build` — clean (tsc + vite).
- `yarn workspace @serfab/cadre-host test` — 58 files passed, **491 passed / 4 skipped** (was
  487 passed before the 4 added cases).
- `yarn lint` — 0 errors. 6 warnings, all pre-existing unused `eslint-disable` directives in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, untouched and
  unrelated.
