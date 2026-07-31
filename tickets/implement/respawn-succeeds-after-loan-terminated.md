---
description: If someone ends their borrowed node at the exact moment the host is restarting that node after a crash, the host can record the loan as alive again and leave a node process running that nothing will ever clean up. Make the ending always win.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, docs/cadre-host.md, docs/STATUS.md
difficulty: medium
---

# Ending a loan mid-restart must win over the restart

Reproduced, root-caused, and the fix below was prototyped end-to-end (both race cases pass, the
existing donation suite stays green apart from three mechanical return-shape assertions). The
prototype was reverted so this ticket lands on a clean tree — reapply it here.

## What was reproduced

Two tests against `FakeOrchestrator` (`packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts`),
using its `createDelayMs` + `onCreate` hooks to land an ending *inside* the respawn's spawn window:

**Borrower deletes mid-restart** — provision, flip the record to `seeded`, then respawn with
`orch.onCreate = () => { terminated ??= svc.terminate(p.id); }`. Observed before the fix:

```
record:   status "seeded", dockerId "dock_2", seedToken "seed-token-2"
stopped:  [ 'dock_1' ]   removed: [ 'dock_1' ]      ← nothing ever stops dock_2
liveNodeCount: 1                                     ← the deleted loan still holds a quota slot
```

**Reap wins mid-restart** — provision, advance the clock past the 30-minute
`awaiting_seed` TTL, respawn with `orch.onCreate = () => { reaped ??= svc.reapStaleAwaitingSeed(); }`.
The reap terminated it, then the respawn's success write put it back to `awaiting_seed` with
`updatedAt` moved to the reap's own "now" — the TTL clock restarted exactly as predicted.

## Cause

`DonationService.respawn` (`donation-service.ts:294`) reads the record at entry, awaits
`orchestrator.createContainer(...)` — seconds of wall clock — and then writes back a row spread from
that entry-time copy (`{ ...attempted, dockerId, seedEndpoint, seedToken, updatedAt }`).
`DonationStore.put` replaces the whole row, so a `terminated` write that landed during the spawn is
silently overwritten. Same shape as the failure-path bug already fixed in `storeAttempt`; the success
path was untouched.

There is a second, quieter half. `HostProcessOrchestrator.createContainer` calls
`dropStaleHandle(containerId)` (`host-process-orchestrator.ts:230`) *while spawning*, which removes
the previous handle for that container id and releases its ports. So by the time the concurrent
`terminate` reaches `safeStop(oldDockerId)` / `safeReclaim(oldDockerId)`, `requireHandle` throws
`Container not found` and both calls are swallowed by the best-effort wrappers. The ending therefore
cleans up **nothing**, and the new handle is the only thing holding that spawn's four ports and the
workdir. Any fix that merely stops the new child leaks its ports and workdir; it has to reclaim.

## The fix (prototyped and verified)

Three moves, all inside the donation module.

**1. Re-read the record after the spawn, and decide with no `await` in between.** `DonationStore` is
synchronous, so a read-modify-write with no interleaved `await` is atomic against the event loop —
same discipline as `DonationSupervisor.refillBudgetIfHealthy` and `DonationService.storeAttempt`. In
the success branch of `respawn`, replacing the write with:

```ts
const current = this.store.get(id);
if (!current || !RESPAWNABLE_STATUSES.has(current.status)) {
  return this.abandonRespawn(id, dockerId, current);
}

const respawned: Donation = {
  ...current,                    // whatever is on disk NOW, not the entry-time copy
  respawn: attempted.respawn,    // merge only the attempt counters forward
  dockerId: result.dockerId,
  seedEndpoint: result.seedEndpoint,
  seedToken: result.seedToken,
  updatedAt: this.now().toISOString(),
};
this.store.put(respawned);
```

`RESPAWNABLE_STATUSES` is a new module-level `ReadonlySet<DonationStatus>` of
`awaiting_seed | seeded`; use it for the entry guard too, so the "may this loan come back" rule is
stated once.

**2. Clean up the child the ending cannot see.**

```ts
private async abandonRespawn(
  id: string,
  dockerId: string,
  current: Donation | undefined,
): Promise<RespawnResult> {
  const status = current?.status;
  log('donation %s went %s during respawn — abandoning new child %s', id, status ?? 'missing', dockerId);
  await this.safeStop(dockerId);
  if (status !== 'error') await this.safeReclaim(dockerId);
  return status ? { outcome: 'abandoned', status } : { outcome: 'abandoned' };
}
```

