----
description: Add cadre-core lifecycle primitives for mobile background: force-hibernate, hibernate-all, on-demand service-wake, and readiness state
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts
effort: high
----

`@serfab/cadre-core` already has the *transport and timer-driven* hibernation/wake machinery (`HibernationManager`, `handleStrand{Idle,Hibernate,Wake,CheckIn}`, `wakeStrand`, `recordStrandActivity`, push-wake via `StrandWakeService`/`pushWake`). What it does **not** expose is the imperative control a mobile `BackgroundRunner` needs to drive lifecycle from OS app-state and push events rather than from internal timers.

This ticket adds those primitives to cadre-core (platform-agnostic; the RN-specific runner lands in a downstream ticket). Three gaps, identified against the current API:

1. **No public force-hibernate.** `handleStrandHibernate` is private and only fires on the hibernate timer; `StrandInstanceManager.quiesceStrand` is not surfaced on `CadreNode`. On background entry the runner must hibernate *now*, not wait out `idleTimeout + hibernateTimeout`.
2. **No "service a wake and return" entry point.** `handleStrandCheckIn` (wake → bounded window → re-hibernate-or-stay) is exactly the mobile push-wake cycle, but it is private and bound to the check-in timer. A push handler needs to invoke that cycle on demand for a specific strand.
3. **No synchronous readiness state.** Readiness is only observable via the `control:connected`/`control:disconnected` events. A runner that boots in a headless background task needs to *query* current state, not only subscribe.

### Interfaces

Add to `CadreNode` (public):

```ts
/** Force a single strand to hibernate immediately, bypassing idle/hibernate timers.
 *  No-op if the strand is realtime (Infinity timeout), already hibernating, or unknown.
 *  Routes through the same path as the hibernate timer: quiesceStrand + status='hibernating'
 *  + 'strand:hibernating' event, and untracks/retracks timers so they don't fight it. */
async hibernateStrand(strandId: string): Promise<void>

/** Force-hibernate every tracked strand whose latencyHint is not 'realtime'.
 *  Realtime strands are left running (caller keeps the control connection + realtime strands
 *  alive as long as the OS permits). Returns the strandIds actually hibernated. */
async hibernateAll(): Promise<string[]>

/** On-demand equivalent of a check-in cycle, for a push-delivered wake on mobile:
 *  resume the strand, hold it live for `windowMs` so its strand network reaches the cohort
 *  and the app can pull pending activity, then re-hibernate if no activity was recorded
 *  (else leave it active). Idempotent/coalesced with concurrent wakes. */
async serviceWake(strandId: string, opts?: { windowMs?: number }): Promise<ServiceWakeResult>

/** Synchronous lifecycle snapshot for headless callers. */
get running(): boolean
get controlConnected(): boolean

interface ServiceWakeResult {
  strandId: string;
  serviced: boolean;     // false if node not running / strand unknown / not a member-participated strand
  hadActivity: boolean;  // true if activity landed during the window (strand left active)
}
```

Refactor, don't duplicate: factor the **window-then-decide** body out of `handleStrandCheckIn` (cadre-node.ts:844-903) into a shared private (e.g. `runWakeWindow(instance, windowMs)`) that both `handleStrandCheckIn` and `serviceWake` call. `serviceWake` is the thin public wrapper: `wakeStrand` → `runWakeWindow` → decide. `hibernateStrand` factors the body of `handleStrandHibernate` (cadre-node.ts:763-783) so both the timer path and the imperative path share one implementation. Coalesce `serviceWake` against in-flight wakes the same way `HibernationManager.beginWake` already coalesces (don't rebuild the runtime twice).

`hibernateAll` reads `latencyHint` per `StrandInstance` (types.ts:282-307) and skips `'realtime'` (consistent with `HibernationManager.trackStrand` skipping Infinity-timeout strands, hibernation-manager.ts:129).

Export `ServiceWakeResult` from `index.ts`.

### Edge cases & interactions

