description: Bringing a sleeping (hibernating) strand back up has two gaps: a wake that lands while the periodic check-in is already bringing it up can rebuild it twice and leak a network node, and a wake that fails leaves the strand stuck offline with nothing that retries. Resuming a strand should run one rebuild at a time and leave a failed one retryable.
architecture: docs/architecture.md#strand-hibernation
files: packages/cadre-core/src/strand-instance-manager.ts (resumeStrand ~1348, runtimeBuilds/trackRuntimeBuild ~517/647), packages/cadre-core/src/cadre-node.ts (handleStrandWake ~4778, resumeStrandRuntime ~4811, handleStrandCheckIn ~4852, runWakeWindow ~4906, serviceWake ~6860), packages/cadre-core/src/hibernation-manager.ts (recordActivity ~190, wakeStrand ~235, beginWake ~246, clearTimers), packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, docs/architecture.md (~line 778, Wake Mechanisms item 3)
repro: verified
----

# Strand resume: coalesce concurrent resumes; make a failed wake retryable

A hibernating strand has its libp2p node and database shut down (quiesced). Two paths bring it back up:

- **Wakes** — `CadreNode.wakeStrand`, `HibernationManager.recordActivity`, push-wake (`StrandWakeService`), `serviceWake`, closed-strand formation redemption (`wakeHostStrandForFormation`). All go through `HibernationManager.beginWake`, which shares one in-flight promise per strand, then `CadreNode.handleStrandWake`.
- **Check-ins** — `HibernationManager.runCheckIn` → `CadreNode.handleStrandCheckIn` → `resumeStrandRuntime` → `StrandInstanceManager.resumeStrand`. Not in `beginWake`'s promise map.

## Arm 1 — overlapping resumes build two runtimes (reproduced)

`resumeStrand`'s only guard is `if (instance.libp2pNode || instance.database) return instance`. Both handles are assigned only partway through `buildStrandRuntime`, so a second call made while the first build is in flight also builds. `handleStrandWake` has the same check before choosing between "already live" and "rebuild".

Reproduced: the test `overlapping resumes share one runtime build (a wake landing during a check-in)` has been added to `packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts`. It issues two `resumeStrand` calls without awaiting the first and fails today with `createLibp2pNode` called 2 times, expected 1. Run it with `npx vitest run test/strand-instance-manager-hibernation.spec.ts` from `packages/cadre-core`. It is the regression test for this arm; keep it.

### Fix

**In `StrandInstanceManager.resumeStrand`**: join an in-flight resume instead of starting another. So every current and future caller is covered, do this here and not by routing check-ins through `beginWake`.

- Keep a per-strand in-flight map of **the whole resume operation**, meaning the promise that includes the status bookkeeping (`'error'` on failure) as well as the build. Do not have joiners await the raw `runtimeBuilds` entry. The raw build promise settles one microtask before the owner's catch sets `status = 'error'`, so a joiner awaiting it can see a stale status. One way: split the current body into a private `runResume(...)` that returns the promise, store it in `resumesInFlight`, and delete the entry in a `finally` when it is still the stored one (same pattern as `trackRuntimeBuild`).
- Check the in-flight map **first**, before the `libp2pNode || database` "already live" guard. A call made mid-build, after `libp2pNode` is assigned but before the database is initialized, must wait for the build and not return early.
- A resume that joins another resume ignores its own `overrides`. The first resume's seed wins, and both callers resolved the cohort seed moments apart. Say so in the doc comment.
- Also cover a resume issued while a `startStrand` build is in flight: the instance is tracked with no handles yet, so today that would also double-build. If no resume is in flight but `runtimeBuilds` has an entry, await it with its rejection propagated, then re-read the instance. If the start failed, `startStrand` has already deleted the instance; throw "not tracked". Keep this small. It is a backstop, since nothing wakes a `'starting'` strand except an explicit `wakeStrand`.
- The whole check-then-set must stay synchronous (no `await` between reading the in-flight map and writing it), or the race reopens.

**In `CadreNode.handleStrandWake`**: the "already live" branch must not fire mid-build. Take it only when `instance.status !== 'starting'`. A `'starting'` strand falls through to `resumeStrandRuntime`, whose `resumeStrand` call now joins the in-flight build. Re-deriving the seed there is wasted work but harmless.

**Check-in window must not undo a joined wake.** `handleStrandCheckIn` → `runWakeWindow` captures `instance.lastActivity` *after* the resume and re-hibernates if it has not changed by the end of the window. Suppose a wake lands during the check-in's resume: it joins the build, and then either `handleStrandWake` or `recordActivity` has already stamped `lastActivity`. If that stamp happened before the check-in captured its mark, the check-in quiesces a strand the wake just brought up. Capture the activity mark **before** the resume in both `runWakeWindow` callers. That means `handleStrandCheckIn`, and `serviceWake`, which calls `wakeStrand` then `runWakeWindow`. Pass it into `runWakeWindow` instead of reading it there. Then any wake or activity during the resume counts as activity and the strand stays up. Check that `holdWakeWindow` and the existing hibernation tests do not depend on the mark being taken after the resume.

