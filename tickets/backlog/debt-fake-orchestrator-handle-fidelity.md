---
description: The stand-in used by the donated-node tests is more forgiving than the real thing, so several tests pass without proving the behaviour they claim to prove.
files: packages/cadre-host/src/donation/__tests__/fake-orchestrator.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts
difficulty: medium
---

# The donation tests' fake orchestrator is too forgiving

The donation unit tests run against `FakeOrchestrator`, a stand-in for
`HostProcessOrchestrator` that never spawns real child processes. It diverges from the real class in
two ways that matter, and both divergences make tests pass that would not pass against the real
thing.

## Divergence 1 — the fake keeps old handles alive across a re-spawn

`HostProcessOrchestrator.createContainer` calls `dropStaleHandle(containerId)` while spawning
(`host-process-orchestrator.ts:230`). That deletes any handle left from a previous spawn of the same
container and releases its four ports, because handles are keyed by a per-spawn `dockerId`. The fake
does not: every spawn just adds another entry, so both the old and the new handle stay resolvable
forever.

## Divergence 2 — the fake never reports an unknown handle

The real `stopContainer` / `removeContainer` both go through `requireHandle`, which throws
`Container not found: <dockerId>` for a handle the orchestrator no longer knows. The fake's
`stopContainer` and `removeContainer` accept any string and quietly record it.

## Why this matters

Together they invert the premise of the `respawn-succeeds-after-loan-terminated` work. That ticket's
central claim is:

> when a `terminate` lands while a respawn is spawning, the terminate's own stop-and-reclaim hits a
> handle the in-flight spawn already dropped, so it cleans up **nothing** — which is why the respawn
> must reclaim the child it just started rather than merely stop it.

Against the fake, the terminate's cleanup *succeeds* (divergence 1 keeps the old handle, divergence
2 would have swallowed it anyway). So the race tests in `donation-service.test.ts` assert the
correct end state — the new child is stopped and reclaimed — while nothing in the suite demonstrates
the premise that made the reclaim necessary. The same applies to the `giveUp` path in
`donation-supervisor.ts`, whose comment says a failed stop there is *expected*; the fake never
produces one.

Beyond this one ticket, the same forgiveness would hide any future bug where the donation code
stops or reclaims a handle that no longer exists.

## What is wanted

Make `FakeOrchestrator` behave like `HostProcessOrchestrator` on both points — drop prior handles
for the same `containerId` on create, and throw `Container not found` from `stopContainer` /
`removeContainer` for an unknown `dockerId` — then fix whatever existing assertions that breaks,
rather than relaxing the fake back.

Not a mechanical change: several current tests assert on `orch.stopped` / `orch.removed` containing
handles that a faithful fake would reject, and the harnesses in both donation test files share the
fake. Expect to re-derive what each of those tests is actually asserting. Some of them are probably
asserting "we called stop on X" when the meaningful claim is "X ended up cleaned up".

An alternative worth weighing during the work: rather than growing the fake, add a small number of
tests that drive `HostProcessOrchestrator` itself (it spawns real `cadre-cli` children, so these are
slower and belong wherever the package keeps its heavier suites). That would prove the real
behaviour instead of a second model of it. The fake is still wanted for the fast unit tests either
way.
