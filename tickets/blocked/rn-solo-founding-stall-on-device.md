description: On a real Android phone the reference app could not create a chat strand, because an outdated Babel helper (the code that compiles async loops for React Native) left the database locked. The helper is now upgraded; someone with the phone needs to confirm strand creation works, then close this ticket.
files:
  - packages/reference-app-rn/package.json (`@babel/runtime` floor `^7.29.2`)
  - yarn.lock (`@babel/core`, `@babel/helpers`, `@babel/runtime` all 7.29.7)
  - ../quereus/tickets/review/eval-early-exit-leaks-exec-mutex-under-babel.md (Quereus's diagnosis and its fail-loud probe)
  - packages/cadre-core/src/strand-database.ts:142 (`bootstrapFounder`, whose insert waited forever)
  - packages/cadre-core/src/strand-membership-writer.ts:256-283 (`strandTableCount`, `strandHasManagerRevocation` — early-exit reads that triggered it)
  - packages/reference-app-rn/app/settings.tsx (Create Chat Strand handler)
  - docs/testing.md (§ Lint coverage — Babel helper floor)
repro: verified
----

# Founding a strand on a solo phone hangs — fix landed, needs a device run

## Why this is blocked

Category (b), dependency outside the repo: confirming the fix needs a physical Android device, and none is attached to the agent machine (`adb devices` empty on 2026-09-15). **Unblock when** someone can drive the phone. If the run passes, move this ticket to `complete/`; no further code change is expected.

## Root cause

- **The stuck step.** `StrandDatabase.bootstrapFounder` runs `db.exec('insert into Strand.Header …')`, which waited forever for Quereus's execution lock. The read just before it, `strandTableCount`, leaves its `for await (… of db.eval(…))` loop after the first row; that early exit never released the lock.
- **The defect.** Hermes has no native async generators, so Metro's Babel compiles them using the `wrapAsyncGenerator` helper. In `@babel/runtime` and `@babel/helpers` up to 7.28.6, when the consumer stops iterating, the helper answers the first `await` inside the generator's `finally` with a second `return()`, dropping the rest of the cleanup. Quereus's `_evalGenerator` ends `finally { await stmt.finalize(); releaseMutex(); }`, so `releaseMutex()` never ran. Fixed upstream in 7.29.2 (2026-03-16). Node runs generators natively, which is why every headless run finished.
- **Why the lockfile was old.** Every Expo/RN package declares `@babel/runtime` `^7.20.0`; the lockfile had simply never been refreshed past 7.28.6.

## Fix (2026-09-15)

- `reference-app-rn` declares `@babel/runtime` `^7.29.2`; `yarn up -R @babel/core @babel/helpers @babel/runtime` moved all three to 7.29.7 (`yarn why` confirms no older copy remains).
- Babel-level check, compiling an eval-shaped generator (`await` then lock release in `finally`, consumer `break`s after the first row) with the app's `babel-preset-expo` and Metro caller settings for Android: before the bump `locked: true`, cleanup tail skipped; after the bump `locked: false`, cleanup tail ran. The compiled output imports `@babel/runtime/helpers/wrapAsyncGenerator`, so `@babel/runtime` is the package that matters at run time.
- Quereus (`ac4b72bc8`, in its `review/`) adds a probe that throws `QuereusError` `UNSUPPORTED` naming the upgrade instead of hanging, and dropped its earlier plan to rewrite ~20 `finally` blocks and add a lint rule. Sereus does not need that release for this fix.
- **Not run:** `yarn workspace @serfab/reference-app-rn test` stopped in its stale-build guard (`@optimystic/db-core` dist older than src, another session editing optimystic). The bump touches only Babel packages.

## Device run

- Restart Metro with a clean cache: `yarn workspace @serfab/reference-app-rn start --clear`. The debug dev client loads JS from Metro, so the Babel change needs no native rebuild. Optionally `yarn workspace @quereus/quereus build` in `../quereus` first so the bundle includes Quereus's probe. Record `git -C ../quereus log -1 --oneline` and `git -C ../optimystic log -1 --oneline`.
- On the phone: Connect with an empty party id, then Create Chat Strand. Expect a `[settings] create strand <id8> pressed` line, then `succeeded in <n> ms` in logcat. Development builds also print `sereus:cadre:timing` start and end lines for every founding step. The runtime-patched run took 2.7 s. Any step with a start line but no end line is a new stall; name it.
- Exercise the other early-exit reads: create a second strand, send a message in the first, then force-stop, relaunch and Connect again and check that any strand the app brings back still accepts writes.
- If Quereus's `UNSUPPORTED` probe error appears, Metro is still serving an old `@babel/runtime`: check `yarn why @babel/runtime` and the Metro cache.
- If a hang remains, read lock depth and pending calls through the debugger (see below) before guessing.

## Doing the device run — lessons from 2026-09-15

- **Make sure nobody else is driving the phone.** Check `adb logcat -d | grep "Force stopping org.gotchoices"` and the list of local Claude sessions before tapping anything. On 2026-09-15 two sessions drove the device at once.
- **Metro's inspector proxy admits one debugger client per device.** A second WebSocket closes the first (close code 1005). With a single client on a clean launch, page 1 (the app runtime) answered `Runtime.evaluate` in 3–35 ms.
- **`__r.getModules()` does not exist in this Metro/Expo dev client, and `__r(<id>)` crashes the app** with a fatal "Requiring unknown module". To reach the node, walk React's fiber tree from `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(rendererId)` to the context provider whose `memoizedProps.value` has `node` and `createStrand`.
- Hermes's `eval` rejects `async` syntax, and RN's `Promise` polyfill is invisible to CDP `awaitPromise`. Park async results on a global and poll it.
- Find buttons by text via `adb shell uiautomator dump` rather than fixed coordinates, and let a scroll settle before tapping.
- Take screenshots from bash (`adb exec-out screencap -p > file`); PowerShell `>` corrupts the PNG.

## Device and build used for the original observation

Galaxy Note 9 (SM-N960U), Android 10, debug build of `reference-app-rn` (Expo SDK 53, RN 0.79.6, Hermes), JS from Metro over `adb reverse`. On 2026-09-14 a tap on Create Chat Strand produced no dialog, `Strands 0`, and no JS log line for about 2 minutes. Solo Connect to node-up took about 6 s.
