---
description: The lending computer now saves everything it needs to restart a machine it lent out, and knows how to restart one — reviewed and tightened, though nothing calls that restart yet.
files: packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, docs/STATUS.md
---

# Groundwork for respawning donated nodes — complete

Phase 1 of the donated-node respawn work, implemented and reviewed. **Observable
behaviour is still unchanged**: a crashed donated node stays dead until
`16.5-donated-node-respawn-supervisor` lands the component that calls
`respawn()`.

## What landed

- `Donation` carries the spawn inputs — `bootstrapNodes?: string[]`,
  `ownerKeys?: string[]`, `respawn?: { attempts, lastAttemptAt }`. Declared
  optional because rows come off disk unvalidated and pre-existing rows have
  neither; that forces the "is this respawnable?" check at the one site that
  needs it. None is secret, so `DonationView` keeps carrying them.
- `DonationService.respawn(id)` replays `createContainer` with the persisted
  `{ id, partyId, bootstrapNodes, profile, ownerKeys }` and writes back the fresh
  `dockerId` / `seedEndpoint` / `seedToken`. Status is deliberately unchanged.
  Returns the refreshed view on success, `undefined` for a record with no
  persisted inputs (a skip, so a sweep keeps going), throws `orchestrator_error`
  on spawn failure (caller owns backoff) and `invalid_state` for any
  non-respawnable status. `respawn.attempts` increments on every attempt; the
  failure write is best-effort so a storage error there never masks the
  orchestrator error. On a post-spawn store failure the new child is stopped,
  never reclaimed — `removeContainer` deletes the workdir, and the workdir is
  what makes a respawn the *same* node.
- `terminate()` writes the `terminated` record **before** stopping the child, so
  a supervisor reacting to the orchestrator's `onStateChange` cannot observe
  "node gone, record still `seeded`" and resurrect an ended loan.
- `HostProcessOrchestrator.dropStaleHandle(containerId)` — handles are keyed by
  the per-spawn `dockerId`, so a re-spawn previously stranded the old handle and
  leaked its four ports from a bounded range. `listDeadHandles()` deleted (no
  production caller).

## Review findings

Reviewed the implement diff (`59b7f82`) against the orchestrator, the donation
store, the `/grants` routes, and the sibling supervisor ticket. Build, tests and
lint were re-run after the fixes below.

### Fixed in this pass (minor)

- **`respawn` accepted a `provisioning` record.** The guard was a denylist of the
  two terminal statuses, so a row left mid-provision by a host crash — which now
  *does* carry the persisted spawn inputs — was respawnable. Replaying it would
  race the in-flight provision and strand the record in `provisioning`, a status
  no reap sweep collects. Replaced with a positive allowlist (`awaiting_seed` |
  `seeded`), which is also exactly what the supervisor ticket filters for. New
  test: `refuses a record whose provision is still in flight`.
- **The most delicate branch had no test.** The post-spawn store-write failure
  path (stop the new child, do *not* reclaim it, record the attempt, rethrow) was
  only reachable by inspection. Added `FlakyDonationStore` (one-shot failing
  `put`) and `stops — but never reclaims — the new child when the post-spawn
  write fails`, asserting `stopped === ['dock_2']`, `removed === []`, the record
  still on the old `dockerId`, and `attempts === 1`.
- **`docs/STATUS.md` was stale** in the section this work extends: the
  `2-donation-service` bullet still read "in progress" with "`DonationService` is
  today exercised only through the integration scenario", contradicted by the
  unit-test file this ticket extends. Marked landed, and added a `[~]` bullet for
  respawn that states plainly there is no production caller yet.

### Filed as new tickets (major)

