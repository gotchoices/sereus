description: Someone with the Android test phone needs to confirm that creating a chat strand on a phone with no other devices now finishes, after the outdated build-tool helper that made it hang was upgraded. Agents cannot drive the phone.
files:
  - packages/reference-app-rn/app/settings.tsx (Create Chat Strand handler)
  - packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts (headless guard for the cause)
  - docs/reference-app-rn.md (§ Key Dependencies, Babel helper floor; § Tracing a strand founding)
  - packages/cadre-core/src/strand-database.ts (`bootstrapFounder`, whose insert waited forever)
  - packages/cadre-core/src/strand-membership-writer.ts (`strandTableCount`, `strandHasManagerRevocation`: reads that leave their loop early)
repro: verified
----

# Founding a strand on a solo phone: confirm the fix on the device

## Why this is blocked

Dependency outside the repo: confirming the fix needs a physical Android phone, and agents cannot drive one. The code side went through `rn-solo-founding-stall-on-device` (dependency floor, headless guard, docs); this ticket is only the device run and expects no code change. It does not have to wait for that ticket's review: the Babel upgrade has been in the tree since commit `32879da`.

**Unblock when** someone can drive the phone. If the run passes, move this ticket to `complete/` with the timings. If a step stalls, file a `fix/` ticket naming the step.

## What was wrong and what changed

On 2026-09-14 "Create Chat Strand" on a solo phone showed nothing for about 2 minutes. Hermes has no native async generators, so Metro's Babel output runs them on Babel's `wrapAsyncGenerator` helper. Before 7.29.2 that helper dropped the code after the first `await` in a generator's `finally` when a `for await` loop exited early. `strandTableCount` exits after the first row, and Quereus releases its execution lock after an `await` in that `finally`, so the lock stayed held and `StrandDatabase.bootstrapFounder`'s insert waited forever.

`@babel/runtime` and `@babel/helpers` now resolve to 7.29.7, and the app declares `@babel/runtime` `^7.29.2`. The `metro-babel` Vitest project fails if any helper a bundle would use drops that cleanup. A runtime-patched run on the phone founded a strand in 2.7 s.

## Device run

- Make sure nobody else is driving the phone: `adb logcat -d | grep "Force stopping org.gotchoices"` and the list of local Claude sessions. On 2026-09-15 two sessions drove the device at once, and at 13:30 that day a Metro (`expo start --dev-client --localhost --port 8081`) was already running for another session.
- Restart Metro with a clean cache so it recompiles with the new helpers: `yarn workspace @serfab/reference-app-rn start --clear`. The debug dev client loads JS from Metro, so no native rebuild is needed. Optionally run `yarn workspace @quereus/quereus build` in `../quereus` first so the bundle includes Quereus's startup check. Record `git -C ../quereus log -1 --oneline` and `git -C ../optimystic log -1 --oneline`.
- On the phone: Connect with an empty party id, then Create Chat Strand. Expect `[settings] create strand <id8> pressed`, then `succeeded in <n> ms` (`adb logcat -s ReactNativeJS`). Development builds also print `sereus:cadre:timing` start and end lines for every founding step. A step with a start line but no end line is a new stall; name it.
- Exercise the other early-exit reads: create a second strand, send a message in the first, then force-stop, relaunch, Connect again, and check that any strand the app brings back still accepts writes.
- If Quereus's `UNSUPPORTED` error about async-generator cleanup appears, Metro is still serving an old helper: run `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel`, check `yarn why @babel/runtime`, and clear Metro's cache.
- If a hang remains, read lock depth and pending calls through the debugger (below) before guessing.

## Driving the phone: lessons from 2026-09-15

- Metro's inspector proxy admits one debugger client per device. A second WebSocket closes the first (close code 1005). With a single client on a clean launch, page 1 (the app runtime) answered `Runtime.evaluate` in 3–35 ms.
- `__r.getModules()` does not exist in this Metro/Expo dev client, and `__r(<id>)` crashes the app with a fatal "Requiring unknown module". To reach the node, walk React's fiber tree from `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(rendererId)` to the context provider whose `memoizedProps.value` has `node` and `createStrand`.
- Hermes's `eval` rejects `async` syntax, and RN's `Promise` polyfill is invisible to CDP `awaitPromise`. Park async results on a global and poll it.
- Find buttons by text via `adb shell uiautomator dump` rather than fixed coordinates, and let a scroll settle before tapping.
- Take screenshots from bash (`adb exec-out screencap -p > file`); PowerShell `>` corrupts the PNG.

## Device and build used for the original observation

Galaxy Note 9 (SM-N960U), Android 10, debug build of `reference-app-rn` (Expo SDK 53, RN 0.79.6, Hermes), JS from Metro over `adb reverse`. On 2026-09-14 a tap on Create Chat Strand produced no dialog, `Strands 0`, and no JS log line for about 2 minutes. Solo Connect to node-up took about 6 s.
