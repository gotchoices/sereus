---
description: The stand-in orchestrator used by the donated-node tests now behaves like the real one when a node is re-started, and new tests prove cleanup rules that nothing previously checked.
files: packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/donation/__tests__/fake-orchestrator.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts
difficulty: medium
---

# Complete: `FakeOrchestrator` mirrors `HostProcessOrchestrator`'s handle lifecycle

Test-only change throughout. No production source was touched by either the implement
or the review pass.

## What shipped

`FakeOrchestrator` (`packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts`) is the
no-child-processes stand-in the donation unit tests run against. It was more permissive than the
real `HostProcessOrchestrator` in two ways; both are closed.

**Stale-handle drop.** A *successful* `createContainer` deletes every prior entry whose
`containerId` matches the request before registering the new child — mirroring the real
`dropStaleHandle` (`host-process-orchestrator.ts:618`). A create that **fails** leaves those
entries untouched, mirroring `restoreDroppedHandles` (`:654`). The drop sits after `onCreate` and
after the `createDelayMs` sleep, because in the real class every `await` happens before the drop
(the last one is `resolvePush` at `:255`) and drop → launch → return is fully synchronous.

**Unknown handles throw.** `stopContainer` / `removeContainer` go through a private `requireChild`,
which throws `` `Container not found: ${dockerId}` `` — same message and shape as the real
`requireHandle` (`:828`). `onStop` still fires *before* the check, so a test can observe an
attempted stop that is then rejected. `stopped` / `removed` therefore mean **"handles this
orchestrator actually acted on"**, not "calls attempted" — spelled out in the class docstring,
since the array names invite the other reading.

**New `onSpawned` hook.** Fires after the drop and after the new child is registered, immediately
before `createContainer` resolves — the only way a test can drive concurrent work into the
post-drop window. `onCreate` models the real class's pre-drop `await` window; `onSpawned` models
the microtask gap between the real `createContainer` returning and its caller's `await` resuming.

## Test coverage

`donation-service.test.ts` → `'reclaims the new child because the terminate could not clean up the
old one'` is the premise test the ticket existed for. `DonationService.abandonRespawn`
(`donation-service.ts:597`) *reclaims* rather than merely stops the child an abandoned respawn
started, and its stated reason is that a concurrent `terminate` aimed its own stop-and-reclaim at a
handle the in-flight spawn had already dropped — so the terminate cleaned up nothing, leaving the
new child as the only thing holding that spawn's ports and workdir. The two pre-existing race
tests drive their concurrent `terminate` from `onCreate`, i.e. *before* the drop, and assert with
`toContain` — right end state, wrong reason, and blind either way. The new test drives from
`onSpawned` and asserts `expect(orch.stopped).toEqual(['dock_2'])`; `dock_1`'s absence is the claim.

`fake-orchestrator.test.ts` (new file, 8 cases) is a contract suite for the fake itself, so a
future agent cannot make a failing donation test go green by relaxing the fake. Each case names
the real behaviour it mirrors.

`donation-supervisor.test.ts` → `'gives up after the attempt cap: …'` carries a comment recording
that its `expect(h.orch.stopped).toContain(view.dockerId)` line is the standing guard on the drop
being success-only, citing the observed failure (`expected [] to include 'dock_1'`).

## Review findings

Read the implement diff (`415f937`) before the handoff summary, and re-derived every fidelity claim
against `host-process-orchestrator.ts` rather than taking the summary's line references on trust.
All three claims hold: the drop is genuinely the last thing before the synchronous `launchChild`
(`:263`), the failure path releases ports then restores handles (`:287`), and `requireHandle`'s
message matches character-for-character (`:828`).

**Minor — fixed in this pass:**

- *The one invariant with no automated guard, flagged by the implementer.* The drop's placement
  after both `onCreate` and the `createDelayMs` sleep was verified only by reading; getting it wrong
  is silently wrong rather than red, because the two `onCreate`-driven race tests assert with
  `toContain`. Added `'keeps the prior handle live across the whole pre-drop await window'`, which
  starts a concurrent stop from `onCreate` on a **microtask** — strictly after `onCreate` returns
  and strictly before the `createDelayMs` timer fires, so one deterministic case pins both
  boundaries with no wall-clock dependence. Verified by moving the drop ahead of the sleep: fails
  with `expected 'rejected: Container not found: dock_1' to be 'stopped'`. The outcome is captured
  via a rejection handler attached at creation, so a regression fails the assertion instead of
  surfacing as a process-level unhandled rejection.
