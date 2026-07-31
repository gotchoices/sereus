---
description: If a borrowed node finishes joining at the same moment the host is shutting that loan down, the shutdown gets undone and the ended loan comes back to life still counting against the lender's limit. Make the shutdown win instead.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/index.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, docs/cadre-host.md
difficulty: medium
---

# An ending that lands mid-`applySeed` / mid-`provision` must win

`respawn` was fixed for exactly this in `tickets/complete/respawn-succeeds-after-loan-terminated.md`.
Two sibling methods of `DonationService` still have the bug. Both are **reproduced**; see below.

## Reproduced (fix stage)

A scratch vitest file drove all three interleavings against `FakeOrchestrator` + a stubbed
`globalThis.fetch`, and all three failed on current `master` (e2930e4). It has been deleted; the
recipes below are what the new tests should be built from.

| interleaving | observed on master | should be |
| --- | --- | --- |
| `terminate` inside `applySeed`'s `fetch` | record back to **`seeded`**, `liveNodeCount` 1 | stays `terminated`, count 0 |
| `reapStaleAwaitingSeed` inside `applySeed`'s `fetch` | record back to **`seeded`**, `updatedAt` moved past the reap's stamp (TTL clock restarted) | stays `terminated`, `updatedAt` = reap's stamp |
| `terminate` inside `provision`'s `createContainer` | record back to **`awaiting_seed`** now naming `dock_1`; `orch.stopped` and `orch.removed` both **empty** | stays `terminated`, `dock_1` reclaimed |

The third row confirms the premise the fix ticket asserted: the concurrent `terminate` saw a record
with **no `dockerId`** (the provision had not written one yet), so its cleanup branch never ran and
nothing stopped the child. The freshly spawned node is left running with the record resurrected on
top of it.

## The shape (same as `respawn`'s)

`DonationStore.put` replaces a whole row. Any method that reads a record, `await`s something slow,
then writes back a row built from the **entry-time** copy discards whatever landed during the
`await`. When what landed was the loan ending, the ending is undone.

There are exactly **three** remaining sites in `donation-service.ts` (the rest were audited and are
clean: `terminate` puts with no intervening `await`; `reapStaleAwaitingSeed` delegates to
`terminate`, which re-reads per record; `getPeer` never writes; `respawn` and `storeAttempt` are
already fixed; `DonationSupervisor.refillBudgetIfHealthy` and `giveUp` already re-read):

1. `applySeed` — the `status: 'seeded'` write (~line 299).
2. `provisionLocked` — the `status: 'awaiting_seed'` write (~line 210).
3. `provisionLocked` — the `status: 'error'` write in its `catch` (~line 217). Same shape, milder
   damage: an ending that lands mid-spawn followed by an orchestrator failure rewrites the
   borrower's own `terminated` as a host-side `error`, and a record deleted mid-spawn is recreated.

## Fix

The rule, identical to `respawn`'s: **re-read after the slow `await`, decide against what is
actually on disk, and let no `await` sit between that read and the write** — `DonationStore` is
synchronous, so a read-decide-write pair with no `await` in it cannot be interleaved. Merge forward
only the fields the operation produced; never write back the entry-time row.

### `applySeed`

Its return type does double duty today: `DonationSeedResult` is both the node's `POST /seed`
response body (`res.json()` is cast to it) and the service's result. Split them, and make the
service result a discriminated union mirroring `RespawnResult`:

```ts
/** The donated node's `POST /seed` response body. Module-private — the wire shape, not our result. */
interface NodeSeedResponse {
  success: boolean;
  peersAdded?: number;
  error?: string;
}

/**
 * Outcome of {@link DonationService.applySeed}.
 *
 * - `seeded`    — the node accepted the seed and the record now says so.
 * - `rejected`  — the node refused the seed (its own seed-trust policy). Nothing written.
 * - `abandoned` — the seed reached the node, but the loan ended while the request was in flight.
 *                 The ending wins: the record is left exactly as the ending wrote it. `status` is
 *                 the status that won, absent when the row is gone entirely.
 */
export type DonationSeedResult =
  | { outcome: 'seeded'; peersAdded: number }
  | { outcome: 'rejected'; error?: string }
  | { outcome: 'abandoned'; status?: DonationStatus };
```

Control flow: keep the entry guard as-is, `fetch`, `await res.json()`, then

- `success === false` → `{ outcome: 'rejected', error }`, no write (unchanged behaviour).
- otherwise re-read; if the record is gone or no longer in a seedable status → `{ outcome:
  'abandoned', status? }`. **No cleanup is owed here** (unlike `provision`): the ending's own
  `terminate` already stopped and reclaimed the child, because the record named a `dockerId` the
  whole time.
