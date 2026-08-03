---
description: When the lending computer tries and fails to restart a machine it lent out, it forgets which process that machine was, so later cleanup can no longer delete the machine's files — they sit on disk forever.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, docs/cadre-host.md
difficulty: medium
---

# A failed re-spawn must leave host state exactly as it found it

Every donated node has a working directory on the host (`<rootDir>/<containerId>/`)
holding its identity key, its `cadre.json`, its `node.log`, and its storage. The
orchestrator tracks a running node by an opaque handle id (`dockerId`), and that
id is recorded on the donation record. All cleanup — `stopContainer`,
`removeContainer` — goes through that recorded id.

Two paths currently break that link, and both end the same way: the donation
record names a `dockerId` the orchestrator cannot resolve, `terminate()` swallows
both "Container not found" errors as best-effort no-ops, and the working
directory is never deleted. The node also disappears from the local UI's node
list while its files are still on disk.

Since the last time this was written up, `DonationSupervisor` has landed and is
wired into `src/bin/host.ts:315`, so `respawn()` **is** reachable in production —
this is a live defect, not a dormant one.

## Arm 1 — the orchestrator drops the prior handle before it can fail

`HostProcessOrchestrator.createContainer` begins by discarding the handle left
over from any previous spawn of the same node (`dropStaleHandle`,
`host-process-orchestrator.ts:589`) and releasing its four ports. That discard is
what stops re-spawns from leaking ports, and releasing before re-allocating is
what makes the retry come back on the *same* four ports (`PortAllocator.allocate`
returns the lowest free port in the range, so a release-then-allocate pair
round-trips). But it happens *before* the child is launched, so if the launch
then throws, the handle is gone for good while the donation record still names
it.

`ensureOwnerNode` (`:331`-`:342`) has the identical shape for the host's own
owner node.

A second, smaller leak sits underneath: `launchChild` releases the allocated
ports only on a synchronous `spawn()` failure and on a missing `child.pid`. Every
earlier step in it — `mkdirSync(workdir)`, `mkdirSync(workdir/storage)`,
`writeFileSync(cadre.json)`, `openSync(node.log)` — can throw and leaks all four.
And `createContainer` allocates its four ports with four separate
`portAllocator.allocate()` calls, so an exhausted range throws on (say) the third
and leaks the two already taken.

### The fix

Make the drop reversible, and make port allocation all-or-nothing.

- `dropStaleHandle(containerId)` returns the handles it removed
  (`Handle[]` — it already loops, so more than one is possible defensively).
- A new inverse — `restoreDroppedHandles(dropped: Handle[])` — puts each back in
  the map and `markUsed`s its four ports.
- `createContainer` and `ensureOwnerNode` wrap everything from the drop through
  `launchChild` in a `try`/`catch` that calls the inverse and rethrows.
- `launchChild` no longer releases ports itself; its callers own port lifetime
  and release on any throw. Keep its `closeSync(logFd)` on the spawn-failure
  branch (nothing between `openSync` and `spawn` can throw — state that in a
  comment so a future edit does not quietly introduce an fd leak).
- New exported helper in `port-allocator.ts`:

  ```ts
  /** Allocate a full NodePorts set atomically — a mid-way failure releases
   *  everything already taken. `overrides` supply a port instead of allocating
   *  it (the owner node's p2p port, which is fixed by NAT config). */
  export function allocateNodePorts(
    allocator: PortAllocator,
    overrides?: Partial<NodePorts>,
  ): NodePorts
  ```

  Allocation order stays `health, metrics, p2p, admin` (skipping overridden
  keys) so existing port assignments do not shift. Each override is `markUsed`.
  `createContainer` calls `allocateNodePorts(this.portAllocator)`;
  `ensureOwnerNode` calls
  `allocateNodePorts(this.portAllocator, { p2p: config.libp2pPort })`, replacing
  its hand-rolled allocate-three-then-`markUsed(libp2pPort)` block.

### The restore is only sound because the window is synchronous

Restoring a handle is safe only if nothing else could have taken its ports or
run cleanup against it between the drop and the failure. `launchChild` is
entirely synchronous, so the window contains no `await` — **except** that
`createContainer` currently `await`s `this.resolvePush()` after the drop, and
`ensureOwnerNode` `await`s it between its drop and its allocation.

Move both `resolvePush()` calls to **before** the drop (they are independent of
it — `resolvePush` catches its own failures and degrades to `undefined`). Then
the drop → launch window is provably synchronous, and a concurrent `provision`
for a different grant, or a concurrent `terminate` for this one, cannot
interleave. Say this in a comment on `restoreDroppedHandles`: it is the
precondition the whole approach rests on.

No `persist()` on the restore path: `state.json` is only rewritten by
`launchChild` *after* the handle is stored, so in the failure window the on-disk
state still lists the dropped handle and the restore realigns memory to it.
Comment that too.

### Alternative considered and rejected

