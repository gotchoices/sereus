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

## Arm 1 — the orchestrator restores a drop whose launch then failed

`HostProcessOrchestrator.createContainer` / `ensureOwnerNode` begin by dropping
the handle left over from a previous spawn of the same node and releasing its
four ports (this is what stops re-spawns leaking ports and what makes a retry
come back on the *same* ports). That drop happened before the child was
launched, so a launch failure discarded it permanently.

- `dropStaleHandle` returns the handles it removed (`Handle[]`).
- Inverse `restoreDroppedHandles(dropped)` puts each back in the map and
  re-reserves its four ports.
- Both callers wrap drop → allocate → launch in `try`/`catch`: on any throw they
  release the newly allocated ports first, then restore (a re-spawn allocates
  the very ports the drop freed, so the other order would hand the restored
  handle's own ports back to the allocator).
- Both `resolvePush()` awaits sit **before** their drop, so the drop→launch
  window is synchronous — the precondition the restore rests on.
- `launchChild` no longer releases ports; callers own port lifetime. Its throw
  surface ends where the child is spawned and its handle stored; everything
  after that point is best-effort (see *Review findings*).
- Exported `allocateNodePorts(allocator, overrides?)` in `port-allocator.ts` —
  all-or-nothing: a mid-way failure (exhausted range) releases everything it
  already took. Replaces four separate `allocate()` calls in `createContainer`
  and the hand-rolled allocate-three-then-`markUsed` block in `ensureOwnerNode`.
  Overrides are reserved before any allocation so an override inside the managed
  range cannot also be handed out to another key.
- No `persist()` on the restore path — `state.json` is only rewritten by
  `launchChild` *after* the new handle is stored, so the restore realigns memory
  to disk rather than diverging from it.

## Arm 2 — a respawn whose record write fails records the new handle

`DonationService.respawn`'s catch merged only the attempt counters forward, so a
failed `store.put` left the record naming the *old* `dockerId` (already dropped
by `createContainer`) while the new, now-stopped child held the ports and
workdir. `storeAttempt` widened to `storeRespawnAttempt(id, respawn, spawned?)`,
merging the three handle fields (`dockerId`, `seedEndpoint`, `seedToken` — typed
as the internal `SpawnedHandles`) when the spawn itself succeeded. Still
best-effort, still leaves `status` and `updatedAt` alone (`updatedAt` is what
defers the stale-`awaiting_seed` reap and must not be bumped by a failure).

## Implementation deviations from the plan

1. **`allocateNodePorts` reserves overrides before allocating, not inline in key
   order.** Allocating in `health, metrics, p2p, admin` order with each override
   `markUsed` when its key is reached leaves a hazard: an override inside the
   managed range and low enough to have already been handed out to
   `health`/`metrics` would silently duplicate that port. Reserving overrides
   first kills it and shifts no real assignment — the only override in
   production is the owner node's libp2p port, which is outside the managed
   range, so `markUsed` is a no-op there.
2. **The plan's override test assertion was not satisfiable as written** —
   allocator `10000..10010` with `{ p2p: 10500 }` expecting `a.has(10500)`;
   `markUsed` ignores out-of-range ports. Split into an in-range override
   (`10005`, asserts the reservation happens) and an out-of-range one (`40000`,
   asserts the documented no-op, which is the production case).

## Validation

```
yarn workspace @serfab/cadre-host test          # 60 files, 525 passed | 4 skipped
yarn workspace @serfab/cadre-host build:server  # clean
yarn lint                                       # clean
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

The `../quereus` sibling workspace was rebuilt twice during this pass — the
shared stale-build guard in `test-harness/` tripped because another agent was
editing `quereus/packages/quereus/src` concurrently. Not a defect in either
tree; noted so the next reader does not chase it.

## Tests

`packages/cadre-host/src/__tests__/orchestrator.test.ts` — the
`HostProcessOrchestrator failed launch` suite drives the **real** orchestrator
against the fake child script. A launch failure is induced portably by replacing
`<workdir>/storage` with a plain file: `mkdirSync(path, {recursive:true})` throws
EEXIST on a non-directory on every platform, and it is the second statement in
`launchChild` — after the drop, before the spawn.

- *keeps the prior handle addressable* — after a failed re-spawn, `getNode('c1')`
  and `resolveDockerId('c1')` still return the first `dockerId`, `listNodes()` is
  unchanged, and `removeContainer(firstDockerId)` then deletes the workdir.
- *does not shift the ports a successful retry comes back on*.
- *releases every port a failed FIRST spawn reserved* — range `12000..12100`;
  `c1` gets `12000..12003`, `c2` fails, `c3` gets `12004..12007`.
- *leaves the owner node addressable on its original ports*.
- *does not unwind a launch that already spawned when the state write fails*
  (added in review — see findings).

Plus an `allocateNodePorts` suite: fixed order, all-or-nothing on an exhausted
3-port range, in-range override reserved, out-of-range override accepted and not
reserved.

`packages/cadre-host/src/donation/__tests__/donation-service.test.ts` — the
existing *"stops — but never reclaims — the new child when the post-spawn write
fails"* test asserts the record names `dock_2` / `seed-token-2` /
`http://127.0.0.1:9002/seed`, with `status` and `updatedAt` unchanged and
`respawn.attempts === 1`.

# Review findings

## Checked and clean

- **Both unwind paths, statement by statement.** Release-before-restore is the
  correct order and the comment explaining it is accurate. `ensureOwnerNode`'s
  `releasePorts(ports)` on the catch frees the pinned libp2p port too, which is
  right when there is no prior handle and harmless when there is, because the
  restore immediately re-reserves it.
- **`allocateNodePorts` atomicity**, including the case where the failure lands
  on the first `allocate()` (nothing reserved, nothing to release) and the case
  where an out-of-range override sits in the `reserved` list (release of an
  unheld port is a no-op `Set.delete`).
- **Allocation order is genuinely preserved** for both callers.
  `createContainer` allocated `health, metrics, p2p, admin` before and does now;
  `ensureOwnerNode` allocated `health, metrics, admin` with p2p pinned, and
  reserving the override first does not consume a range slot, so the three
  allocated keys still come out in the same order.
- **The donation-service merge.** `{ ...current, respawn, ...spawned }` cannot
  resurrect a deleted row (guarded on `current`), does not touch `status` or
  `updatedAt`, and spreads a `undefined` `spawned` harmlessly.
- **`DockerOrchestrator` (cadre-provider) does not need arm 1** — it keys
  containers by Docker name and has no drop-stale-handle step, so the failure
  mode does not exist there.
- **Docs.** Read `docs/cadre-host.md`'s whole respawn section against the new
  code; the added paragraph is accurate and the neighbouring "an ending that
  lands mid-operation wins" text is still correct. No other doc, and no source
  file, still references the ticket's old backlog slug (verified by grep).
- **The handoff's "concurrency is unmodelled in tests" gap is a non-issue, not a
  hole.** The drop→launch window contains no `await`, so on a single-threaded
  event loop nothing can interleave inside it — there is no concurrent
  interleaving to model. Operations racing the *awaits before* the drop are the
  already-designed-for "an ending that lands mid-operation wins" case, covered
  by `respawn`'s re-read and `abandonRespawn`.
- **The handoff's "synchronous window is argued, not tested" gap is half
  closed by the compiler.** `launchChild`'s declared return type is not a
  Promise, so adding an `await` inside it is a compile error. Only the callers'
  half (an `await` slipped between drop and launch) is unenforced; that is now
  stated precisely in the `restoreDroppedHandles` doc rather than as a blanket
  "nothing enforces it".

## Found and fixed in this pass

- **A `state.json` write failure after the child is up would have triggered the
  caller's unwind** (`host-process-orchestrator.ts`). `launchChild` calls
  `persist()` *after* storing the new handle, and `StateStore.save` does real
  `writeFileSync` + `renameSync` — an ENOSPC/EPERM there threw out of
  `launchChild` into the caller's new `catch`, which would release the ports the
  freshly spawned, still-running child is bound to and restore the handle this
  spawn had just replaced: two handles for one container, one holding unreserved
  ports the allocator can hand out again. Strictly worse than the pre-diff
  behaviour, where the same throw merely propagated. Fixed by making the state
  mirror best-effort past the point the handle is stored (logged, not swallowed
  silently; the next `persist()` from any stop/remove/spawn rewrites the whole
  map). `launchChild`'s doc now states that its throw surface ends there.
  Regression test added: *does not unwind a launch that already spawned when the
  state write fails*.
- **Duplicated port-reservation block** (`host-process-orchestrator.ts`).
  `restoreDroppedHandles` open-coded four `markUsed` calls, a near-copy of
  `init()`'s — and without `init()`'s guard, so a handle persisted before
  `admin` existed would have put `undefined` into the allocator's used-set.
  Extracted `reservePorts(ports)` as the stated inverse of `releasePorts`; both
  sites now use it and the legacy-`admin` guard applies to both.
- **An entry-time whole-row `Donation` copy left in scope**
  (`donation-service.ts`). `respawn` built `attempted: Donation` purely to carry
  two counters, while every comment in the method warns against writing an
  entry-time copy back. Replaced with a `RespawnAttempt` (`= NonNullable<
  Donation['respawn']>`) holding just the counters. That also lets
  `storeRespawnAttempt` take a non-optional `respawn`, removing a guard whose
  `!respawn` arm would silently have dropped the new handle fields as well as
  the counters.

## Recorded as tripwires (conditional; no ticket)

- `ensureOwnerNode`'s liveness short-circuit matches an owner handle via
  `findOwnerHandle()` (owner flag **or** containerId) while the drop below it
  matches only by containerId. Equivalent today because every owner handle is
  launched with `OWNER_CONTAINER_ID`; if that ever stops being true the two
  disagree and the handle leaks. `NOTE:` at the drop site.

## Filed as new work

- `backlog/debt-duplicate-port-allocator-across-orchestrators` — cadre-provider's
  `docker-orchestrator.ts` carries a module-private `PortAllocator` whose
  `allocate`/`release` bodies are line-for-line identical to cadre-host's
  exported one (~15 lines of exact overlap), plus its own all-or-nothing
  `allocatePorts(count)`. Pre-existing, but this diff added the second
  all-or-nothing wrapper, so the overlap is now wider. Not fixable inside this
  ticket: it changes cadre-provider's module surface.

## Known gaps carried forward, judged acceptable

- **Only one failure point in `launchChild` is exercised.** The EEXIST sabotage
  fails at `mkdirSync(storage)`. Failures at `writeFileSync(cadre.json)`,
  `openSync(node.log)`, or `spawn()` share the same caller `catch`, so their
  coverage is by construction. Not worth four more near-identical tests.
- **`FakeOrchestrator` deliberately untouched** — owned by
  `plan/debt-fake-orchestrator-handle-fidelity`. It never drops handles, so the
  donation-service suite does not exercise the restore; arm 1 is covered only by
  the real-orchestrator tests.
- **A restored handle keeps `alive: true`** even if its child exited while it was
  out of the map. Only reachable by re-spawning a *live* container, which
  `dropStaleHandle`'s own note forbids. `NOTE:` at the restore site.
- **A failed *first* spawn still strands its workdir** — freshly written
  `identity.key`, nothing reclaims it. Out of scope; tracked by
  `backlog/debt-failed-provision-strands-workdir` and cross-referenced from
  `docs/cadre-host.md`. Deleting the workdir on spawn failure would be actively
  wrong on the *re*-spawn path.
- **`abandonRespawn`'s `error`-branch port leak `NOTE:` is untouched** — still
  unreachable while the supervisor is the sole `respawn` caller, still documented
  in place.
- **`host-process-orchestrator.ts` is 1052 lines** (`wc -l`). Large, but the
  growth from this ticket is ~80 net lines of a cohesive concern, and no open
  ticket claims a split. Not filed — a split proposal should come from someone
  reworking the file, not from a review of an unrelated change.
- **Pre-existing, not touched:** the constructor's `private readonly cfg:
  HostProcessConfig` is never read (TS 6138; ESLint does not flag it). Outside
  this diff.
