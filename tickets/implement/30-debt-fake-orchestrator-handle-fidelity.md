---
description: The stand-in used by the donated-node tests is more forgiving than the real thing, so the tests cannot express the failure the real thing produces. Make the stand-in behave like the real one and add the tests that were impossible before.
files: packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/donation-service.ts
difficulty: medium
---

# Make `FakeOrchestrator` mirror `HostProcessOrchestrator`'s handle lifecycle

The donation unit tests run against `FakeOrchestrator`
(`packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts`), a stand-in for
`HostProcessOrchestrator` that spawns no child processes. It is more permissive than the real class
in two ways, and the gap is what stops the suite from expressing the race that
`DonationService.abandonRespawn` exists for.

## Measured starting point — read this before planning the work

The planning pass ran the experiment rather than reasoning about it. Three findings, each from an
actual run of `yarn vitest run src/donation/__tests__` in `packages/cadre-host`:

1. **Baseline is 84 passing tests across 4 files.**
2. **Making the fake faithful breaks nothing.** With both divergences closed (drop-on-successful-create,
   throw on unknown handle), all 84 still pass. The plan ticket predicted that "several current tests
   assert on `orch.stopped` / `orch.removed` containing handles that a faithful fake would reject" —
   that prediction is **wrong**. Do not go looking for assertions to re-derive; there are none. The
   real work of this ticket is the tests the faithful fake makes *possible*, not the ones it breaks.
3. **Getting the drop condition wrong does break exactly one test.** With an *unconditional* drop
   (dropping the prior handle even when the create then fails), `donation-supervisor.test.ts` →
   `'gives up after the attempt cap: record → error, child stopped but not reclaimed'` fails with
   `expected [] to include 'dock_1'`. That existing test is therefore the standing guard on the
   success-only rule below — leave it green, and add a comment there saying so.

## Divergence 1 — the fake keeps old handles alive across a re-spawn

`HostProcessOrchestrator.createContainer` calls `dropStaleHandle(request.containerId)`
(`host-process-orchestrator.ts:263`, implementation at `:618`) while spawning. Handles are keyed by
the per-spawn `dockerId`, so that call deletes any handle left from a previous spawn of the same
container and releases its four ports. The fake never drops: every spawn adds another entry and both
the old and new handle stay resolvable forever.

**The drop is conditional, and both halves of the condition matter.**

- On a create that **succeeds**, the drop stands. `DonationService.abandonRespawn`
  (`donation-service.ts:597`) depends on the old handle being gone by then.
- On a create that **fails**, the real class calls `restoreDroppedHandles(dropped)`
  (`host-process-orchestrator.ts:288`, implementation at `:654`) — the handle and its four ports go
  back exactly as they were. So a fake that dropped unconditionally would be a fresh divergence in
  the opposite direction. Finding 3 above is that divergence caught by an existing test.

**Timing matters too.** In the real class every `await` (`ensureNodeIdentity`, `resolvePush`) happens
*before* the drop, and drop → launch → return is fully synchronous. So the drop must land in the fake
**after** `onCreate` and after the `createDelayMs` sleep, immediately before the new child is
registered. Anything else models a window the real class does not have.

## Divergence 2 — the fake never reports an unknown handle

The real `stopContainer` (`:696`) and `removeContainer` (`:751`) both go through `requireHandle`
(`:828`), which throws ``Container not found: ${dockerId}`` for a handle the orchestrator no longer
knows. The fake's `stopContainer` and `removeContainer` accept any string and quietly record it in
`orch.stopped` / `orch.removed`.

## Why the two together matter

`DonationService.abandonRespawn` reclaims — rather than merely stops — the child an abandoned respawn
started. Its stated reason:

> when a `terminate` lands while a respawn is spawning, the terminate's own stop-and-reclaim hits a
> handle the in-flight spawn already dropped, so it cleans up **nothing** — which is why the respawn
> must reclaim the child it just started rather than merely stop it.

Nothing in the suite demonstrates that premise. The existing race tests
(`donation-service.test.ts` → `'lets a borrower terminate that lands mid-spawn win, and cleans up the
new child'`, and its stale-seed-reap sibling) drive the concurrent `terminate` from `onCreate`, which
fires at the *start* of the spawn — before the real class would have dropped anything. So the
terminate's own cleanup succeeds there, and the test asserts the right end state for the wrong
reason. It also asserts with `toContain`, so it cannot tell the two worlds apart either way.

