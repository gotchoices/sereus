----
description: cadre-core mobile background lifecycle primitives — force-hibernate, hibernate-all, on-demand service-wake, readiness getters
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What shipped

Platform-agnostic imperative lifecycle primitives a mobile `BackgroundRunner` drives from OS app-state + push events (rather than the internal idle/hibernate/check-in timers):

- `CadreNode.hibernateStrand(strandId)` / `hibernateAll()` — force-hibernate now, bypassing the timers, via `HibernationManager.forceHibernate` (cancels idle/hibernate **and** check-in timers, runs `onHibernate`, does **not** re-arm check-ins). Realtime strands skipped; `hibernateAll` is collect-and-continue and returns the hibernated strandIds.
- `CadreNode.serviceWake(strandId, opts?)` — on-demand check-in cycle (resume → bounded `windowMs` window → re-hibernate-if-idle), per-strand coalesced, sharing one runtime build with a racing push-wake via `HibernationManager` wake coalescing. Returns a branchable `ServiceWakeResult` and never throws.
- `get running` / `get controlConnected` — synchronous readiness snapshot for headless callers.
- `HibernationManager.hibernates(instance)` — single source of truth for "this hint ever hibernates"; `HibernationManager.forceHibernate(instance)`.
- Refactors: private `running` field → `_running`; factored `resumeStrandRuntime`, `runWakeWindow`, `holdWakeWindow`; window timers tracked in `windowWaiters` and cleared on teardown.

The RN runner that consumes these is the downstream `tickets/backlog/3-mobile-background-service.md`.

## Review findings

**Process:** read the implement diff (`ea3726f`) first with fresh eyes, then the handoff. Verified the test fakes faithfully mirror the real `StrandInstanceManager` API (`getInstances` returns a copy; `quiesceStrand`/`resumeStrand` idempotency and mutation shape) and the real `onHibernate` ordering (quiesce → status → emit, so a quiesce throw leaves status unchanged — which the partial-failure test correctly asserts). Re-ran the full suite (372 passed, 28 files), typecheck (exit 0), and eslint on all touched files (exit 0).

**Correctness — checked, no defects found:**
- Timer-vs-imperative race: `forceHibernate` calls `clearTimers` **synchronously before any await**, so no idle/hibernate/check-in timer can fire on the strand mid-hibernate. The added fake-timer test advances 2h and asserts no second hibernate / no check-in resurrection. Good.
- Coalescing: per-strand `serviceWakePromises` guard plus `HibernationManager.beginWake` coalescing. Single-threaded ordering makes the public `serviceWake` register its promise before a sibling call observes it; the concurrent test confirms one resume + a shared result object.
- Error paths: resume-throws and not-running/unknown-strand return branchable `ServiceWakeResult`s without throwing out of a background task; the in-window quiesce on the error path is itself `.catch`-guarded. Verified against the real `resumeStrand` (sets `status='error'`, rethrows).
- Readiness getters flip correctly across real start/stop (`controlConnected = _running && controlNode !== null`).

**Minor — fixed inline this pass:**
- **Missing coverage for teardown-during-window.** The spec explicitly required `stop()` to clear an in-flight wake window, and the new `windowWaiters`/`clearWindowWaiters` + `cleanup()` call exist solely for it — yet **no test exercised it** (deleting the `clearWindowWaiters()` call from `cleanup` left all tests green). Added `'teardown clears an in-flight wake window so the awaiting serviceWake unblocks (no stale timer)'` to `cadre-node.spec.ts`: starts a `serviceWake` with a 60s window, polls until the waiter registers, invokes `clearWindowWaiters` (what `cleanup` calls), and asserts the awaiting wake unblocks promptly, re-hibernates, and the waiter set drains. (372 passing, was 371.)
- **Docs were stale.** `architecture.md` ("Wake Mechanisms") and `STATUS.md` enumerated local/check-in/push wake but not the new imperative primitives. Added a 4th "Imperative lifecycle" wake-mechanism bullet to `architecture.md` and a matching `STATUS.md` entry, both pointing at the downstream RN runner ticket.

**Observations for the downstream runner (`backlog/3-mobile-background-service`) — design contracts, not defects; no ticket filed since the consuming ticket already exists and owns these decisions:**
- **`serviceWake` on an `idle` (live-but-not-`active`) strand** is treated as already-live → no-op success `hadActivity:true`. It runs **no window and does not reset the idle timer**, so a strand a push found `idle` could hibernate moments later having never pulled. Fine if the runner only ever `serviceWake`s strands it believes hibernating; flag if pushes can target idle strands. (Handoff also flagged this.)
- **`hibernateAll` returns "now hibernating", not "transitioned this call"** — an already-hibernating strand is included even though `hibernateStrand` no-ops it. Confirm that's the contract the runner wants.
- **Cosmetic event asymmetry:** `serviceWake` routes through `wakeStrand → handleStrandWake`, which emits `strand:waking`. So a *no-activity* `serviceWake` emits `strand:waking` then immediately `strand:hibernating` (a brief flicker), whereas the timer check-in path (`handleStrandCheckIn` → `resumeStrandRuntime`, no `onWake`) emits no `waking` on an idle probe. Defensible (the strand genuinely did wake to be serviced) but a UI subscribed to `strand:waking` may flicker; not worth threading a suppress-flag through the coalescing path. Noted for awareness.
- **`running` vs `isRunning`** are now both public and identical (11 external `isRunning` callers retained). Harmless duplication; consolidate later if desired.

**Categories with nothing to report:**
- **Resource cleanup:** in-flight `serviceWakePromises` entries always clear in their `finally`; `windowWaiters` are cleared+resolved by `cleanup()`. No leak found.
- **New tickets:** none — no major findings.

## Validation

- `yarn workspace @serfab/cadre-core test` → 372 passed (28 files)
- `yarn workspace @serfab/cadre-core typecheck` → exit 0
- `eslint` on all touched src + test files → exit 0
