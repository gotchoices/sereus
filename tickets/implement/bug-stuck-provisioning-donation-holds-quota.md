description: Finish verifying and documenting the fix for donations stuck mid-setup permanently consuming a friend's allowed-machine quota.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, docs/cadre-host.md
difficulty: easy
repro: static
---

# Finish the stuck-`provisioning` reap: verify, document, and spin off the sibling ticket

Continuation of `bug-stuck-provisioning-donation-holds-quota` — the prior
implement pass hit its token budget after landing the code but before running
it or updating docs. **The fix itself is believed complete**; what remains is
verification and cleanup.

## What already landed (do not redo)

- `DonationOrchestrator` interface (extends `Orchestrator` with optional
  `resolveDockerId?(containerId): string | undefined`) in `donation-service.ts`,
  and `DonationServiceOptions.orchestrator` / the private field retyped to it.
  Exported from `donation/index.ts`.
- `DONATION_PROVISIONING_TTL_MS` (5 min) constant, exported from both files.
- `DonationService.reapStaleProvisioning(ttlMs)` + private
  `reclaimStuckProvisioning` + module-private `isStaleProvisioning` predicate,
  mirroring `reapStaleAwaitingSeed`'s shape (re-read-before-write, best-effort
  per record, status written before any orchestrator call).
- `bin/host.ts`'s `reapStale` closure now also calls
  `donationService.reapStaleProvisioning(DONATION_PROVISIONING_TTL_MS)` on the
  same startup+timer trigger as the existing awaiting-seed reap.
- `FakeOrchestrator.resolveDockerId(containerId)` added (looks up its
  `children` map by `containerId`).
- Four new tests in `donation-service.test.ts`, in a new
  `describe('DonationService.reapStaleProvisioning', ...)` block after the
  existing `reapStaleAwaitingSeed` block: reaps a stuck record past TTL and
  marks it `error` (no-`dockerId` case); stops+removes the child when the
  orchestrator can resolve a `dockerId` for the donation id (crash-after-spawn
  case, built via `orch.createContainer(...)` called directly, then a raw
  `store.put` of a `provisioning` row with no `dockerId` — mirroring the
  original ticket's "resource-leak wrinkle"); leaves a fresh (within-TTL)
  record alone; leaves a record alone that legitimately advances to
  `awaiting_seed` between the sweep's snapshot and its per-record re-read
  (built the same way the existing "leaves a loan alone when a seed lands
  mid-sweep" test injects the race, via `FakeOrchestrator.onStop`).

**Not yet done, not attempted:** `docs/cadre-host.md` still says the old,
now-false thing (see below), and nothing has been run to confirm the new code
compiles or the new tests actually pass.

## TODO

Typecheck + run the suite: `yarn workspace @serfab/cadre-host test` (or the
narrower vitest file for just `donation-service.test.ts`) and confirm the
whole suite is green, not just the four new tests. If anything fails, fix it
— the implementation is a considered design carried over from the original
ticket, not a guess, but it has not been executed even once.

One editor diagnostic surfaced during the prior pass that was **not**
resolved: `'DONATION_PROVISIONING_TTL_MS' is declared but its value is never
read` flagged at `donation-service.test.ts:31` (the import line), even though
the constant is referenced by name several times further down in the new
`describe` block. Every other diagnostic seen in that session on `bin/host.ts`
turned out to be stale/lagging (line numbers shifting for a pre-existing,
unrelated `process.exit(1); return;` "unreachable code" warning) rather than
real, so this one may be the same kind of false positive — but it was never
independently confirmed. Re-check with a fresh typecheck; if it's real,
something about the edit did not land as intended.

Update `docs/cadre-host.md`:
- Line ~104 (the `DonationSupervisor` paragraph) currently ends "`provisioning`
  records are therefore never touched" — false now. Rewrite that clause: the
  supervisor still skips `provisioning` records (still true — `provision`
  itself owns the child while a record is in that status), but a *separate*
  stuck-`provisioning` reap now exists for the case where no in-flight
  `provision` call is left to advance it (i.e. after a crash/restart).
- The "ending that lands mid-operation wins" bullet list (~lines 114-119) has
  one bullet each for `respawn`, `applySeed`, the stale-`awaiting_seed` reap,
  and `provision`, each explaining its re-read discipline. Add a parallel
  bullet for the new stuck-`provisioning` reap, matching that list's prose
  style (what it re-reads, and why skipping that would be wrong).
- Line ~123 ("Status of the donation surface") says the `DonationSupervisor`
  is "wired into `bin/host.ts` alongside the stale-`awaiting_seed` reap sweep"
  — update to also mention the stuck-`provisioning` reap now sharing that same
  sweep.

Check whether cadre-provider's sibling bug is already tracked before filing
anything: `ContainerService.provisionContainer` in `packages/cadre-provider/src`
has the same crash-window issue (record written to a provisioning-equivalent
status before the orchestrator call, no reap sweep there at all) and no
`resolveDockerId`-equivalent lookup by containerId to build one on. Per the
ticket workflow's "before you file a ticket" rule, grep first:
`grep -rl "provisionContainer" tickets/backlog tickets/fix tickets/plan
tickets/implement tickets/review`. If nothing open touches it, file a
`debt-` ticket into `tickets/backlog/` describing the gap (same root cause as
this one, different package/quota model) — do not fix it under this ticket,
out of scope for cadre-host.

## End

Do NOT commit — runner handles commits after you complete.