The window the premise describes is the one **after** the drop: the real drop → launch → return runs
synchronously, so no code interleaves inside it, but a `terminate` already parked in an `await` can
resume in the microtask gap between `createContainer` completing and `respawn`'s own `await`
continuation. That is reachable in the real system, and the fake has no hook that lands there.

## What to build

### The fake

- `createContainer`: on a **successful** create only, delete every entry in `children` whose
  `containerId` matches the request, then register the new child. Placement: after the `failCreate`
  throw and after the `createDelayMs` sleep. Comment it against `dropStaleHandle` /
  `restoreDroppedHandles` so the success-only condition reads as deliberate.
- `stopContainer` / `removeContainer`: throw ``Container not found: ${dockerId}`` for a `dockerId` not
  in `children`, mirroring `requireHandle`.
  - Keep the existing `onStop?.(dockerId)` call **before** the check, so a test can still observe that
    a stop was attempted even when it is rejected. (Verified: every existing test stays green with
    this ordering.)
  - Push onto `stopped` / `removed` only **after** the check passes. Those arrays then mean "handles
    this orchestrator actually acted on", not "calls attempted" — which is precisely what gives the
    new premise test its teeth. Say so in the class docstring, since two arrays named `stopped` and
    `removed` invite the other reading.
- Add an `onSpawned?: (dockerId: string) => void` observation hook, fired after the drop and after the
  new child is registered, immediately before `createContainer` resolves. This is the only way a test
  can drive concurrent work into the post-drop window. Document the contrast with `onCreate` on both
  hooks: `onCreate` models the real class's pre-drop `await` window; `onSpawned` models the microtask
  gap between the real `createContainer` returning and its caller's `await` resuming.
- The file header currently says "Not collected as a suite — vitest's `include` only matches
  `*.test.ts`." Adding `fake-orchestrator.test.ts` beside it makes that sentence misleading; reword it.

### The premise test (`donation-service.test.ts`, under `describe('DonationService.respawn')`)

Prototyped during planning against a faithful fake: it passes, and against today's fake it fails with
`expected [ 'dock_1', 'dock_2' ] to deeply equal [ 'dock_2' ]`. Shape:

```ts
// provision → dock_1, force status 'seeded'
let terminated: Promise<void> | undefined;
orch.onSpawned = () => { terminated ??= svc.terminate(provisioned.id); };

const result = await svc.respawn(provisioned.id);
await terminated;

expect(result).toEqual({ outcome: 'abandoned', status: 'terminated' });
// Exact equality, not toContain: dock_1's ABSENCE is the whole claim. The ending's
// own stop+reclaim aimed at dock_1, which this spawn had already dropped, so it
// cleaned up nothing — which is why abandonRespawn must reclaim dock_2, not just stop it.
expect(orch.stopped).toEqual(['dock_2']);
expect(orch.removed).toEqual(['dock_2']);
expect(store.get(provisioned.id)!.status).toBe('terminated');
expect(store.get(provisioned.id)!.dockerId).toBe('dock_1');
expect(store.liveNodeCount(token)).toBe(0);
```

`createDelayMs` is not needed — `onSpawned` fires synchronously and `terminate` writes its
`terminated` row before its first `await`, so the row is terminal by the time `respawn` re-reads.

Write the test's comment so it names the claim, not the mechanism: a reader should learn *why*
`dock_1` is missing from `stopped`, not just that it is.

### The fake's own contract suite (`fake-orchestrator.test.ts`, new, same directory)

Small — it exists so a future agent cannot make a failing donation test go green by relaxing the fake.
Each case should say which real-class behaviour it mirrors:

- a successful create for a `containerId` drops the prior handle → `stopContainer(old)` rejects with
  `Container not found` (mirrors `dropStaleHandle`);
- a create that fails (`failCreate = true`) leaves the prior handle in place → `stopContainer(old)`
  resolves (mirrors `restoreDroppedHandles`);
- `removeContainer` on a never-issued `dockerId` rejects with `Container not found` (mirrors
  `requireHandle`);
- `removeContainer` then `stopContainer` on the same handle: the second rejects (mirrors the real
  class deleting from `handles` on remove).

### The guard comment

In `donation-supervisor.test.ts` → `'gives up after the attempt cap: …'`, add a line at the
`expect(h.orch.stopped).toContain(view.dockerId)` assertion recording that it is what pins the
fake's success-only drop: a fake that dropped on a failed create would leave `giveUp` with no handle
to stop and this assertion would fail. Cite the observed failure (`expected [] to include 'dock_1'`).

