description: If the lending computer is shut down at the exact moment it is setting up a machine for a friend, that half-finished loan is remembered forever and permanently uses up one of the friend's allowed machines.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts
difficulty: easy
repro: static
---

# A donation stuck mid-setup permanently consumes the requester's quota

Investigation complete (root cause + fix design below); this ticket carries
straight into implementation to save a re-investigation pass.

## Root cause

`DonationService.provisionLocked` (`packages/cadre-host/src/donation/donation-service.ts:194`)
writes a `status: 'provisioning'` row to `donations.json` (line 220) *before*
calling `this.orchestrator.createContainer(...)` (line 227). `LIVE_STATUSES` in
`donation-store.ts:16` counts `provisioning` against the grant's quota
(`liveNodeCount`, `donation-store.ts:154`).

If the host process dies anywhere in that window — before the spawn starts, or
mid-spawn while `createContainer` is still running — nothing ever advances the
row: there is no in-flight `provisionLocked` call left to reach its post-spawn
re-read (line 247) after a restart. Two existing sweeps don't catch it either:

- `DonationService.reapStaleAwaitingSeed` (line 601) only matches
  `status === 'awaiting_seed'` (`isReapable`, line 728).
- `DonationSupervisor`'s `SUPERVISED_STATUSES` (`donation-supervisor.ts:55`) is
  `awaiting_seed` / `seeded` only — `reconcileOne` (line 226) explicitly skips
  any record with no `dockerId`, reasoning "`provision` owns that record until
  it writes one" (line 227-229). That reasoning is correct *within* one process
  lifetime but silently false across a restart, which is the actual bug.

Confirmed by static read of both files; no runtime repro executed (budget
ran out mid fix-stage — see BUDGET_WARNING note in prior tool output). The
control flow above is unambiguous, so `repro: static` here is high-confidence,
but do add the reproducing test described below before trusting the fix.

## Resource-leak wrinkle worth understanding before coding

`HostProcessOrchestrator.createContainer` (`host-process-orchestrator.ts:242`)
spawns the child `detached: true` + `child.unref()` (line 501/524), so if the
crash lands *after* `launchChild`'s synchronous `this.handles.set(...)` +
`this.persist()` (line 550-551) but before `createContainer` returns to
`donation-service`, the child process **survives the host's death** and gets
correctly re-attached by `HostProcessOrchestrator.init()` on the next start
(`host-process-orchestrator.ts:158`, matched by pid + `.startup-token` file).
That live child is tracked by the orchestrator (by `dockerId`, keyed off the
handle map) but the donation record has no `dockerId` to look it up by — the
donation service's own `store.put` that would have written it never ran.

So a full fix needs a way to resolve the orchestrator's handle by the
donation's `id` (which is always used as the spawn's `containerId` — see
`provisionLocked`'s `containerId: id` at line 227 and `respawn`'s at line 480)
rather than by `dockerId`. `HostProcessOrchestrator` already has exactly this:
`resolveDockerId(idOrDockerId): string | undefined` at
`host-process-orchestrator.ts:214` — it is not currently exposed on the
`Orchestrator` interface DonationService holds (`@serfab/cadre-provider`'s
`Orchestrator`, cross-package, has no containerId-keyed lookup — confirmed by a
research pass: `cadre-provider`'s `ContainerService`/`DockerOrchestrator` have
the *same* latent bug and no such lookup either; out of scope here, don't fix
that package — file a `debt-` backlog ticket noting the sibling bug if none
already covers it, no need to block this ticket on that).

Nothing needs to change in `host-process-orchestrator.ts` — `resolveDockerId`'s
existing signature already matches what's needed. Only its exposure to
`DonationService` needs adding.

## Design

**1. Widen the orchestrator type `DonationService` holds** (`donation-service.ts`,
near `DonationServiceOptions`, line ~133): add a small interface

```ts
/**
 * Orchestrator capability `reapStaleProvisioning` needs beyond the base
 * `Orchestrator`: resolve a spawn's friendly containerId (== a donation's id)
 * back to its current dockerId, so a stuck-`provisioning` reap can find and
 * reclaim a child that was actually spawned before the host died. Optional —
 * only `HostProcessOrchestrator` implements it (see its `resolveDockerId`).
 * Absent on a test double or a future orchestrator, the reap just terminalizes
 * the record with nothing to reclaim.
 */
export interface DonationOrchestrator extends Orchestrator {
  resolveDockerId?(containerId: string): string | undefined;
}
```

Change `DonationServiceOptions.orchestrator` and the private field's type from
`Orchestrator` to `DonationOrchestrator`. `HostProcessOrchestrator.resolveDockerId`
already satisfies this exactly (no change needed there). Export
`DonationOrchestrator` from `donation/index.ts` alongside the existing
`DonationServiceOptions` type export.

**2. New TTL constant**, next to `DONATION_AWAITING_SEED_TTL_MS` (line 58):

```ts
/**
 * Default age after which a donation still stuck in `provisioning` is
 * auto-terminated: the host wrote the row before starting the child, and a
 * crash/kill in that window (or during the spawn itself) leaves nothing to
 * advance it across a restart. A real spawn (identity key read/gen, port
 * allocation, process spawn) completes in well under a second normally, so 5
 * minutes is generously past "any plausible spawn" without risking a false
 * reap of one still genuinely in flight under heavy load.
 */
export const DONATION_PROVISIONING_TTL_MS = 5 * 60 * 1000;
```

**3. New method** `DonationService.reapStaleProvisioning`, mirroring
`reapStaleAwaitingSeed`'s shape (same file, after it, ~line 622):

