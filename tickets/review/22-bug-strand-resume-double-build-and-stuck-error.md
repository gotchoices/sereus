description: Waking a sleeping (hibernating) strand while the periodic check-in was already bringing it up could build it twice and leak a network node, and a failed wake left the strand stuck offline with nothing to retry. Resumes now share one rebuild, and a failed wake puts the strand back to sleep with its check-in schedule restored.
architecture: docs/architecture.md#strand-hibernation
files: packages/cadre-core/src/strand-instance-manager.ts (resumeStrand/runResume, resumesInFlight, buildStrandRuntime end, publishDatabase), packages/cadre-core/src/cadre-node.ts (handleStrandWake, rehibernateAfterFailedResume, handleStrandCheckIn, runWakeWindow, wakeStrand, runServiceWake), packages/cadre-core/src/hibernation-manager.ts (PendingCheckIn, checkInsCancelledByWake, clearTimersForWake, restoreCheckInChain, rearmIdleAfterCheckIn, scheduleCheckIn, runCheckIn), packages/cadre-core/src/types.ts (StrandInstance.lastActivity doc), packages/cadre-core/src/strand-wake-protocol.ts (doc comment), docs/architecture.md (Wake Mechanisms items 1, 3, 4), packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts
repro: verified
----

# Strand resume: one rebuild at a time; a failed wake is retryable

## What changed

**Arm 1 — overlapping resumes (reproduced, fixed).**

- `StrandInstanceManager.resumeStrand` keeps `resumesInFlight`, a per-strand map of the whole resume operation (the private `runResume`, including its `'error'` bookkeeping). A second call joins the in-flight promise instead of building. The map is checked before the `libp2pNode || database` "already live" test, so a call made mid-build (node attached, database not yet) waits for the finished runtime. The check and the `set` are synchronous. A joiner's `overrides` are ignored (documented).
- Backstop: `runResume` waits on a `startStrand` build in flight (`settleRuntimeBuilds`) before reading the instance; a failed launch has already dropped the instance, so the resume then throws "not tracked".
- `CadreNode.handleStrandWake` takes the "already live" branch only when `status !== 'starting'`; a mid-build strand falls through and `resumeStrand` joins the build.
- `CadreNode.runServiceWake` treats `'starting'` as nothing to service, the same as already live. This was not in the ticket. Without it, a `serviceWake` racing a launch would now join the launch build and then quiesce the new strand at the end of its window. Before this change it double-built instead.

**Arm 1, check-in window: implemented differently from the ticket's plan.** The ticket said to capture the activity mark before the resume in `handleStrandCheckIn` and `serviceWake`. On its own that makes every window see "activity", because the resume itself wrote `lastActivity` in three places: the end of `buildStrandRuntime`, `publishDatabase`, and `handleStrandWake`. The existing test `serviceWake on a hibernating strand with no activity resumes, then re-hibernates` shows it. So the meaning of `lastActivity` changed as well:

- Bringing a runtime up no longer counts as activity. The stamp at the end of `buildStrandRuntime` is gone. `publishDatabase` stamps only when a gated joiner's Header arrives later (`wasGated`). This is documented on `StrandInstance.lastActivity` in `types.ts`.
- The wake stamp moved from `handleStrandWake` to the public `CadreNode.wakeStrand`, which stamps before it delegates. `recordActivity`-driven wakes already stamp in `HibernationManager.recordActivity`.
- `serviceWake` calls `hibernationManager.wakeStrand` directly, so its own wake does not stamp. It still coalesces through `beginWake`.
- `handleStrandCheckIn` and `serviceWake` both capture the mark before the resume and pass it to `runWakeWindow(instance, activityMark, windowMs)`.

Net effect: a wake or activity from anyone else that lands during the resume or the window keeps the strand up, whatever order the microtasks run in. The probe's own bring-up does not.

- New consequence, handled: activity recorded while a check-in is still rebuilding (status `'starting'`) now keeps the strand up, but `recordActivity` arms no idle timer for a `'starting'` strand. `HibernationManager.runCheckIn` now restarts the idle countdown on its "woke" branch (`rearmIdleAfterCheckIn`), but only for `active`/`syncing` strands with a finite idle timeout, so a strand stopped mid-check-in gains no timers.

**Arm 2 — a failed wake is retryable (static, fixed).**