- otherwise write `{ ...current, status: 'seeded', updatedAt: now }` — the status transition and
  nothing else, merged onto the on-disk row.

The seedable set (`awaiting_seed` | `seeded` — re-seeding an already-seeded record is allowed
today, keep that) should be a named module constant checked on **both** the entry guard and the
re-read, so the "may this record be marked seeded" rule is stated once. Do **not** fold it into
`RESPAWNABLE_STATUSES`: the review of the respawn ticket deliberately kept `RESPAWNABLE_STATUSES` /
`SUPERVISED_STATUSES` / `LIVE_STATUSES` separate because they answer different questions, and this
is a fourth question.

`PUT /grants/:id/seed` (`server/routes/grants.ts`) switches on the outcome:

- `seeded` → 200 `{ ok: true, data: { peersAdded } }` (unchanged).
- `rejected` → 502 `seed_failed` (unchanged).
- `abandoned` with a `status` → 409 `invalid_state`, message naming the status the loan ended in.
  Without a `status` (row gone) → 404 `not_found`. Both `DonationErrorCode`s already map to those
  statuses in `server/error-handler.ts`; nothing there needs touching.

### `provisionLocked`

Split the single big `try` so the abandon decision is not swallowed by the failure `catch`:

```ts
let result: OrchestratorCreateResult;
try {
  result = await this.orchestrator.createContainer({ ... });
} catch (err) {
  this.markProvisionFailed(id, errorMessage(err));   // re-read + guarded `error` write (site 3)
  throw new DonationError('orchestrator_error', `Failed to provision donated node: ${errorMessage(err)}`);
}

// No `await` between this read and the write below.
const current = this.store.get(id);
if (!current || current.status !== 'provisioning') {
  await this.safeReclaim(result.dockerId);   // the ending cleaned up nothing — see above
  throw current
    ? new DonationError('invalid_state', `Donation ${id} was ${current.status} before it finished provisioning`)
    : new DonationError('not_found', `No such donation: ${id}`);
}

const provisioned: Donation = {
  ...current,
  dockerId: result.dockerId,
  seedEndpoint: result.seedEndpoint,
  seedToken: result.seedToken,
  status: 'awaiting_seed',
  updatedAt: this.now().toISOString(),
};
try {
  this.store.put(provisioned);
} catch (err) { /* reclaim + markProvisionFailed + throw orchestrator_error, as today */ }
return redact(provisioned);
```

Notes on the choices:

- **`provision` throws rather than returning an outcome union.** Unlike `applySeed`, its caller is
  the request that is *creating* the thing; there is no successful shape to report, and the HTTP
  layer already maps `invalid_state` → 409 / `not_found` → 404. A union would force `POST /grants`
  to invent a body meaning "you deleted the thing you were creating".
- **Reclaim, don't stop-then-reclaim.** `HostProcessOrchestrator.removeContainer` stops the child
  itself if the pid is alive, and provision's existing failure path already uses `safeReclaim`
  alone. (`abandonRespawn` calls both only because it *conditionally skips* the reclaim.) No
  workdir is worth preserving here — this spawn created it.
- **`markProvisionFailed(id, message)`** is a new private helper mirroring `storeAttempt`: re-read,
  and write `{ ...current, status: 'error', error: message, updatedAt: now }` **only if** the
  current status is still `provisioning`. A record that went `terminated`, or vanished, is left
  alone — a host fault must not overwrite the borrower's own ending, and a deleted row must not be
  recreated. Best-effort (log, never throw), same as `storeAttempt`, so it cannot mask the
  orchestrator error being unwound.

### Tripwire to record (a `NOTE:` at `applySeed`'s re-read, not a ticket)

A concurrent **`respawn`** leaves the record `awaiting_seed` but swaps `seedEndpoint`/`seedToken`.
The re-read's status check therefore passes, and we would mark `seeded` a record whose live child is
the *new* one, while the seed actually went to the old endpoint. Narrow and ambiguous rather than
plainly wrong today — the respawn only fires when the supervisor believes the child is down, in
which case our `fetch` would have failed; and both spawns share one workdir, so the seed the old
child persisted is on disk for the new one. It becomes real work if a second `respawn` caller
appears or if respawn ever stops sharing the workdir; the remedy is to compare
`current.seedEndpoint`/`seedToken` against the ones we actually seeded and report `abandoned`.

## Coverage to add