Reclaim, not merely stop: on a `terminated` record the loan is over, so the workdir (identity key +
node-local stores) goes with it — which is what `terminate` intended and, per the `dropStaleHandle`
finding above, failed to achieve. The `error` case is the deliberate exception, matching
`DonationSupervisor.giveUp`, which keeps the workdir so a later `terminate` can still reclaim the
same node. (`giveUp` cannot actually run concurrently with a respawn — the supervisor serializes its
passes — so this branch is defensive; keep it, and say so in the comment.)

**3. Give the caller a distinguishable outcome.** `respawn`'s current `DonationView | undefined`
conflates "abandoned" with "record predates persisted spawn inputs". Replace it with:

```ts
export type RespawnResult =
  | { outcome: 'respawned'; donation: DonationView }
  | { outcome: 'not_respawnable' }
  | { outcome: 'abandoned'; status?: DonationStatus };   // status absent = row is gone
```

`DonationSupervisor.attemptRespawn` is the only production caller; switch on `result.outcome` and
return `undefined` for both non-`respawned` cases. That already satisfies "not counted as a failed
attempt": nothing throws, so the backoff/give-up path is never entered and the attempt counter is
never persisted for an abandoned respawn. Export `RespawnResult` from `donation/index.ts` alongside
the other donation service types.

## Verified outcomes

With the prototype applied, both race tests pass: the record stays `terminated`,
`liveNodeCount` is 0, `orch.stopped` contains the new `dock_2`, and the reap case keeps its
terminal `updatedAt` instead of restarting the TTL. `yarn vitest run src/donation` in
`packages/cadre-host` went from 3 failures to 0 once the three assertions below are updated;
`yarn typecheck` reported errors only in that test file. The supervisor suite passed untouched.

Existing assertions that need the new return shape (`packages/cadre-host/src/donation/__tests__/donation-service.test.ts`):

- line ~220 `expect(view?.status).toBe('seeded')` → `expect(result).toMatchObject({ outcome: 'respawned' })` + check `result.donation.status`
- line ~252 `expect(view?.status).toBe('awaiting_seed')` — same
- line ~277 `resolves.toBeUndefined()` → `{ outcome: 'not_respawnable' }`

## Tripwire, not work for this ticket

The success path bumps `updatedAt`, and on an `awaiting_seed` record that is the very field the
stale-seed reap measures — so each respawn defers the reap. Bounded and harmless today (5 attempts
with ≤80s backoff ≈ 2.5 extra minutes against a 30-minute TTL, then give-up moves the record to
`error`), and unlike `refillBudgetIfHealthy` a respawn genuinely does change the row. Keep the bump;
leave a `NOTE:` at the site so a future reader who raises `DONATION_RESPAWN_MAX_ATTEMPTS` sees it.

## TODO

Phase 1 — service

- Add `RESPAWNABLE_STATUSES` and use it for `respawn`'s entry guard.
- Add the `RespawnResult` type; change `respawn`'s signature and its three return points.
- Re-read the record after `createContainer`; merge only the new handles + attempt counters onto the
  on-disk row; keep read and write free of any `await` between them.
- Add `abandonRespawn` (stop always, reclaim unless the record is `error`), with the comment
  explaining why reclaim is required — `dropStaleHandle` already voided the ending's own cleanup.
- `NOTE:` comment for the `updatedAt` / reap-TTL tripwire.

Phase 2 — callers, exports, docs

- `DonationSupervisor.attemptRespawn`: switch on the outcome; log abandonment distinctly; return
  `undefined` for `not_respawnable` and `abandoned`.
- Export `RespawnResult` from `packages/cadre-host/src/donation/index.ts`.
- `docs/cadre-host.md` § Respawn: state that an ending landing mid-respawn wins — the record stays
  terminal and the new child is stopped and reclaimed.
- `docs/STATUS.md` (~line 403): drop the "Known gap" sentences naming this ticket.

Phase 3 — tests

- Update the three return-shape assertions listed above.
- Add to `donation-service.test.ts`: borrower-`terminate`-mid-respawn, reap-mid-respawn (assert
  `updatedAt` is not restarted), and a guard that the ordinary respawn still records the new handles
  and leaves status alone.
- Add a supervisor test that an abandoned respawn neither increments the persisted attempt counter
  nor marks the record `error`.
- `cd packages/cadre-host && yarn vitest run src/donation 2>&1 | tee /tmp/donation.log`, then
  `yarn typecheck` and `yarn lint` from the repo root.