Reuse the stale handle's exact ports for the new spawn (never release them) and
drop the old handle only once the child is up. That needs no failure-path
restore at all and gives strictly stronger port stability — but it moves port
ownership into `launchChild`'s success path, forces `launchChild` to distinguish
reused ports (which must not be released on failure) from fresh ones, and
complicates `ensureOwnerNode`, whose `p2p` is pinned by `config.libp2pPort` and
can legitimately change between calls. The restore is the smaller, more
reviewable diff and leaves the success path byte-for-byte unchanged. Recorded
here so a reviewer does not re-derive it.

## Arm 2 — a respawn whose record write fails also strands the workdir

Same symptom, different trigger, in `DonationService.respawn`
(`donation-service.ts:535`). If `store.put(respawned)` throws — a disk error —
the catch stops the new child and calls `storeAttempt`, which merges **only** the
attempt counters forward. So the record keeps naming the *old* `dockerId`, which
`createContainer` already dropped, while the new (now stopped) handle holds the
ports and the workdir. Later cleanup targets the wrong id and the workdir
strands.

By the time that `put` runs, the post-spawn re-read has already established the
record is still respawnable and nothing can have changed it (no `await` between
the re-read and the write), so merging the new handle onto disk is unambiguously
correct.

Widen `storeAttempt` into something like:

```ts
private storeRespawnAttempt(
  id: string,
  respawn: Donation['respawn'],
  spawned?: { dockerId: string; seedEndpoint: string; seedToken: string },
): void
```

merging the counters and, when `spawned` is present, the three handle fields —
onto whatever is on disk now, still best-effort, still leaving `status` and
`updatedAt` alone (the attempt did not succeed; `updatedAt` is what defers the
stale-`awaiting_seed` reap and must not be bumped by a failure).

## Expected behaviour after both arms

- A re-spawn attempt that fails to launch leaves the orchestrator exactly as it
  was: the prior handle is still in `listNodes()` / `getNode()`, still owns its
  four ports, and `terminate()` afterwards stops it, removes it, and deletes the
  working directory.
- A successful retry after a failed attempt comes back on the *same* four ports
  — the no-leak property `dropStaleHandle` exists for.
- A first spawn that fails releases every port it reserved, so the next
  container starts at the same base port.
- A respawn whose record write fails leaves the record naming the child that
  actually exists.

## Edge cases & interactions

- **Failed re-spawn, then terminate.** The canonical case. Workdir gone, node
  gone from the node list, ports free.
- **Failed re-spawn, then successful re-spawn.** Identical ports to the original
  handle; exactly one handle for the container afterwards.
- **Failed *first* spawn** (no prior handle to restore). Nothing is restored,
  all four ports are released. Note the workdir survives with a freshly written
  `identity.key` and nothing ever reclaims it — that is a separate, pre-existing
  gap, filed as `backlog/debt-failed-provision-strands-workdir`. Do not fix it
  here; deleting the workdir on spawn failure would be actively wrong on the
  *re*-spawn path, where it is the whole point of coming back as the same node.
- **Partial port allocation.** Range exhausted on the 3rd of 4 allocations →
  the first two are released.
- **Success path unchanged.** `abandonRespawn`'s reclaim rationale (and its
  write-up in `docs/cadre-host.md`) depends on the stale handle being gone after
  a *successful* spawn. The restore fires only on failure, so that reasoning
  still holds — do not weaken it.
- **`ensureOwnerNode` with a changed `libp2pPort`.** A failed call restores the
  old handle carrying the old p2p port; the next successful call allocates
  against the new `libp2pPort` and drops the restored handle, releasing the old
  one. Verify `releasePorts` covers it (it does — all four keys).
- **Two handles for one containerId.** Defensive, but `dropStaleHandle` loops;
  the restore must put back everything it removed.
- **A restored handle whose child exits later.** `launchChild`'s
  `child.once('exit')` listener looks the handle up by `dockerId`; a handle that
  was out of the map when the exit fired stays `alive: true` after restore. Only
  reachable if a caller re-spawns a *live* container, which `dropStaleHandle`'s
  own NOTE already forbids. Leave a `NOTE:` at the restore site rather than
  adding machinery.
- **`donations.json` write fails on the retry too** (arm 2). Best-effort: log
  and move on. The supervisor's next pass re-reads the record, finds the old
  `dockerId` not running, and respawns again — which drops whatever handle is
  current, so ports still self-heal.

## Test plan

`packages/cadre-host/src/__tests__/orchestrator.test.ts` already drives the real
`HostProcessOrchestrator` against a fake child script via the
`spawn.entrypoint` override — put the orchestrator tests there.

Inducing a launch failure portably: replace the workdir's `storage` directory
with a *file*. `mkdirSync(path, { recursive: true })` throws `EEXIST` when the
path exists as a non-directory on every platform, and it is the second statement
in `launchChild`, so it fails after the drop and before the spawn.

