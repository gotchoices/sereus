---
description: The stand-in orchestrator used by the donated-node tests now behaves like the real one when a node is re-started, and new tests prove a cleanup rule that nothing previously checked.
files: packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts
difficulty: medium
---

# Review: `FakeOrchestrator` now mirrors `HostProcessOrchestrator`'s handle lifecycle

## What changed

Test-only change. No production source was touched.

`FakeOrchestrator` (`packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts`) is the
no-child-processes stand-in the donation unit tests run against. It was more permissive than the real
`HostProcessOrchestrator` in two ways; both are now closed.

**1. Stale-handle drop.** A *successful* `createContainer` now deletes every prior entry whose
`containerId` matches the request before registering the new child — mirroring the real
`dropStaleHandle` (`host-process-orchestrator.ts:618`). A create that **fails** leaves those entries
untouched, mirroring `restoreDroppedHandles` (`:654`). The drop sits after `onCreate` and after the
`createDelayMs` sleep, because in the real class every `await` happens before the drop and
drop → launch → return is fully synchronous.

**2. Unknown handles throw.** `stopContainer` / `removeContainer` now go through a private
`requireChild`, which throws `` `Container not found: ${dockerId}` `` — same message and same shape as
the real `requireHandle` (`:828`). `onStop` still fires *before* the check, so a test can observe an
attempted stop that is then rejected. The `stopped` / `removed` pushes moved *after* the check, so
those arrays now mean **"handles this orchestrator actually acted on"**, not "calls attempted". That
re-reading is spelled out in the class docstring, since the array names invite the other one.

**3. New `onSpawned` hook.** Fires after the drop and after the new child is registered, immediately
before `createContainer` resolves. It is the only way a test can drive concurrent work into the
post-drop window. Both hooks now document the contrast: `onCreate` models the real class's *pre-drop*
`await` window; `onSpawned` models the microtask gap between the real `createContainer` returning and
its caller's `await` resuming.

**File header** reworded — it claimed the file is "not collected as a suite", which a sibling
`*.test.ts` makes misleading.

## What the new tests prove

### `donation-service.test.ts` → `'reclaims the new child because the terminate could not clean up the old one'`

The premise test the whole ticket exists for. `DonationService.abandonRespawn`
(`donation-service.ts:597`) *reclaims* rather than merely stops the child an abandoned respawn
started, and its stated reason is that a concurrent `terminate` aimed its own stop-and-reclaim at a
handle the in-flight spawn had already dropped — so the terminate cleaned up nothing, leaving the new
child as the only thing holding that spawn's ports and workdir. Nothing in the suite demonstrated
that.

The two pre-existing race tests drive their concurrent `terminate` from `onCreate`, i.e. *before* the
drop, where the terminate's own cleanup still succeeds — right end state, wrong reason — and they
assert with `toContain`, so they cannot distinguish the two worlds either way. Both are unchanged and
still green; they now read as the deliberate contrast case to the new test.

The new test drives the terminate from `onSpawned` and asserts with exact equality:
`expect(orch.stopped).toEqual(['dock_2'])` / `expect(orch.removed).toEqual(['dock_2'])`. **`dock_1`'s
absence is the claim.**

### `fake-orchestrator.test.ts` (new file, 6 cases)

A contract suite for the fake itself, so a future agent cannot make a failing donation test go green
by relaxing the fake. Each case names the real behaviour it mirrors: the success-only drop
(`dropStaleHandle`), the failed-create no-op (`restoreDroppedHandles`), rejection of a never-issued
`dockerId` (`requireHandle`), rejection after a remove, `onStop` firing on a rejected stop, and
`onSpawned` observing the post-drop world.

### Guard comment

`donation-supervisor.test.ts` → `'gives up after the attempt cap: …'` gained a comment at its
`expect(h.orch.stopped).toContain(view.dockerId)` line recording that it is the standing guard on the
drop being success-only, and citing the observed failure (`expected [] to include 'dock_1'`) an
unconditional drop produces.

## Validation performed

- `yarn vitest run src/donation/__tests__` (from `packages/cadre-host`): **91 passed** across 5 files.
  Baseline before this ticket was 84 across 4 — the 7 new cases are 1 premise test + 6 contract tests.
- `yarn vitest run` (whole `cadre-host` package): **61 files, 532 passed, 4 skipped**. The 4 skips are
  pre-existing and untouched.
- `yarn typecheck` (`packages/cadre-host`): clean.
- `yarn lint` at repo root: clean. Also ran `eslint` directly against all four changed files: exit 0.
- **Negative control.** Temporarily short-circuited the drop loop and re-ran the donation suite:
  3 tests fail, including the premise test at `expect(orch.stopped).toEqual(['dock_2'])`, plus two
  contract cases. Reverted immediately; the final tree is byte-identical to the state that produced
  the green full-suite run above.

## Things a reviewer should push on

- **The `onCreate` ordering claim is verified by reading, not by a test.** The drop must land *after*
  `onCreate` and after `createDelayMs`. Getting it wrong is silently wrong rather than red: the two
  existing `onCreate`-driven race tests assert with `toContain`, so they would still pass if `dock_1`
  started getting dropped. I traced both by hand and confirmed `dock_1` still reaches `orch.removed`
  in each (the terminate/reap runs its stop+reclaim during the `createDelayMs` sleep, before the drop
  loop is reached). Worth re-tracing independently — it is the one invariant here with no automated
  guard.
- **`requireChild` returns `FakeChild` but every caller discards it.** Kept for parity with the real
  `requireHandle`. Arguably it should return `void`.
- **Double-terminate is still untested.** `DonationService.terminate` does not guard on status, so
  calling it twice now makes the second reclaim throw into `safeReclaim`, which swallows it. No test
  covers that; the ticket flagged it as optional. If one is added, it should assert the swallow.

## Deliberately not done (scoped out by the implement ticket)

- **Port accounting in the fake.** Would let a test prove the port leak documented in
  `abandonRespawn`'s trailing NOTE, but that NOTE also states the leak is unreachable today
  (`giveUp` only runs from the supervisor's serialized pass, so it cannot overlap a respawn).
- **Tests that drive `HostProcessOrchestrator` itself.** Filed separately as
  `debt-host-process-orchestrator-untested` — it needs a stub child entrypoint, real ports, and real
  process teardown.
- **The other `FakeOrchestrator`s.** `server/__tests__/grants-route.test.ts` and
  `server/__tests__/nodes-route.test.ts` each define their own unrelated local class of the same
  name. Untouched, by instruction.

## Environment note (not a code issue)

The repo's stale-build guard tripped mid-session against `@quereus/quereus` in the sibling
`C:\projects\quereus` workspace — its `dist` went stale between two runs of the same unchanged tree.
Cleared with `yarn --cwd C:/projects/quereus workspace @quereus/quereus build` (plain `cd` into that
directory is blocked from this working dir). Unrelated to this ticket's diff, and no
`.pre-existing-error.md` was filed since it is a build-freshness condition, not a failing test.