- **Realtime strands**: `hibernateAll` must skip them; `hibernateStrand` on a realtime strand is a no-op (do not quiesce a strand the user is actively chatting on). Verify against `HIBERNATION_TIMEOUTS` realtime = Infinity (types.ts:69-98).
- **Timer vs. imperative race**: forcing hibernation must cancel the pending idle/hibernate timers for that strand (untrack/retrack via `HibernationManager`), or a stale timer will fire `handleStrandHibernate` again on an already-quiesced strand. `quiesceStrand` is idempotent (strand-instance-manager.ts:337-340) so a double-hibernate is safe, but timers must not resurrect a strand the runner intends to keep down.
- **serviceWake on an already-active strand**: should be a no-op success (`hadActivity` reflects current liveness), not a second runtime build — rely on `resumeStrand` returning unchanged when live (strand-instance-manager.ts:367-370) and on wake coalescing.
- **serviceWake on a hibernating strand whose cohort grew bootstrap→networked**: resume must re-resolve cohort seed + mode (already done in `handleStrandWake`, cadre-node.ts:812-817); ensure the shared window path preserves that re-resolution.
- **serviceWake while node not started / control node absent**: return `{ serviced: false }` rather than throwing (mirrors `pushWake`'s running/control guards, cadre-node.ts:1227-1229).
- **Concurrent serviceWake + push-wake (`StrandWakeService`) for the same strand**: both ultimately call `wakeStrand`; coalescing must mean one runtime build and one window, not two competing re-hibernate decisions.
- **Error during resume in the window** (network unreachable in a Doze grant): catch, re-hibernate, surface `serviced: true, hadActivity: false` — match `handleStrandCheckIn`'s re-hibernate-on-error (cadre-node.ts:897-901). Do not throw out of a background task.
- **hibernateAll partial failure**: one strand failing to quiesce must not abort the others; collect and continue, return the ones that succeeded.
- **stop() during an in-flight serviceWake window**: `stop()`/`HibernationManager.stop()` must clear the window timer so it doesn't fire after teardown.

### Key tests (expected outputs)

- `hibernateStrand` on an active interactive strand → status becomes `hibernating`, `strand:hibernating` emitted, `libp2pNode`/`database` released (strand-instance-manager.ts:311-320), instance record retained.
- `hibernateStrand` on a realtime strand → no status change, no event.
- `hibernateAll` with mixed strands (realtime + interactive + background) → returns only the non-realtime ids; realtime strand still `active`.
- `serviceWake` on a hibernating strand with no activity → resumes, waits `windowMs`, re-hibernates; result `{ serviced:true, hadActivity:false }`; ends `hibernating`.
- `serviceWake` on a hibernating strand where activity is recorded during the window → ends `active`; result `hadActivity:true`.
- `serviceWake` when `running===false` → `{ serviced:false }`, no throw.
- Forced hibernation cancels pending timers (advance fake timers past `hibernateTimeout`; assert no second hibernate/no resurrection).

## TODO

- [ ] Factor `handleStrandHibernate` body into a shared private; add public `CadreNode.hibernateStrand(strandId)` that cancels/repaths the strand's hibernation timers
- [ ] Add `CadreNode.hibernateAll()` that skips realtime strands and tolerates per-strand failure
- [ ] Factor the window-then-decide body out of `handleStrandCheckIn` into `runWakeWindow(instance, windowMs)`; have both check-in and serviceWake use it
- [ ] Add public `CadreNode.serviceWake(strandId, opts)` with coalescing, not-running/unknown-strand guards, and `ServiceWakeResult`
- [ ] Add `running` / `controlConnected` getters
- [ ] Export `ServiceWakeResult` from `index.ts`
- [ ] Tests in `cadre-node.spec.ts` / `hibernation-manager.spec.ts` (use existing fake-timer patterns from `strand-instance-manager-hibernation.spec.ts`)
- [ ] `yarn workspace @serfab/cadre-core test` and `yarn workspace @serfab/cadre-core typecheck` green