- *Drop scoping untested.* The drop filters on `containerId`, but every contract case used a single
  container, so a fake that cleared the whole map would have passed all of them. Added
  `'drops only the re-spawned container, leaving another container untouched'`. Verified by
  unconditioning the filter: fails with `Container not found: dock_1`.
- *`requireChild`'s return value discarded by every caller* (implementer flagged it as arguably
  wanting `void`). Resolved the other way: `stopContainer` now uses the returned child directly,
  which also removed a redundant second `Map.get`. That made the private `markStopped` helper
  single-use, so it was inlined into `crash` and deleted — the helper existed only to share a
  two-line body across a divergent emit policy.
- *Double-terminate untested* (implementer flagged it as optional). `DonationService.terminate` does
  not gate on status, so a second call re-aims its stop and reclaim at a handle the first call
  already removed; both now throw into `safeStop` / `safeReclaim`, which log and swallow. Added
  `'swallows the second terminate of the same donation'` asserting the swallow — a duplicate DELETE
  or an overlapping reap is a no-op, not a 500.
- *Stale suite header.* `donation-service.test.ts`'s file docstring said the mid-operation race is
  driven through `FakeOrchestrator.onCreate` and a `fetch` stub; it now also runs through
  `onSpawned`, which is a materially different window. Header updated to name both.

**Major (new ticket):** none. Nothing found needed work outside this diff.

**Tripwires (recorded, not ticketed):**

- The fake's `removeContainer` does not stop a still-live child first, where the real one does — so
  a reclaim without a preceding stop would record no `stopped` entry and emit no state change. Every
  donation caller stops before it reclaims, so nothing observes it today. `NOTE:` at
  `fake-orchestrator.ts` → `removeContainer`.
- `getStats` / `getLogs` accept an unknown `dockerId` where the real class throws (`requireHandle`).
  No donation path calls either, so the gap is unobservable. `NOTE:` at `fake-orchestrator.ts` →
  `getStats`, naming both.

**Docs:** nothing to update, and this was checked rather than assumed. Grepped `docs/` and all of
`packages/cadre-host/src` for `FakeOrchestrator` / `fake-orchestrator`: the only hits are the four
files in this diff plus the two unrelated same-named local classes in `server/__tests__`. No design
doc describes the donation test fakes, so no file went stale.

**Deliberately still not done** (scoped out by the implement ticket, and the review agrees):

- Port accounting in the fake. Would let a test prove the port leak documented in `abandonRespawn`'s
  trailing NOTE, but that NOTE also states the leak is unreachable today (`giveUp` only runs from the
  supervisor's serialized pass, so it cannot overlap a respawn).
- Tests that drive `HostProcessOrchestrator` itself — filed separately as
  `debt-host-process-orchestrator-untested`; it needs a stub child entrypoint, real ports, and real
  process teardown.
- The two unrelated `FakeOrchestrator` classes in `server/__tests__/grants-route.test.ts` and
  `server/__tests__/nodes-route.test.ts`. Untouched, by instruction.

## Validation

- `yarn vitest run src/donation/__tests__` (`packages/cadre-host`): **94 passed** across 5 files.
  Implement-stage baseline was 91; the review pass added 3.
- `yarn vitest run` (whole `cadre-host` package): **61 files, 535 passed, 4 skipped**. The 4 skips
  are pre-existing and untouched. No `.pre-existing-error.md` filed — nothing failed.
- `yarn typecheck` (`packages/cadre-host`): clean.
- `yarn lint` at repo root: clean.
- Two negative controls run and reverted (results quoted above); the final tree is the state that
  produced the green full-package run.

## Environment note (not a code issue)

The implement stage recorded the repo's stale-build guard tripping against `@quereus/quereus` in the
sibling `C:\projects\quereus` workspace, cleared with
`yarn --cwd C:/projects/quereus workspace @quereus/quereus build`. It did not recur during review.