- **failed re-spawn keeps the prior handle addressable** — spawn `c1`, stop it,
  `rmSync(<workdir>/storage, {recursive:true})` + `writeFileSync(<workdir>/storage,'x')`,
  expect the second `createContainer({containerId:'c1'})` to reject; then
  `getNode('c1')?.dockerId` still equals the first `dockerId`, `listNodes()` has
  the same length, and `removeContainer(firstDockerId)` resolves with
  `existsSync(workdir) === false` afterwards.
- **failed re-spawn does not shift ports** — same setup, then delete the
  sabotage file and re-spawn successfully; the new handle's `ports` deep-equal
  the original handle's.
- **failed first spawn releases its ports** — `portRange {start:12000,end:12100}`;
  spawn `c1` (gets 12000–12003); pre-create `<rootDir>/c2/storage` as a file and
  expect `createContainer({containerId:'c2'})` to reject; spawn `c3` and assert
  its ports are 12004–12007 (with the leak they would be 12008+).
- **owner node** — same sabotage against the owner workdir: `ensureOwnerNode()`
  rejects, `getOwnerAdminEndpoint()` still returns the pre-failure endpoint and
  the owner is still in `listNodes()`; after un-sabotaging, `ensureOwnerNode()`
  succeeds on the same ports.
- **`allocateNodePorts` is all-or-nothing** — `new PortAllocator(13000, 13002)`
  (3 ports); expect the call to throw `/No available ports/`; then
  `allocator.has(13000|13001|13002)` are all `false`.
- **`allocateNodePorts` honours an override** — allocator `10000..10010`,
  `allocateNodePorts(a, { p2p: 10500 })` returns
  `{health:10000, metrics:10001, p2p:10500, admin:10002}` and `a.has(10500)` is
  `true`.

`packages/cadre-host/src/donation/__tests__/donation-service.test.ts`:

- **a respawn whose record write fails records the new handle** — wrap
  `DonationStore` so its `put` throws exactly once, on the write that follows the
  second `createContainer` (it must throw once only, or the merge write in the
  catch fails too and the test proves nothing). Expect
  `svc.respawn(id)` to reject with `{ code: 'orchestrator_error' }`, then
  `store.get(id)?.dockerId === 'dock_2'`, `seedToken === 'seed-token-2'`, and
  `orch.stopped` containing `dock_2`.

**Do not change `FakeOrchestrator` in this ticket.** Its divergence from the
real class is owned by `plan/debt-fake-orchestrator-handle-fidelity`, which is
now gated behind this one precisely so it models the *post*-fix semantics: the
faithful fake must drop a prior handle on a **successful** create only, never on
a failing one.

## Doc + comment updates

- `host-process-orchestrator.ts` — `dropStaleHandle`'s closing paragraph
  currently points at `backlog/debt-failed-respawn-strands-donated-workdir`.
  Replace it with a statement of the new invariant (a failed launch restores the
  drop) and the synchronous-window precondition.
- `donation-supervisor.ts:376` — the `giveUp` catch comment says a failed stop is
  *expected* because "the failed respawn already dropped the handle", citing the
  same slug. After this change the stop succeeds. Keep the `try`/`catch` (a
  record can still name a handle lost to a host restart) but rewrite the reason
  and drop the slug.
- `donation-service.ts` — the `respawn` catch comment claiming "the orphaned
  handle's ports are released by the next createContainer, so the leak is
  self-healing" describes arm 2's old behaviour; update it to say the record now
  names the child that exists.
- `docs/cadre-host.md` — in the respawn paragraph (~line 112), add that a
  respawn attempt that fails to launch leaves host state untouched, so a later
  `terminate()` still reclaims the workdir. Leave the "an ending that lands
  mid-operation wins" section (~line 116) alone: it describes the *successful*
  spawn path, which is unchanged.

## TODO

- Add `allocateNodePorts` to `port-allocator.ts` (all-or-nothing, `overrides`
  support); switch `createContainer` and `ensureOwnerNode` onto it.
- Move both `resolvePush()` awaits to before their respective handle drops.
- Make `dropStaleHandle` return the dropped handles; add
  `restoreDroppedHandles`; wrap drop→launch in `try`/`catch` in
  `createContainer` and `ensureOwnerNode`.
- Unify `ensureOwnerNode`'s inline drop (releasePorts + `handles.delete`) onto
  the same drop/restore pair.
- Remove `launchChild`'s own `releasePorts` calls; callers own port lifetime.
- Widen `storeAttempt` → `storeRespawnAttempt` to merge the new handle fields
  when the spawn succeeded but the record write failed.
- Write the orchestrator, port-allocator, and donation-service tests above.
- Update the four comment/doc sites listed under *Doc + comment updates*.
- Validate, streaming output:
  `yarn workspace @serfab/cadre-host test 2>&1 | tee /tmp/cadre-host-test.log`,
  `yarn workspace @serfab/cadre-host build:server`, `yarn lint`.