- `CadreNode.rehibernateAfterFailedResume(instance, context)` replaces the three copies of "best-effort quiesce, log, set `'hibernating'`" in `handleStrandCheckIn`, `runServiceWake` and the new catch in `handleStrandWake`. The `handleStrandWake` catch rethrows, so callers still see the error.
- `HibernationManager`: `checkInTimers` now holds `{ timer, instance }` (`PendingCheckIn`), and a fired timer removes its own entry, so the map holds only armed check-ins. `wakeStrand` and `recordActivity` go through `clearTimersForWake`, which records an armed chain in `checkInsCancelledByWake`. If the wake rejects, `beginWake` calls `restoreCheckInChain`, which re-arms at the base delay only when the manager is running and the instance reads `'hibernating'`. The record is cleared when the wake settles, and by `untrackStrand`, `forceHibernate` and `stop`. A force-hibernated strand has no armed chain, so it gains none.

**Docs.** `docs/architecture.md` Wake Mechanisms item 1 now covers the joined resume, the activity semantics and the failed-wake restore; item 3's push-wake/check-in sentence is restated; item 4 notes that `serviceWake`'s own wake does not count as activity. The doc comment in `strand-wake-protocol.ts` is updated to match.

## Tests

- `strand-instance-manager-hibernation.spec.ts` → `overlapping resumes share one runtime build (a wake landing during a check-in)`, extended. Two resumes start before the node exists, and a third starts mid-build: `initialize` is held with the node already attached. The test checks there is one `createLibp2pNode`, the mid-build call does not settle before the database exists, all three calls return the same instance, and one `stop` happens on quiesce. This is the arm 1 reproduction; it failed before the fix.
- `hibernation-manager.spec.ts` → `a failed wake restores the check-in chain it cancelled, and starts none for a strand without one`. This is the arm 2 behaviour: re-armed at base delay (`nextCheckIn` 2150) and check-ins fire; a force-hibernated strand gets no `nextCheckIn` and no check-ins.
- `hibernation-manager.spec.ts` → `a check-in that leaves the strand live restarts its idle countdown even when nothing re-armed it`. It guards the idle-timer hazard described above.
- `cadre-node.spec.ts`: two existing tests were adjusted, and no new CadreNode test was added. The lifecycle fake's `resumeStrand` no longer stamps `lastActivity`, to match the real manager. The `serviceWake … resume throws` test now asserts the set of quiesced strands, because the failed wake and `serviceWake`'s catch each quiesce and the second call does nothing.

Results: `yarn workspace @serfab/cadre-core test` passed 147 files and 2365 tests (1 skipped, already skipped before this change). `yarn lint`, `yarn typecheck` and the cadre-core build are clean.

## Gaps and things for the reviewer to weigh

- **No CadreNode-level test of the check-in/wake race.** The case where a wake joins a check-in's rebuild and the window keeps the strand up is covered only by reasoning plus the manager-level tests. A test would need a fake `resumeStrand` that shares one deferred between the check-in and a `wakeStrand` call. It may be worth adding if the reviewer judges the mark-before-resume semantics fragile.
- **`lastActivity` as displayed changed.** `cadre-cli strands` now shows the launch start time rather than the build end, and after a no-activity check-in it shows the last real activity rather than the check-in time. I think this is more accurate. Nothing else reads it except `runWakeWindow`.
- **Existing gap, not fixed:** `HibernationManager.wakeStrand` (explicit or push-wake) does not re-arm the idle cycle after a successful wake; only `recordActivity`-driven wakes do. A strand woken that way stays `active` until something records activity. Arguably a separate `bug-` ticket; the natural fix site is `beginWake`'s success path.
- **Existing gap, not fixed:** a successful `serviceWake` cancels an armed check-in chain (through `clearTimersForWake`), and if its window re-hibernates the strand, nothing re-arms the chain. This is harmless on mobile, where force-hibernated strands have no chain. On a node that hibernates on timers, a `serviceWake` ends the check-in schedule until the next idle-driven hibernation.
- **Existing, not fixed:** clearing timers for a wake does not clear `instance.nextCheckIn`, so `getStrand` can report a check-in time that is no longer scheduled while the wake runs.
- `runWakeWindow`'s activity branch sets `status = liveStrandStatus(instance)` without checking; this was already the case. With `serviceWake` now skipping `'starting'` strands, I found no path that runs two windows on one strand.