## Arm 2 — a failed wake leaves the strand in `'error'` with nothing that retries (static)

`resumeStrand` sets `status = 'error'` on failure. `handleStrandCheckIn` and `serviceWake` each catch this, best-effort quiesce, and force `'hibernating'`. `handleStrandWake`, which every `beginWake` path uses, does not. Meanwhile `HibernationManager.wakeStrand` and `recordActivity` both call `clearTimers(strandId)`, which also clears the check-in timer. So after a failed wake the strand is `'error'`, has no runtime and has no check-in armed. `recordActivity` wakes only `'idle'`/`'hibernating'` strands, and the formation redemption wakes only `'hibernating'` ones, so nothing retries until the app relaunches the strand. Confirmed by reading; the unit test below makes it observable.

### Fix

- **`CadreNode`**: pull the three copies of "best-effort quiesce, log a cleanup failure, set `status = 'hibernating'`" (in `handleStrandCheckIn`, `serviceWake` and the new site) into one private helper, e.g. `rehibernateAfterFailedResume(instance, context)`. In `handleStrandWake`, wrap the rebuild branch in try/catch: call the helper, then **rethrow** so the awaiting caller (`wakeStrand`, formation redemption, `serviceWake`) still sees the error. `serviceWake` keeps its own catch; with the helper it becomes one call. Arm 1 makes this safe: a joined check-in and wake both land in the same catch, and quiescing twice is a no-op.
- **`HibernationManager`**: after a failed wake, restore the check-in chain that the wake's `clearTimers` cancelled. Re-arm with `scheduleCheckIn(instance)` at base delay only when both hold: (a) a check-in timer was armed when the wake cleared timers, and (b) after the failure the instance is `'hibernating'`. Condition (a) is needed because strands hibernated with `forceHibernate` (the mobile background path, `CadreNode.hibernateStrand`) deliberately have no check-in chain, and a failed wake must not start one. `beginWake` has only the `strandId`. Thread the instance, or record "check-in was armed" per strand when `wakeStrand`/`recordActivity` clear timers, and consume it in `beginWake`'s rejection path. Pick whichever is less invasive. A check-in that is mid-run (its timer already consumed) reschedules itself from `runCheckIn` once `'hibernating'` is restored, so no extra handling is needed there.
- `'hibernating'` alone also makes the next `recordActivity`/formation redemption retry the wake, which is the existing retry semantics.

## Docs

`docs/architecture.md` ~line 778 (Wake Mechanisms item 3) says "resume coalescing prevents a push-wake racing a concurrent check-in". Once arm 1 lands, restate it accurately: `resumeStrand` joins any in-flight resume for the strand, so a push-wake racing a check-in shares one runtime build. Also add one sentence on arm 2: a failed wake re-hibernates the strand and restores its check-in chain, while the waker still sees the error. Check the Strand Hibernation section for any other wording about wake failure or status `'error'` and keep it consistent.

## Tests (keep minimal)

- Arm 1: the already-added `overlapping resumes share one runtime build` test in `strand-instance-manager-hibernation.spec.ts`. If it is cheap in the same mock harness, extend the same test, not a new one, to assert that the second call made mid-build does not resolve before the database is attached.
- Arm 2: one test at the lowest layer that shows the behaviour. `hibernation-manager.spec.ts` drives `HibernationManager` with fake callbacks, so the natural test is: strand hibernating with a check-in armed, then `wakeStrand` with an `onWake` that sets `status = 'hibernating'` and rejects. Assert the wake rejects, the check-in timer is re-armed (`instance.nextCheckIn` is set, or advance fake timers and see `onCheckIn` called), and that a strand force-hibernated without a chain gets none. The `CadreNode.handleStrandWake` catch is glue around the shared helper and does not need its own test.

## TODO

- Add the whole-operation in-flight map to `StrandInstanceManager.resumeStrand`. Check it before the "already live" guard, join an in-flight `startStrand` build as a backstop, and update the doc comment (overrides of a joined resume are ignored).
- `CadreNode.handleStrandWake`: skip the "already live" branch while `status === 'starting'`.
- Capture the activity mark before the resume in `handleStrandCheckIn` and `serviceWake`, and pass it into `runWakeWindow`.
- Extract `rehibernateAfterFailedResume` in `CadreNode` and use it in `handleStrandCheckIn`, `serviceWake` and a new catch in `handleStrandWake` that rethrows.
- `HibernationManager`: on a failed wake, re-arm the check-in chain at base delay when a check-in was armed before the wake and the instance is `'hibernating'`.
- Add the arm 2 test to `hibernation-manager.spec.ts` and make the arm 1 test pass.
- Update `docs/architecture.md` Wake Mechanisms item 3 (and any related Strand Hibernation wording).
- Run `yarn workspace @serfab/cadre-core test` (foreground), `yarn lint`, and the package typecheck/build.