## Edge cases & interactions

- **Success-only drop.** Covered by `'gives up after the attempt cap'` (see Finding 3) and by the
  `failCreate` case in the new contract suite. Both must be green.
- **Drop ordering vs. `onCreate` / `createDelayMs`.** The drop must land *after* both. Getting this
  wrong is silently wrong rather than red: the existing tests that terminate from `onCreate`
  (`'lets a borrower terminate that lands mid-spawn win, and cleans up the new child'` and
  `'lets a stale-seed reap that lands mid-spawn win without restarting the TTL clock'`) would start
  seeing a dropped `dock_1` and their `toContain` assertions would still pass. Verify by reading, not
  only by running: those two tests must still show `dock_1` in `orch.removed`.
- **`onStop` fires on a rejected stop.** `donation-service.test.ts` →
  `'marks the record terminated BEFORE stopping the child'` and
  `'leaves a loan alone when a seed lands mid-sweep, before its turn comes up'` both drive store
  writes from `onStop`. Both aim at handles the fake knows, so neither changes — but if you move the
  `onStop` call after the check, re-check them.
- **`resolveDockerId` after a drop.** The fake resolves `containerId` → `dockerId` by scanning
  `children`. Once the drop lands, a dropped handle stops resolving — same as the real class. The
  `reapStaleProvisioning` tests use it against single-spawn containers, so they are unaffected;
  confirm rather than assume.
- **Double-terminate.** `DonationService.terminate` does not guard on status, so calling it twice
  stops and reclaims the same `dockerId` twice; the second reclaim now throws and `safeReclaim`
  swallows it. No current test does this. If you add one, assert the swallow, not a throw.
- **`crash()` / `isRunning` on a dropped handle.** `crash` is a no-op for a handle already gone from
  `children`, and `isRunning` already returns `false` for an unknown id (matching the real class).
  A test that crashes an old handle after a respawn would silently do nothing — check
  `donation-supervisor.test.ts` → `'sweeps at startup and again on a donated child exit'`, which
  crashes `dock_2` after a respawn dropped `dock_1`. It passes today; keep it that way.
- **The other `FakeOrchestrator`s.** `server/__tests__/grants-route.test.ts` and
  `server/__tests__/nodes-route.test.ts` each define their *own* local class of the same name. They
  do not import this file and are out of scope — do not "unify" them.

## Explicitly out of scope

- **Port accounting in the fake.** Modelling the four-port allocate/release would let a test prove the
  port leak documented in `abandonRespawn`'s trailing NOTE, but that NOTE also states the leak is
  unreachable today (`giveUp` only runs from the supervisor's serialized pass, so it cannot overlap a
  respawn). Not worth the fake's added surface until a second `respawn` caller appears.
- **Tests that drive `HostProcessOrchestrator` itself.** The plan ticket raised this as an
  alternative. It is a genuinely separate change — it needs a stub child entrypoint, real ports, and
  real process teardown — so it is filed as its own backlog item
  (`debt-host-process-orchestrator-untested`) rather than folded in here. The fake is wanted either
  way for the fast unit tests.
- `tickets/backlog/debt-failed-provision-strands-workdir.md` also names
  `host-process-orchestrator.ts`, but at a different site (workdir cleanup for a spawn that never
  produced a handle). No overlap.

## TODO

- Add the success-only stale-handle drop to `FakeOrchestrator.createContainer`, placed after
  `onCreate` and after the `createDelayMs` sleep.
- Make `stopContainer` / `removeContainer` throw `Container not found: <dockerId>` for an unknown
  handle, with `onStop` still firing first and the `stopped` / `removed` pushes moved after the check.
- Add the `onSpawned` hook and document it against `onCreate`.
- Update the fake's file header and class docstring: the mirrored semantics, what `stopped` /
  `removed` now mean, and that a sibling `*.test.ts` now collects.
- Add the premise test to `donation-service.test.ts` under `describe('DonationService.respawn')`.
- Add `fake-orchestrator.test.ts` with the four contract cases.
- Add the guard comment in `donation-supervisor.test.ts` → `'gives up after the attempt cap: …'`.
- Run `yarn vitest run src/donation/__tests__` from `packages/cadre-host` — expect 84 + the new cases,
  all green. (The repo's stale-build guard may first demand
  `yarn workspace @quereus/quereus build` from `C:\projects\quereus`.)
- Run `yarn lint` and the package's type check.