- `backlog/debt-failed-respawn-strands-donated-workdir` — `dropStaleHandle` runs
  *before* the launch can fail, so a failed re-spawn leaves the orchestrator with
  no handle for the `dockerId` the donation record still names. `terminate()`
  then swallows "Container not found" from both `stopContainer` and
  `removeContainer` and reports success while the workdir is never deleted; the
  node also drops out of the local UI's node list. Dormant until the supervisor
  lands, but wrong the moment it does — and a failed re-spawn is precisely what
  the supervisor's give-up path produces. Not fixed inline: the tension with
  releasing ports before re-allocating them (which is what makes a re-spawn reuse
  the same ports) deserves a design decision, not a review-pass patch. Cross-
  referenced from the `dropStaleHandle` docstring.
- `backlog/bug-stuck-provisioning-donation-holds-quota` — **pre-existing, not
  caused by this diff.** `provisionLocked` persists the `provisioning` row before
  spawning; a host death in that window leaves a row nothing advances, and
  `reapStaleAwaitingSeed` only collects `awaiting_seed`. It counts against the
  grantee's `maxNodes` forever, clearable only by hand-editing `donations.json`.
  Surfaced because this ticket made such rows look respawnable.

### Parked as tripwires, not tickets

- **Concurrent `respawn` calls double-spawn.** Two overlapping calls for one id
  both spawn, and the second drops the first's handle, orphaning a process.
  Nothing calls `respawn` today, but the supervisor ticket wires *two* triggers
  (interval timer + `onStateChange`) into one `reconcile()`. Parked as a `NOTE:`
  on `respawn`'s docstring — the exact site the supervisor author will read —
  rather than a ticket, because it is only work if those passes are allowed to
  overlap.
- The implementer's tripwire on `dropStaleHandle` (released ports go straight
  back to the allocator, so replacing a *live* child could bind-clash) was
  re-checked and left as-is: every caller today re-spawns only a container it has
  established is not running.

### Checked and found clean

- **No cross-grantee leak from the widened `DonationView`.** `bootstrapNodes` /
  `ownerKeys` / `respawn` now ride the wire view; the only route that returns
  them is `server/routes/grants.ts:140`, scoped by the caller's own grant token,
  and all three values originate from that same grantee.
- **`terminate()` reorder is safe.** `safeStop` / `safeReclaim` are best-effort
  and never throw, so moving the store write ahead of them changes only the crash
  window — documented at the site, and the new test observes `terminated`
  already written from inside `stopContainer`.
- **`invalid_state` vs the supervisor's give-up path.** The supervisor sets
  `status: 'error'` and then stops attempting, so it never calls `respawn` on a
  record the guard rejects. No conflict.
- **`respawn`'s read-modify-write** of the store follows the same shape as the
  existing `applySeed`; no new race class introduced.
- **`docs/cadre-host.md` deliberately not touched.** Nothing in it became false:
  the workdir-dies-with-the-loan claim (`:160`) and the donation-surface status
  (`:102-108`) both still hold, and the supervisor ticket explicitly owns
  documenting the respawn contract there. `docs/architecture.md` matches were
  unrelated (cold-start bootstrap, push fan-out).

### Not verified

- **No real child was ever respawned.** `respawn` is exercised only against
  `FakeOrchestrator`. "The same peer id comes back" is verified by the
  orchestrator test (real children, SIGKILL, port reuse, identity re-decode);
  "it reconnects and is useful" is not, and needs the cross-package
  `cadre-host-node-donation` integration scenario that both this ticket and the
  supervisor ticket flag as out of scope.
- **`respawn.attempts` is half-owned.** This ticket writes the counters; the
  supervisor defines the backoff, healthy-reset, and give-up threshold that read
  them. Nothing resets `attempts` yet, so on its own the field only grows.

## Validation

`yarn workspace @serfab/cadre-host build` → clean.
`yarn workspace @serfab/cadre-host test` → 57 files, **474 passed**, 4 skipped
(up from 472 — the two tests added above).
`yarn lint` → **0 errors**, 6 pre-existing unused-eslint-disable warnings in
`packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`,
untouched by this diff.