`applySeed`'s happy path has **no unit coverage at all** today (only the `cadre-host-node-donation`
integration scenario exercises it), because it does a real `fetch`. Stub the global, following the
established `packages/cadre-provider/src/service/__tests__/container-*.test.ts` pattern
(`const originalFetch = globalThis.fetch` + restore in `afterEach`) — the stub body is also where
the concurrent ending is driven, exactly as `FakeOrchestrator.onCreate` is for the spawn races:

```ts
let terminated: Promise<void> | undefined;
globalThis.fetch = (async () => {
  terminated ??= svc.terminate(id);
  await terminated;
  return { ok: true, json: async () => ({ success: true, peersAdded: 2 }) } as unknown as Response;
}) as typeof globalThis.fetch;
```

(This exact stub reproduced the bug; `terminate`'s store write lands synchronously, before the
response resolves.)

In `donation-service.test.ts` — and update that file's header comment, which currently states
`applySeed`'s happy path is untestable here:

- Ordinary seed, no concurrent ending → `{ outcome: 'seeded', peersAdded }`, record moves
  `awaiting_seed` → `seeded`.
- Node rejects the seed → `{ outcome: 'rejected' }`, record still `awaiting_seed`, nothing written.
- `terminate` lands mid-`fetch` → `{ outcome: 'abandoned', status: 'terminated' }`, record stays
  `terminated` with its original `dockerId`, `liveNodeCount` is 0, and nothing the supervisor would
  respawn is left behind.
- Stale-seed reap lands mid-`fetch` → same, and `updatedAt` stays at the reap's timestamp (drive the
  clock exactly as `'lets a stale-seed reap that lands mid-spawn win…'` does).
- Record vanishes mid-`fetch` → `{ outcome: 'abandoned' }` with no `status`, and no row recreated.
- `provision` whose `terminate` lands mid-spawn → rejects `invalid_state`, record stays
  `terminated`, `orch.removed` contains the new `dock_1`, `liveNodeCount` is 0.
- `provision` whose record is removed mid-spawn → rejects `not_found`, child reclaimed, no row
  recreated.
- `provision` where a `terminate` lands mid-spawn **and** `createContainer` then throws
  (`orch.onCreate` terminates, `orch.failCreate = true`) → record stays `terminated`, is **not**
  rewritten to `error`.

In `server/__tests__/grants-route.test.ts`: one test that `PUT /grants/:id/seed` answers **409**
(not 200) when the ending wins — its local fake orchestrator plus a `fetch` stub that issues the
`DELETE` via `app.inject` covers it.

## TODO

Phase 1 — service

- Split `NodeSeedResponse` (module-private wire body) out of `DonationSeedResult`, and make
  `DonationSeedResult` the `seeded` / `rejected` / `abandoned` union.
- Add the seedable-status module constant, with a docstring saying which question it answers and why
  it is not shared with `RESPAWNABLE_STATUSES`; use it in `applySeed`'s entry guard and re-read.
- Rewrite `applySeed`'s tail: re-read after `res.json()`, no `await` before the write, merge only
  the status transition. Add the respawn tripwire `NOTE:` at the re-read.
- Restructure `provisionLocked` per the sketch: narrow `try` around `createContainer`, guarded
  re-read + `safeReclaim` + typed throw on the abandon path, targeted `try` around the
  `awaiting_seed` `put`.
- Add the private `markProvisionFailed` helper and route both `error` writes through it.

Phase 2 — callers

- Switch `PUT /grants/:id/seed` in `server/routes/grants.ts` onto the outcome union (200 / 502 /
  409 / 404).
- Update `packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts` step
  4–5: it polls on `result.success === true` and asserts `result.peersAdded` — both move to the
  union (`result.outcome === 'seeded'`).
- Check `packages/cadre-host/src/donation/index.ts` and `src/index.ts` still export
  `DonationSeedResult` correctly (both re-export it today; the name is unchanged, the shape is not).
  Nothing else in the monorepo references the type.

Phase 3 — tests + docs

- Add the `donation-service.test.ts` cases listed above and refresh that file's header comment.
- Add the `grants-route.test.ts` 409 case.
- `docs/cadre-host.md`: the § Respawn paragraph "**An ending that lands mid-respawn wins**" now
  describes a rule that holds for all three of `respawn` / `applySeed` / `provision`. Generalise it
  (and the step-4 / step-5 lifecycle diagram lines above it) rather than adding a second paragraph.
  Refresh § Status of the donation surface if the seed result's shape is described there.
- Validate from `packages/cadre-host`: `yarn vitest run src/donation src/server 2>&1 | tee /tmp/d.log`
  (baseline at e2930e4: **16 files, 159 passed**), then `yarn test`, then from the repo root
  `yarn typecheck` and `yarn lint`. The integration scenario needs real children — leave it to CI
  and say so in the handoff.
