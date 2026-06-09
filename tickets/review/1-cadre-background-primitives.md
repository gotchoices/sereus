----
description: Review cadre-core mobile background lifecycle primitives — force-hibernate, hibernate-all, on-demand service-wake, readiness getters
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts
----

## What landed

Added the imperative lifecycle primitives a mobile `BackgroundRunner` needs to drive cadre-core from OS app-state and push events (rather than the internal idle/hibernate/check-in timers). Platform-agnostic only — the RN runner is a downstream ticket. Build + full cadre-core suite + typecheck + lint all green (`yarn workspace @serfab/cadre-core test` → 371 passed, 28 files; `typecheck` exit 0; eslint exit 0).

### New public API on `CadreNode`

- `hibernateStrand(strandId): Promise<void>` — force one strand to hibernate now, bypassing timers. No-op if realtime / already hibernating / unknown.
- `hibernateAll(): Promise<string[]>` — force-hibernate every non-realtime strand, collect-and-continue on per-strand failure; returns the strandIds now hibernating (realtime excluded).
- `serviceWake(strandId, opts?: { windowMs? }): Promise<ServiceWakeResult>` — on-demand push-wake cycle: resume → hold live for `windowMs` → re-hibernate-if-idle. Coalesced, never throws.
- `get running(): boolean` and `get controlConnected(): boolean` — synchronous readiness snapshot for headless callers.
- `ServiceWakeResult` interface added to `types.ts` (auto-exported via `export * from './types.js'` in index.ts — no separate index edit needed).

### New on `HibernationManager`

- `hibernates(instance): boolean` — single source of truth for "this hint ever hibernates" (`idleTimeout !== Infinity`, honours `customTimeouts`).
- `forceHibernate(instance): Promise<boolean>` — cancels the strand's idle/hibernate **and** check-in timers, runs `onHibernate`, and deliberately does **not** re-arm check-ins (keeps the strand down until the caller drives a wake). Returns false (no-op) for realtime.

### Refactors (no behavior change to the timer paths, verified by existing tests)

- Renamed the private `running` field → `_running` (to free the `running` getter name); `isRunning` retained and unchanged for the 11 callers across the repo.
- Factored `resumeStrandRuntime(strandId)` (re-resolve cohort seed + mode, then `resumeStrand`) — now shared by `handleStrandWake` and `handleStrandCheckIn`.
- Factored the window-then-decide body of `handleStrandCheckIn` into `runWakeWindow(instance, windowMs)` (returns whether activity landed); both check-in and `serviceWake` call it. The bare wait is now `holdWakeWindow` (replaces `runCheckInWindow`).
- `serviceWake = wakeStrand (coalesced) → runWakeWindow → decide`, so a racing push-wake (`StrandWakeService`) shares one runtime build via `HibernationManager.beginWake`.
- Window timers are now tracked in `windowWaiters` and cleared+resolved in `cleanup()` — `stop()` during an in-flight window no longer fires a stale timer or hangs the awaiting check-in/serviceWake. (This also tightens the pre-existing check-in window, which was an untracked bare `setTimeout`.)

## Use cases / behaviors to validate

- `hibernateStrand` on active interactive strand → `hibernating`, `strand:hibernating` emitted, node+db released, instance retained.
- `hibernateStrand` on realtime / already-hibernating / unknown → no-op (no event, no quiesce).
- `hibernateAll` mixed (realtime + interactive + background) → returns `['ix','bg']`, realtime left `active`; one strand's quiesce failure doesn't abort the rest.
- `serviceWake` no-activity → resume + re-hibernate, `{serviced:true, hadActivity:false}`, ends hibernating.
- `serviceWake` activity-in-window → ends `active`, `hadActivity:true`, no re-hibernate.
- `serviceWake` already-live → no-op success `{serviced:true, hadActivity:true}`, no second resume.
- `serviceWake` not-running / unknown-strand → `{serviced:false}`, no throw.
- `serviceWake` resume throws → re-hibernate, `{serviced:true, hadActivity:false}`.
- Concurrent `serviceWake` for same strand → one resume, both callers get the same result object.
- `forceHibernate` cancels pending timers: advance fake timers 2h → no second hibernate, no check-in resurrection.
- `running`/`controlConnected` flip correctly across real start/stop.

## Known gaps / reviewer attention

- **Unit-level only.** All new tests use fake `StrandInstanceManager` / mocked `HibernationManager` callbacks — no real libp2p resume. The actual "resume under Doze, pull-on-read, re-hibernate" behavior against a live strand network is not exercised here (it can't be in unit tests; it belongs to the downstream RN runner / integration-tests).
- **Cross-path coalescing (serviceWake vs push-wake) is indirect.** Both funnel through `wakeStrand → beginWake`, and `beginWake` coalescing is covered in `hibernation-manager.spec.ts`, but there is no single test that races a `serviceWake` against an inbound `StrandWakeService` push for the same strand. Consider whether an explicit test is warranted.
- **`hibernateAll` result semantics.** It returns strands that *end* in `hibernating` (non-realtime). An already-hibernating strand would be included even though `hibernateStrand` no-ops it — i.e. "now hibernating" rather than strictly "transitioned this call". Confirm this is the intended contract for the runner.
- **`serviceWake` on an idle (not active) strand** is treated as already-live → no-op success with `hadActivity:true`; it is not flipped to `active` and gets no window. Confirm that's acceptable vs. wanting an idle strand pulled during the window.
- **`forceHibernate` arms no check-ins by design.** This is the deliberate "keep it down until the caller wakes it" semantic (per the ticket's "timers must not resurrect a strand the runner intends to keep down"). If the runner ever wants the timer-driven check-in backoff to continue after a forced hibernate, that's a follow-up — not currently supported.
- **`running` vs `isRunning`** are now both present and identical. Left intentionally (11 external callers use `isRunning`); reviewer may prefer consolidating later.
