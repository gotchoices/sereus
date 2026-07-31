---
description: A machine lent to someone else's group cannot currently be restarted after a crash, because the lending computer never saved the details needed to start it back up; save those details and add the restart operation.
files: packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts
difficulty: medium
---

# Groundwork for respawning donated nodes

Split out of the original `16-donated-node-respawn` ticket, which was decomposed
under a budget limit before any code landed. This ticket is **phase 1 only**: the
record fields, the orchestrator fix, the ordering fix, and a `respawn()` method.
The supervisor that *calls* `respawn()` on a timer is the sibling ticket
`donated-node-respawn-supervisor`.

Nothing here changes observable behaviour on its own — after this ticket a
crashed donated node still stays dead. It becomes *possible* to bring it back.

## Verified trace (re-checked against current `master`; line numbers as of that read)

- `DonationService.provisionLocked` (`donation-service.ts:126-187`) is the only
  call to `Orchestrator.createContainer` in the donation flow.
- `Donation` (`donation/types.ts:138-165`) stores `partyId` and `profile` but
  **not** `bootstrapNodes` or `ownerKeys`. Both are `DonationProvisionRequest`
  fields (`donation-service.ts:32-49`) that are consumed by the `createContainer`
  call and then dropped. Without them the spawn cannot be replayed.
- `terminate()` (`donation-service.ts:271-279`) writes the `terminated` record
  **after** `safeStop` + `safeReclaim`.
- `HostProcessOrchestrator.createContainer` (`host-process-orchestrator.ts:232-278`)
  allocates four ports and calls `launchChild`, which inserts a handle keyed by
  the *new* `dockerId` (`:539`) and never drops a prior handle for the same
  `containerId`. `ensureOwnerNode` (`:320-331`) already implements the correct
  cleanup and carries the comment explaining why the workdir must survive.
- `Orchestrator.isRunning(dockerId)` exists on the shared interface
  (`packages/cadre-provider/src/service/orchestrator.ts:99`), so the supervisor
  ticket needs no new orchestrator surface.
- `listDeadHandles()` (`host-process-orchestrator.ts:211`) has exactly one caller
  in the whole repo: `src/__tests__/orchestrator.test.ts:415`.

## What to build

### Persist the spawn inputs

Add to `Donation` (`donation/types.ts`):

```ts
/** Requester control-network bootstrap multiaddrs — replayed on respawn. */
bootstrapNodes: string[];
/** Requester owner public key(s), base64url — replayed as CADRE_OWNER_KEYS on respawn. */
ownerKeys: string[];
/** Respawn bookkeeping; absent until the first respawn attempt. */
respawn?: { attempts: number; lastAttemptAt: string };
```

Write `bootstrapNodes` / `ownerKeys` in `provisionLocked` from the request.

Neither field is secret (public keys + dialable addrs), so `DonationView` keeps
carrying them and the borrower's `GET /grants/:id` gains the respawn counters for
free — no new wire surface needed.

Records written before this change have neither field. Treat a missing or empty
`bootstrapNodes`/`ownerKeys` as **not respawnable**: log once and skip; never
crash a sweep over the store.

### `DonationService.respawn(id)`

Replays `createContainer` with the persisted
`{ id, partyId, bootstrapNodes, profile, ownerKeys }`, then writes back the fresh
`dockerId`, `seedEndpoint`, and `seedToken`.

**Status is unchanged.** A `seeded` node stays `seeded` (it rejoins from its own
durable node-local stores); an `awaiting_seed` node stays `awaiting_seed` and the
borrower's later seed goes to the new endpoint/token.

Why no re-seeding is needed: `cadre-cli start`
(`packages/cadre-cli/src/commands/start.ts:118-131`) opens `FileTrustedOwnerStore`
and `FileBootstrapPeerStore` in `CADRE_NODE_STATE_DIR`, which the orchestrator
pins to the node's workdir, and `ensureNodeIdentity` reuses `identity.key`. A
respawned node returns with the same peer id, the same trusted-owner anchor, and
its retained dial targets.

### Ordering fix in `terminate()`

Write `{ ...donation, status: 'terminated' }` to the store **before**
`safeStop` / `safeReclaim`, so the `onStateChange` that the stop provokes already
sees a terminal record — otherwise a future exit-driven supervisor would observe
"node gone, record still `seeded`" and resurrect a loan the borrower just ended.
A crash between the write and the stop leaves a terminated record with a live
child, which is strictly better than resurrecting an ended loan; note that
tradeoff in a comment at the site.

### `createContainer` stale-handle cleanup

In `HostProcessOrchestrator.createContainer`, before allocating ports: if a
handle already exists for this `containerId`, release its ports and delete it
from `this.handles`. Mirror the comment in `ensureOwnerNode` about *not* deleting
the workdir — the identity key and node-local stores live there and are the whole
reason a respawn is the same node.

### Not doing: pinning the p2p port

Leave the p2p port re-allocated per spawn. The existing `NOTE:` in
`createContainer` (`host-process-orchestrator.ts:244`) documents the recovery
path — retained bootstrap peers, reconnect, republish its own `CadrePeer` row.
Update that note to point at this ticket's slug instead of the stale
`backlog/bug-donated-nodes-never-respawned` reference.

## TODO

- Add `bootstrapNodes`, `ownerKeys`, `respawn` to `Donation`; write the first two
  in `provisionLocked`. Document that a record lacking them is not respawnable.
- Add `DonationService.respawn(id)` — replay `createContainer`, update
  `dockerId` / `seedEndpoint` / `seedToken`, leave `status` alone.
- Move the `terminated` store write ahead of the stop/reclaim in
  `DonationService.terminate`.
- Drop the stale same-`containerId` handle and release its ports in
  `createContainer`; keep the workdir. Update the stale `NOTE:` slug reference.
- Delete `listDeadHandles()` and its assertion in `orchestrator.test.ts:415`
  rather than leaving a method whose only caller is a test. (Check whether the
  `PersistedHandle` type import is still needed — `toPersisted` also uses it.)
- Tests, vitest, `packages/cadre-host`:
  - `donation/__tests__/donation-service.test.ts` — extend the existing
    `FakeOrchestrator` (`:38`). `respawn()` on a `seeded` record swaps `dockerId`
    / `seedEndpoint` / `seedToken` and leaves `status: 'seeded'`; `respawn()` on
    a record with no `bootstrapNodes`/`ownerKeys` (hand-written into the store)
    does not throw and does not call `createContainer`; `terminate()` leaves a
    `terminated` record even when the store is observed from inside the stop
    (assert the write happens before `stopContainer` is called — the fake can
    read the store from its `stopContainer`).
  - `src/__tests__/orchestrator.test.ts` — `createContainer` twice with the same
    `containerId` leaves exactly one handle for that id, releases the first
    handle's ports, and preserves `identity.key` (same peer id). Note the second
    create will leave the first child process running; kill it in the test so the
    suite's `afterEach` cleanup is not the only thing reaping it.
- `yarn workspace @serfab/cadre-host build && yarn workspace @serfab/cadre-host test`,
  plus `yarn lint`.

## Honest gaps

- No executed reproducing test exists yet; the failure was established purely by
  code trace. The trace above was re-verified against current `master`, but the
  line numbers will drift.
