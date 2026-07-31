---
description: A machine lent to someone else's group currently stays dead after a crash or reboot; make the lending computer notice and start it up again on its own, and give up loudly instead of retrying forever.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts (new), packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/donation/__tests__/, docs/cadre-host.md
difficulty: medium
---

# Respawn donated nodes that die

## Where the gap is (traced, not guessed)

`DonationService.provisionLocked` (`donation-service.ts:153`) is the only call to
`Orchestrator.createContainer` in the donation flow. Nothing re-runs it:
`HostProcessOrchestrator.init()` marks non-surviving children dead and exposes them via
`listDeadHandles()` (no production caller), `bin/host.ts` re-spawns only the host's own
owner node, `/api/nodes/:id/{start,restart}` refuses non-owner ids with `not_implemented`,
and `reapStaleAwaitingSeed` only *terminates*. So a crashed / OOM-killed / reboot-killed
donated node stays dead with its record still reading `seeded`.

Three concrete blockers found while tracing, all of which the fix must handle:

1. **The donation record cannot reproduce the spawn.** `Donation`
   (`donation/types.ts:138`) keeps `partyId` and `profile` but *not* `bootstrapNodes` or
   `ownerKeys` — both are `DonationProvisionRequest` fields consumed and dropped. Without
   them `createContainer` cannot be replayed.
2. **Re-calling `createContainer` with the same `containerId` leaks.** `launchChild`
   inserts a new handle keyed by the new `dockerId` and never drops the old one for that
   container, so the dead handle lingers in `listNodes()` and its four ports stay marked
   used. `ensureOwnerNode` already solves exactly this (drop stale handle, release ports,
   keep the workdir) — `createContainer` needs the same treatment.
3. **`terminate()` writes `terminated` *after* stopping the child.** The stop fires
   `onStateChange`, so an exit-driven supervisor would see "node gone, record still
   `seeded`" and resurrect a node the borrower just terminated.

Good news from the trace: a respawn does **not** need re-seeding. `cadre-cli start`
(`packages/cadre-cli/src/commands/start.ts:118-131`) opens `FileTrustedOwnerStore` and
`FileBootstrapPeerStore` in `CADRE_NODE_STATE_DIR`, which the orchestrator pins to the
node's workdir, and `ensureNodeIdentity` reuses `identity.key`. So a respawned node comes
back with the same peer id, the same trusted owner anchor, and its retained dial targets.

## What to build

### Persist the spawn inputs

Add to `Donation`:

```ts
/** Requester control-network bootstrap multiaddrs — replayed on respawn. */
bootstrapNodes: string[];
/** Requester owner public key(s), base64url — replayed as CADRE_OWNER_KEYS on respawn. */
ownerKeys: string[];
/** Respawn bookkeeping; absent until the first respawn attempt. */
respawn?: { attempts: number; lastAttemptAt: string };
```

Neither new field is secret (public keys + dialable addrs), so `DonationView` keeps
carrying them and the borrower's `GET /grants/:id` gains the respawn counters for free —
that is the answer to "does the borrower need a signal", no new surface required.

Records written before this change have neither field. Treat a missing/empty
`bootstrapNodes`/`ownerKeys` as "not respawnable": log once and skip, do not crash the
sweep.

### `DonationSupervisor` (new file, `donation/donation-supervisor.ts`)

Owns the invariant *a non-terminal donation is expected to be running*. Construction takes
the `DonationService`, the `DonationStore`, the orchestrator, and an injectable `now`
(tests). Interface:

```ts
export class DonationSupervisor {
  constructor(opts: DonationSupervisorOptions);
  /** One reconcile pass. Returns the donation ids it respawned. */
  reconcile(): Promise<string[]>;
  /** Startup sweep + interval timer + orchestrator state-change subscription. */
  start(): void;
  stop(): void;
}
```

`reconcile()` walks `store.list()`, considers only `awaiting_seed` and `seeded`
(`provisioning` is a provision in flight; `error` and `terminated` are terminal), and for
each with a `dockerId` checks `orchestrator.isRunning(dockerId)`. Not running → respawn,
subject to the backoff below.

Respawn itself belongs on `DonationService` (it owns the store writes):
`DonationService.respawn(id)` replays `createContainer` with the persisted
`{ id, partyId, bootstrapNodes, profile, ownerKeys }`, then writes back the fresh
`dockerId`, `seedEndpoint`, and `seedToken`. **Status is unchanged** — a `seeded` node
stays `seeded` (it rejoins from its own durable stores), an `awaiting_seed` node stays
`awaiting_seed` and the borrower's later seed goes to the new endpoint/token.

Three triggers, one code path:

- **host startup** — one `reconcile()` after `orchestrator.init()`, alongside the existing
  `reapStale()` call in `bin/host.ts`;
- **exit signal** — `orchestrator.onStateChange`, and when a non-owner handle reports
  `status: 'stopped'`, run `reconcile()` (cheap; don't try to map the handle to a donation
  in the listener);
- **periodic sweep** — its own timer, `unref()`d like `reapTimer`; catches the cases no
  exit event covers.

### Backoff and giving up

Module constants next to `DONATION_REAP_SWEEP_MS`:

- `DONATION_RESPAWN_BACKOFF_BASE_MS = 5_000`, doubling per attempt
- `DONATION_RESPAWN_BACKOFF_MAX_MS = 5 * 60_000`
- `DONATION_RESPAWN_MAX_ATTEMPTS = 5`
- `DONATION_RESPAWN_HEALTHY_MS = 10 * 60_000`
- `DONATION_RESPAWN_SWEEP_MS = 60_000`

A candidate is skipped until `now - lastAttemptAt >= min(base * 2^attempts, max)`.
`attempts` resets to 0 when a reconcile pass finds the node running and
`now - lastAttemptAt > DONATION_RESPAWN_HEALTHY_MS` — i.e. the last respawn produced a node
that stayed up, so the next crash starts from a fresh budget.

After `DONATION_RESPAWN_MAX_ATTEMPTS` consecutive attempts the host gives up: stop the
child but **do not** `removeContainer` (that deletes the workdir, and with it the identity
key the borrower's group approved), and set `status: 'error'` with an `error` string naming
the attempt count and the last failure. `error` is outside `LIVE_STATUSES`, so the grant
quota frees and the borrower can provision a fresh node; `terminate()` still works on an
`error` record to reclaim the workdir.

### Ordering fix in `terminate()`

Write `{ ...donation, status: 'terminated' }` to the store **before** `safeStop` /
`safeReclaim`, so the `onStateChange` the stop provokes already sees a terminal record. A
crash between the write and the stop leaves a terminated record with a live child, which is
strictly better than resurrecting a loan the borrower ended — note it in a comment.

### `createContainer` stale-handle cleanup

In `HostProcessOrchestrator.createContainer`, before allocating ports: if a handle already
exists for this `containerId`, release its ports and delete it from `this.handles`. Mirror
the comment in `ensureOwnerNode` about *not* deleting the workdir — the identity key and
node-local stores live there and are the whole reason the respawn is the same node.

### Not doing: pinning the p2p port

Leave the p2p port re-allocated per spawn. The existing `NOTE:` in `createContainer`
(`host-process-orchestrator.ts:244`) already documents the recovery path — retained
bootstrap peers, reconnect, republish its own `CadrePeer` row. Update that note to point at
this ticket's slug instead of the stale `backlog/bug-donated-nodes-never-respawned`.

## TODO

Phase 1 — record + orchestrator groundwork

- Add `bootstrapNodes`, `ownerKeys`, `respawn` to `Donation` (`donation/types.ts`); write
  them in `provisionLocked`. Document that a record lacking them is not respawnable.
- Drop the stale same-`containerId` handle and release its ports in `createContainer`;
  keep the workdir.
- Move the `terminated` store write ahead of the stop/reclaim in `DonationService.terminate`.
- Add `DonationService.respawn(id)` — replay `createContainer`, update `dockerId` /
  `seedEndpoint` / `seedToken`, leave `status` alone.

Phase 2 — supervisor

- New `donation/donation-supervisor.ts` with `reconcile` / `start` / `stop`, the five
  constants, exponential backoff, healthy-reset, and the give-up-to-`error` path.
- Export it from `donation/index.ts`.
- Wire in `bin/host.ts`: construct after `donationService`, `start()` it beside the reap
  timer, `stop()` it in the shutdown block next to `clearInterval(reapTimer)`.

Phase 3 — tests (vitest, `packages/cadre-host`)

- Supervisor unit tests over `MockOrchestrator` + a real `DonationStore` in a tmp dir with
  an injected clock: seeded-but-stopped node is respawned and its `dockerId` changes while
  `status` stays `seeded`; a `terminated` record is never respawned; a second reconcile
  inside the backoff window does not re-attempt and does after the clock advances; a
  `createContainer` that always throws lands on `status: 'error'` after
  `DONATION_RESPAWN_MAX_ATTEMPTS` and stops attempting.
- Orchestrator test in `src/__tests__/orchestrator.test.ts`: `createContainer` twice with
  the same `containerId` leaves exactly one handle for that id, releases the first
  handle's ports, and preserves `identity.key` (same peer id).
- Regression test that `terminate()` leaves a terminal record even when the stop is what
  triggers reconcile.

Phase 4 — cleanup + docs

- `listDeadHandles()` has no production caller and the supervisor uses
  `isRunning(dockerId)` (available through the `Orchestrator` interface) instead. Delete it
  and its assertion in `orchestrator.test.ts:415` rather than leaving a method whose only
  caller is a test.
- Document the respawn contract in `docs/cadre-host.md` (donation section): what is
  supervised, the backoff/give-up numbers, and that a terminated loan stays terminated.
- `yarn workspace @serfab/cadre-host build && yarn workspace @serfab/cadre-host test`,
  plus `yarn lint`.

## Honest gaps for the reviewer

- No executed reproducing test was written at the fix stage (budget); the failure was
  established by code trace — the three blockers above are the load-bearing findings and
  each has a test listed in Phase 3.
- An `error`-after-give-up record keeps its workdir forever unless someone calls
  `terminate`. If stale `error` workdirs ever pile up, extend the reap sweep to them — a
  tripwire, not work for this ticket; leave it as a `NOTE:` beside the give-up branch.