```ts
async reapStaleProvisioning(ttlMs: number = DONATION_PROVISIONING_TTL_MS): Promise<string[]> {
  const cutoff = this.now().getTime() - ttlMs;
  const stale = this.store.list().filter((d) => isStaleProvisioning(d, cutoff));
  const reaped: string[] = [];
  for (const donation of stale) {
    try {
      // Re-read: an in-flight (same-process) provisionLocked call can still
      // advance this exact record between the snapshot above and now.
      const current = this.store.get(donation.id);
      if (!isStaleProvisioning(current, cutoff)) continue;
      await this.reclaimStuckProvisioning(current);
      reaped.push(donation.id);
      log('reaped stuck provisioning donation %s (age > %dms)', donation.id, ttlMs);
    } catch (err) {
      log('failed to reap stuck provisioning donation %s: %s', donation.id, errorMessage(err));
    }
  }
  return reaped;
}

/**
 * Terminalize a stuck-`provisioning` record as `error` and reclaim any child
 * the orchestrator can still find for it. Status is written FIRST (same
 * ordering rule as `terminate()`): reclaiming fires `onStateChange`, and
 * anything listening must already see a terminal record.
 */
private async reclaimStuckProvisioning(donation: Donation): Promise<void> {
  this.store.put({
    ...donation,
    status: 'error',
    error: 'stuck in provisioning past TTL — host likely restarted mid-spawn',
    updatedAt: this.now().toISOString(),
  });
  const dockerId = this.orchestrator.resolveDockerId?.(donation.id);
  if (dockerId) {
    await this.safeStop(dockerId);
    await this.safeReclaim(dockerId);
  }
}
```

And the shared predicate (next to `isReapable`, ~line 728):

```ts
/** Whether a record is still a stuck-`provisioning` reap candidate. */
function isStaleProvisioning(donation: Donation | undefined, cutoff: number): boolean {
  return donation?.status === 'provisioning' && Date.parse(donation.updatedAt) < cutoff;
}
```

Note `updatedAt` equals `createdAt` for a genuinely-stuck row — `provisionLocked`
never touches a `provisioning` record again except to advance it to
`awaiting_seed` or `error`, both of which take it out of this predicate.

Full reclaim is deliberately the same treatment `provisionLocked`'s own
in-flight-abandon branch already gives an orphaned spawn (line 259,
`safeReclaim`, not merely stop) — there is no borrower expectation tied to a
provision request whose HTTP call never returned, so nothing about the
workdir/identity-key is worth preserving, unlike the `error`-after-give-up case
in `donation-supervisor.ts`'s `giveUp` (which deliberately keeps the workdir).

**4. Wire into `bin/host.ts`** (~line 325, the existing `reapStale` closure):
extend it to also call `donationService.reapStaleProvisioning(DONATION_PROVISIONING_TTL_MS)`,
same try/catch-and-log pattern, on the same timer/startup trigger as the
existing `reapStaleAwaitingSeed` call. Import `DONATION_PROVISIONING_TTL_MS`
alongside the existing `DONATION_AWAITING_SEED_TTL_MS` / `DONATION_REAP_SWEEP_MS`
imports.

**5. Test double**: `packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts`'s
`FakeOrchestrator` needs a `resolveDockerId(containerId): string | undefined`
that looks up its `children` map by `containerId` (it already stores
`containerId` per child at line 26/56) — needed so a test can assert the reap
actually reclaims a "the child was spawned before the crash" case, not just the
"nothing was ever spawned" case.

**6. Docs**: `docs/cadre-host.md` line 104 currently states "`provisioning`
records are therefore never touched" (true today, false after this fix) as
part of the `DonationSupervisor` description, and line 118-119 documents the
existing reap sweeps' re-read discipline. Add a short parallel bullet there for
the new stuck-`provisioning` reap once implemented, matching the existing
prose style (this is the one doc likely to go stale silently otherwise).

## TODO

Widen `DonationServiceOptions`/field type to `DonationOrchestrator` and add
that interface; export it from `donation/index.ts`

Add `DONATION_PROVISIONING_TTL_MS` constant and export it from
`donation/index.ts` alongside the existing TTL/sweep constants

Add `isStaleProvisioning`, `reapStaleProvisioning`, and
`reclaimStuckProvisioning` to `donation-service.ts` per the design above

Wire `reapStaleProvisioning` into `bin/host.ts`'s existing reap-sweep closure

Add `resolveDockerId` to `FakeOrchestrator` in `fake-orchestrator.ts`

Tests in `donation-service.test.ts` (mirror the existing
`describe('DonationService.reapStaleAwaitingSeed', ...)` block below it):
reaps a stuck `provisioning` record past the TTL and marks it `error`; when the
orchestrator can resolve a `dockerId` for the donation id, the reap
stops+removes that child too; leaves a fresh `provisioning` record (within
TTL) alone; a record that legitimately advances to `awaiting_seed`/`error`
between the sweep's snapshot and its per-record re-read is left as whatever it
became (mirror the existing "leaves a loan alone when ... lands mid-sweep"
test style); `liveNodeCount` no longer counts the reaped record

Update `docs/cadre-host.md` (line ~104 and the reap-sweep prose around
line 118-123) to describe the new stuck-`provisioning` reap and drop the
now-false "provisioning records are therefore never touched" claim

Run `yarn workspace @serfab/cadre-host test` (or the narrower vitest file) and
confirm the whole suite is green, not just the new tests

If cadre-provider's sibling bug (same crash-window issue in
`ContainerService.provisionContainer`, no reap sweep at all there) isn't
already tracked, file a `debt-` ticket in `tickets/backlog/` noting it —
do NOT fix it under this ticket, it's out of scope (different package,
different quota model, no existing lookup-by-containerId precedent to reuse)
