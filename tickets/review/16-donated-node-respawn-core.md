---
description: The lending computer now saves everything it needs to restart a machine it lent out, and knows how to restart one — but nothing calls that restart yet, so a crashed loaner still stays down until the follow-up ticket lands.
files: packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts
difficulty: medium
---

# Review: groundwork for respawning donated nodes

Phase 1 of the donated-node respawn work. The sibling ticket
`donated-node-respawn-supervisor` (in `implement/`) adds the component that
calls `respawn()` on a timer. **Observable behaviour is unchanged by this
ticket alone** — a crashed donated node still stays dead; it is now merely
*possible* to bring it back.

## What landed

### `Donation` record carries the spawn inputs (`donation/types.ts`)

Three new fields, all optional:

```ts
bootstrapNodes?: string[];   // requester control-network multiaddrs
ownerKeys?: string[];        // requester owner pubkeys, base64url
respawn?: { attempts: number; lastAttemptAt: string };
```

`bootstrapNodes` / `ownerKeys` are written by `provisionLocked` from the
provision request. They were previously consumed by `createContainer` and
dropped, which is why a spawn could not be replayed.

Declared **optional**, not required as the source ticket wrote them: rows come
off disk unvalidated, and rows written before this change genuinely have
neither. Optional makes TypeScript force the "is this respawnable?" check at
the one site that needs it rather than letting the type lie about disk.

Neither field is secret (dialable addresses + public keys), so `DonationView`
keeps carrying them and the borrower's `GET /grants/:id` gains the respawn
counters with no new wire surface.

### `DonationService.respawn(id)` (`donation/donation-service.ts`)

Replays `createContainer` with the persisted
`{ id, partyId, bootstrapNodes, profile, ownerKeys }` and writes back the fresh
`dockerId` / `seedEndpoint` / `seedToken`. **Status is deliberately unchanged**
— `seeded` stays `seeded` (the node rejoins from its own durable node-local
stores), `awaiting_seed` stays `awaiting_seed` (a later seed goes to the new
endpoint/token).

Return / throw contract:

- returns the refreshed `DonationView` on success;
- returns `undefined` when the record has no `bootstrapNodes`/`ownerKeys` — a
  **skip**, so a sweep over the store keeps going;
- throws `orchestrator_error` when the spawn fails (caller owns backoff);
- throws `invalid_state` for `terminated` / `error` records.

The `invalid_state` guard is **beyond the source ticket's letter** — added
because `respawn` is the one method that can resurrect a loan the borrower
ended, and the only thing stopping it otherwise is the (not-yet-written)
supervisor's status filter. Reviewer should confirm this doesn't conflict with
the supervisor ticket's give-up path (it sets `status: 'error'` and then stops
attempting, so it never calls `respawn` on such a record).

`respawn.attempts` is incremented and `lastAttemptAt` stamped on **every**
attempt, success or failure — the failure write is best-effort
(`storeAttempt`), so a storage error there logs rather than masking the
orchestrator error.

On a post-spawn store failure the new child is **stopped, never reclaimed**:
`removeContainer` deletes the workdir, and the workdir is the identity key +
node-local stores that make a respawn the *same* node. The orphaned handle's
ports come back via the next `createContainer` for that id (below), so the leak
self-heals.

### `terminate()` writes the terminal record first

`{ ...donation, status: 'terminated' }` now goes to the store **before**
`safeStop` / `safeReclaim`. The stop fires the orchestrator's `onStateChange`;
a supervisor reacting there must already see a terminal record or it observes
"node gone, record still `seeded`" and resurrects an ended loan. Tradeoff
(documented at the site): a crash between the write and the stop leaves a
`terminated` record with a live child, which is strictly better than the
resurrection.

### `createContainer` drops the stale same-`containerId` handle

New private `dropStaleHandle(containerId)` in `HostProcessOrchestrator`, called
after `ensureNodeIdentity` and before port allocation. Handles are keyed by the
per-spawn `dockerId`, so a re-spawn previously stranded the old handle forever
and leaked its four ports from a bounded range. Mirrors `ensureOwnerNode`'s
cleanup, including the "do NOT delete the workdir" reasoning.

Also: `listDeadHandles()` deleted (its only caller in the repo was one test
assertion, now removed), and the stale `NOTE:` in `createContainer` now points
at `donated-node-respawn-core` instead of the retired
`backlog/bug-donated-nodes-never-respawned`. The p2p port is still re-allocated
per spawn — deliberately not pinned, per the source ticket.

## How to test / validate

`yarn workspace @serfab/cadre-host build && yarn workspace @serfab/cadre-host test`
→ 57 files, 472 passed, 4 skipped. `yarn lint` → 0 errors.

New tests worth re-reading:

`packages/cadre-host/src/donation/__tests__/donation-service.test.ts`
(`describe('DonationService.respawn')` and `describe('DonationService.terminate')`):

- respawn of a `seeded` record replays the persisted inputs, swaps
  `dockerId` / `seedEndpoint` / `seedToken`, keeps `status: 'seeded'`, sets
  `respawn.attempts = 1`, and stops/reclaims **nothing**;
- respawn of an `awaiting_seed` record keeps that status and moves the seed
  token forward;
- a hand-written legacy row (no `bootstrapNodes` / `ownerKeys`) resolves
  `undefined`, does not throw, and never calls `createContainer`;
- a terminated record rejects with `invalid_state`;
- a failing spawn rejects with `orchestrator_error`, records `attempts = 1`, and
  leaves the old `dockerId` / status untouched;
- `terminate()` — the `FakeOrchestrator` reads the store from inside
  `stopContainer` and observes `status: 'terminated'` already written.

`packages/cadre-host/src/__tests__/orchestrator.test.ts`
(`describe('HostProcessOrchestrator re-spawn of the same containerId')`):
SIGKILLs the first child, re-creates the same `containerId`, then asserts
exactly one persisted handle for that id, that the second spawn gets the *same*
ports back (the allocator hands out the lowest free port, so port re-use is what
proves release), and that `identity.key` still decodes to the same peer id.

Manual/e2e validation is **not** possible from this ticket alone — nothing calls
`respawn()` in production yet.

## Known gaps (be adversarial here)

- **No real child was ever respawned.** `DonationService.respawn` is only
  exercised against `FakeOrchestrator`. Nothing here proves a genuinely
  respawned `cadre-cli` child rejoins the requester's cadre — that needs the
  cross-package `cadre-host-node-donation` integration scenario, which the
  supervisor ticket also flags as out of scope. Treat "the same peer id comes
  back" as verified (orchestrator test) and "it reconnects and is useful" as
  unverified.
- **`respawn.attempts` semantics are half-owned.** This ticket writes the
  counters; the supervisor ticket defines the backoff, the healthy-reset, and
  the give-up threshold that read them. Nothing yet *resets* `attempts`, so on
  its own the field only ever grows.
- **The `invalid_state` guard is an addition, not a spec item** — see above.
- **Tripwire, parked as a `NOTE:` at `dropStaleHandle`**: releasing the stale
  handle's ports hands them straight back to the allocator, so re-spawning while
  the previous child is *still listening* could bind-clash. Every caller today
  re-spawns only a container it has established is not running.
- The `error` path in `provisionLocked` now persists `bootstrapNodes` /
  `ownerKeys` on failed provisions too (they are on the base `record`). Harmless
  — `error` rows are terminal and `respawn` refuses them — but it is a behaviour
  detail nobody asked for.
- Pre-existing, untouched by this diff: `yarn lint` reports 6 unused-eslint-
  disable warnings in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`.
