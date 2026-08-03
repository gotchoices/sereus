---
description: A restart attempt that fails part-way used to make the lending computer forget which process it was restarting, leaving that node's files undeletable on disk; it now puts everything back exactly as it found it.
files: packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, docs/cadre-host.md
difficulty: medium
---

# What landed

Two paths could leave a donation record naming a `dockerId` the orchestrator
could no longer resolve. Both ended the same way: `terminate()` swallowed the
resulting "Container not found" as a best-effort no-op, the node's working
directory (`<rootDir>/<containerId>/` — identity key, `cadre.json`, `node.log`,
storage) was never deleted, and the node vanished from the local UI's node list
while its files stayed on disk. Both are closed.

## Arm 1 — the orchestrator now restores a drop whose launch then failed

`HostProcessOrchestrator.createContainer` / `ensureOwnerNode` begin by dropping
the handle left over from a previous spawn of the same node and releasing its
four ports (this is what stops re-spawns leaking ports and what makes a retry
come back on the *same* ports). That drop happened before the child was
launched, so a launch failure discarded it permanently.

- `dropStaleHandle` now **returns** the handles it removed (`Handle[]`).
- New inverse `restoreDroppedHandles(dropped)` puts each back in the map and
  re-reserves its four ports.
- Both callers wrap drop → allocate → launch in `try`/`catch`: on any throw they
  **release the newly allocated ports first, then restore** (a re-spawn allocates
  the very ports the drop freed, so the other order would hand the restored
  handle's own ports back to the allocator).
- Both `resolvePush()` awaits moved to **before** their drop, so the drop→launch
  window is provably synchronous — the precondition the restore rests on. It is
  stated in the `restoreDroppedHandles` doc comment; `launchChild`'s doc now says
  "do not add an `await` here".
- `launchChild` no longer releases ports; callers own port lifetime. Its
  spawn-failure `closeSync(logFd)` stays, with a comment that it is the only
  fd-leak guard on that path and nothing between `openSync` and `spawn` can
  throw.
- New exported `allocateNodePorts(allocator, overrides?)` in `port-allocator.ts`
  — all-or-nothing: a mid-way failure (exhausted range) releases everything it
  already took. Replaces four separate `allocate()` calls in `createContainer`
  and the hand-rolled allocate-three-then-`markUsed` block in `ensureOwnerNode`
  (which also unifies the latter's inline drop onto `dropStaleHandle`).
- No `persist()` on the restore path — `state.json` is only rewritten by
  `launchChild` *after* the new handle is stored, so the restore realigns memory
  to disk rather than diverging from it. Commented at the site.

## Arm 2 — a respawn whose record write fails now records the new handle

`DonationService.respawn`'s catch merged only the attempt counters forward, so a
failed `store.put` left the record naming the *old* `dockerId` (already dropped
by `createContainer`) while the new, now-stopped child held the ports and
workdir. `storeAttempt` widened to
`storeRespawnAttempt(id, respawn, spawned?)`, merging the three handle fields
(`dockerId`, `seedEndpoint`, `seedToken` — typed as the new internal
`SpawnedHandles`) when the spawn itself succeeded. Still best-effort, still
leaves `status` and `updatedAt` alone (`updatedAt` is what defers the
stale-`awaiting_seed` reap and must not be bumped by a failure).

## Deviations from the ticket — read these first

1. **`allocateNodePorts` reserves overrides before allocating, not inline in key
   order.** The ticket specified allocating in `health, metrics, p2p, admin`
   order with each override `markUsed` when its key is reached. That leaves a
   hazard: an override inside the managed range and low enough to have already
   been handed out to `health`/`metrics` would silently duplicate that port
   (the same hazard the block it replaces had). Reserving overrides first kills
   it and shifts no real assignment — the only override in production is the
   owner node's libp2p port, which is outside the managed range, so `markUsed`
   is a no-op there. Allocated keys still come out in `health, metrics, admin`
   order, matching what deployments already hold.
2. **The ticket's override test assertion was not satisfiable as written.** It
   specified allocator `10000..10010` with `{ p2p: 10500 }` and expected
   `a.has(10500) === true`; `PortAllocator.markUsed` ignores out-of-range ports,
   so it is `false`. Split into two tests: an in-range override (`10005`) that
   asserts the reservation actually happens, and an out-of-range override
   (`40000`) that asserts the documented no-op — which is the production case.

## Validation

```
yarn workspace @serfab/cadre-host test          # 60 files, 524 passed | 4 skipped
yarn workspace @serfab/cadre-host build:server  # clean
yarn lint                                       # clean
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Tests added (and what each proves)

`packages/cadre-host/src/__tests__/orchestrator.test.ts` — new
`HostProcessOrchestrator failed launch` suite, driving the **real** orchestrator
against the fake child script. A launch failure is induced portably by replacing
`<workdir>/storage` with a plain file: `mkdirSync(path, {recursive:true})` throws
EEXIST on a non-directory on every platform, and it is the second statement in
`launchChild` — after the drop, before the spawn.

- *keeps the prior handle addressable* — after a failed re-spawn, `getNode('c1')`
  and `resolveDockerId('c1')` still return the first `dockerId`, `listNodes()`
  is unchanged, and `removeContainer(firstDockerId)` then deletes the workdir
  (`existsSync(workdir) === false`). This is the ticket's whole point.
- *does not shift the ports a successful retry comes back on* — un-sabotage,
  re-spawn, ports deep-equal the original; exactly one handle for `c1` after.
- *releases every port a failed FIRST spawn reserved* — range `12000..12100`;
  `c1` gets `12000..12003`, `c2` fails, `c3` gets `12004..12007` (with the leak
  it would start at 12008).
- *leaves the owner node addressable on its original ports* —
  `getOwnerAdminEndpoint()` still returns the pre-failure endpoint, the owner is
  still in `listNodes()`, and the next `ensureOwnerNode()` succeeds on identical
  ports with exactly one owner handle.

Plus an `allocateNodePorts` suite: fixed order, all-or-nothing on an exhausted
3-port range (`has()` false for all three), in-range override reserved,
out-of-range override accepted and not reserved.

`packages/cadre-host/src/donation/__tests__/donation-service.test.ts` — the
existing *"stops — but never reclaims — the new child when the post-spawn write
fails"* test now asserts the record names `dock_2` / `seed-token-2` /
`http://127.0.0.1:9002/seed`, with `status` and `updatedAt` unchanged and
`respawn.attempts === 1`. `FlakyDonationStore` already failed exactly one `put`,
which is required — a second failure would take out the merge write too and the
test would prove nothing.

## Known gaps — the reviewer's starting points

- **The synchronous-window precondition is argued, not tested.** The restore is
  sound only because no `await` sits between the drop and the launch. Nothing
  enforces it mechanically; a future `await` in `launchChild` or before the drop
  silently breaks the restore and no test would fail. Worth deciding whether
  that deserves a guard.
- **Only one failure point in `launchChild` is exercised.** The EEXIST sabotage
  fails at `mkdirSync(storage)`. Failures at `writeFileSync(cadre.json)`,
  `openSync(node.log)`, or `spawn()` share the same caller `catch`, so their
  coverage is by construction rather than per-statement.
- **`FakeOrchestrator` deliberately untouched** (ticket says so; owned by
  `plan/debt-fake-orchestrator-handle-fidelity`). It never drops handles, so the
  donation-service suite does not exercise the restore at all — arm 1 is covered
  only by the real-orchestrator tests.
- **A restored handle keeps `alive: true`** even if its child exited while it was
  out of the map (`launchChild`'s exit listener looks handles up by `dockerId`).
  Only reachable by re-spawning a *live* container, which `dropStaleHandle`'s own
  note forbids. Left as a `NOTE:` at the restore site per the ticket.
- **A failed *first* spawn still strands its workdir** — freshly written
  `identity.key`, nothing reclaims it. Explicitly out of scope; filed as
  `backlog/debt-failed-provision-strands-workdir` and now cross-referenced from
  `docs/cadre-host.md`. Deleting the workdir on spawn failure would be actively
  wrong on the *re*-spawn path.
- **`abandonRespawn`'s `error`-branch port leak NOTE is untouched** — still
  unreachable while the supervisor is the sole `respawn` caller, still
  documented in place.
- **Concurrency is unmodelled in tests.** No test drives a concurrent
  `provision` for a different grant, or a concurrent `terminate` for this one,
  against the drop→launch window.

## Doc + comment updates made

- `host-process-orchestrator.ts` — `dropStaleHandle`'s closing paragraph now
  states the new invariant (a failed launch restores the drop; a successful one
  keeps it, which `abandonRespawn` depends on) instead of pointing at this
  ticket's old backlog slug. `restoreDroppedHandles` carries the
  synchronous-window precondition, the no-`persist()` rationale, and the
  `alive: true` NOTE.
- `donation-supervisor.ts` `giveUp` — the catch comment no longer says a failed
  stop is *expected*; the `try`/`catch` stays for a handle lost to a host
  restart, and the ticket slug is gone.
- `donation-service.ts` — the `respawn` catch comment now says the record names
  the child that actually exists; `storeRespawnAttempt`'s doc explains why
  recording the handle matters and why `status`/`updatedAt` stay put.
- `docs/cadre-host.md` — new paragraph in the respawn section: a failed respawn
  leaves host state untouched so a later `terminate()` still reclaims the
  workdir, with the failed-first-provision case called out as the exception. The
  "an ending that lands mid-operation wins" section (successful-spawn path) was
  left alone.

No source file references the old backlog slug any more (only tickets do).
