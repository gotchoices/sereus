description: On a real Android phone the reference app cannot create a chat strand, because a bug in an outdated build tool the app bundles makes the database's lock stay held after a query stops early, so the next write waits forever. The tool's fix has been published since March; the app just needs its dependency updated, plus a check that keeps the old version from coming back.
files:
  - packages/reference-app-rn/package.json (`@babel/runtime: ^7.28.6` declared directly; `@babel/core: ^7.29.0`)
  - yarn.lock (`@babel/helpers@npm:^7.28.6` → 7.28.6; `@babel/runtime@npm:^7.20.0, ^7.25.0, ^7.28.6` → 7.28.6)
  - packages/reference-app-rn/node_modules/@babel/helpers, packages/reference-app-rn/node_modules/@babel/runtime (nested 7.28.6 copies; `nodeLinker: node-modules`)
  - packages/reference-app-rn/babel.config.js, packages/reference-app-rn/metro.config.js
  - packages/cadre-core/src/strand-membership-writer.ts:256-283 (`strandTableCount`, `strandHasManagerRevocation` — early-exit reads that trigger the hang)
  - packages/cadre-core/src/strand-database.ts:142 (`bootstrapFounder`, whose insert waits forever)
  - docs/reference-app-rn.md, docs/testing.md (§ Lint coverage tripwire recorded by the fix stage)
repro: verified
----

# Founding a strand on a solo phone hangs: bump the Babel helpers

## Status change (2026-09-15, garden)

Moved from `blocked/` to `implement/`. The block assumed an engine fix in `../quereus`. The Quereus session traced the cause to Babel instead and dropped the engine rewrite (`../quereus` commit `ac4b72bc8`, ticket `eval-early-exit-leaks-exec-mutex-under-babel`, now in its `review/`). **No Quereus release or `@quereus/quereus` range bump is needed for this fix**; do not plan around the Quereus tickets named in the old version of this ticket.

## Root cause

- **The stuck step (unchanged, measured on the device).** `StrandDatabase.bootstrapFounder` → `db.exec('insert into Strand.Header …')` waits forever on Quereus's execution lock. The read just before it, `strandTableCount`, leaves its `for await (… of db.eval(…))` loop after the first row. Quereus's `_evalGenerator` ends `finally { if (stmt) { await stmt.finalize(); } releaseMutex(); }`, and under the phone's compiled generators `releaseMutex()` never ran. Device evidence: lock depth 1, pending chain `initialize` → `bootstrapFounder` → `exec` → `_withMutex` → `_acquireExecMutex`. A live patch that drained the iterator on early exit made founding finish in 2.7 s.
- **Why: a Babel helper bug, fixed upstream.** Hermes has no native async generators, so Babel's `wrapAsyncGenerator` helper implements them. In `@babel/helpers` ≤ 7.28.6 (and the copy in `@babel/runtime`), once the consumer has called `return()`, **every** later resumption of an `await` is sent as a second `return`, so a `finally` block stops at its first `await`. Fixed in 7.29.2 (published 2026-03-16).
- **Verified by diff (garden, 2026-09-15).** `npm pack` of `@babel/helpers` 7.28.6 vs 7.29.2, `lib/helpers/wrapAsyncGenerator.js`, line 39:
  - 7.28.6: `var nextKey = key === "return" ? "return" : "next";`
  - 7.29.2: `var nextKey = key === "return" && value.k ? key : "next";` (only a real `return` delegation marker stays a return; an ordinary awaited value resumes with `next`).
  The same helper is also inlined in `lib/helpers-generated.js`.
- **Why the lockfile is stale.** Every RN/Expo dependency asks for `^7.20.0`-style ranges, so nothing forced a newer resolution. The highest 7.x of both packages is 7.29.7. **`latest` is 8.0.5**, so a bare `yarn up @babel/runtime` rewrites the manifest range to `^8` — a major upgrade this ticket must not make.

## Decisions carried over from the fix stage (still valid)

- **No Sereus-side workaround** (draining each early-exit loop or switching to `db.get`): the dependency bump removes the cause at every site.
- **No copy of a Quereus lint rule in Sereus**; the tripwire in `docs/testing.md` § Lint coverage stands. Re-word it if it names the dropped Quereus engine fix as the reason.

## Edge cases & interactions

- **Every copy, not just the hoisted one.** `packages/reference-app-rn` has its own nested `node_modules/@babel/helpers` and `@babel/runtime` at 7.28.6. Check with `yarn why @babel/helpers` and `yarn why @babel/runtime`, and read the `version` of each installed copy Metro can reach, including the nested ones.
- **Metro's transform cache** keeps old compiled output; device verification needs `expo start --clear`.
- **Other packages resolve these too** (web reference app, test tooling). A lockfile refresh within `^7` ranges changes them as well; run their builds and tests.
- **Node tests cannot see the bug**, because Node runs generators natively. That is why a guard is required below.

## Guard (required)

Pick the highest rung that works, and say which in the handoff:

1. **Preferred — a behaviour test through the app's own Babel config.** Compile a small async generator with an `await` inside `finally` using the app's `babel.config.js` (`babel-preset-expo`), forcing the generator transform on as it is for Hermes. Consume one item, call `return()`, and assert that the code after the `await` in `finally` ran. This fails on 7.28.6 and passes on ≥ 7.29.2, and it catches any future regression of the same class, whatever the version number. The fix stage already built such a model ("a Babel model of that shape (babel-preset-expo 13.2.5 and @babel/core 7.29.0)"); reuse its shape. Confirm the test **fails** with the old helpers before the bump: that proves it is not vacuous.
2. **Fallback — a version floor check.** Assert that every `@babel/helpers` and `@babel/runtime` copy reachable from `packages/reference-app-rn` is ≥ 7.29.2, and name the bug in the failure message.

## TODO

- Change `packages/reference-app-rn/package.json` `@babel/runtime` to `^7.29.7`.
- Refresh transitive resolutions inside their existing major: `yarn up -R @babel/helpers @babel/runtime` (or the equivalent that keeps every range on `^7`). Confirm no manifest range moved to `^8`, and that `yarn.lock` no longer resolves 7.28.6 for either package.
- Write the guard test first against the current lockfile and see it fail, then apply the bump and see it pass.
- Run `yarn workspace @serfab/reference-app-rn test`, the web reference app's tests and typecheck, `yarn lint`, and `yarn dep-check`.
- Update `docs/reference-app-rn.md` with the requirement (`@babel/helpers` / `@babel/runtime` ≥ 7.29.2, why, and the guard's name) and correct the `docs/testing.md` tripwire wording if needed.
- **Device verification is not agent-runnable** (Metro has to keep running, and another session may be driving the phone). Leave it for the human or RN session as a checklist in the review handoff: the steps below.

## Device verification checklist (for the human or RN session, after merge)

- `expo start --clear` so Metro recompiles with the new helpers. Rebuild the dev client only if a native module changed.
- Connect with an empty party id, then Create Chat Strand. Expect `[settings] create strand <id8> pressed`, then `succeeded in <n> ms` in logcat, with `sereus:cadre:timing` start and end lines for every founding step in development builds. The patched run took 2.7 s. A step with a start line but no end line is a new stall; name it.
- Exercise the other early-exit reads: create a second strand, send a message in the first, then force-stop, relaunch, Connect again, and check that any strand the app restores still accepts writes.
- Before tapping anything, make sure nobody else is driving the phone: `adb logcat -d | grep "Force stopping org.gotchoices"` and the list of local Claude sessions. Metro's inspector proxy admits one debugger client per device. `__r(<id>)` crashes the app; reach the node by walking React's fiber tree from `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(rendererId)`. Find buttons with `adb shell uiautomator dump`, and take screenshots from bash (`adb exec-out screencap -p > file`), not PowerShell.

## Original observation

Galaxy Note 9 (SM-N960U), Android 10, debug build of `reference-app-rn` (Expo SDK 53, RN 0.79.6, Hermes), JS from Metro over `adb reverse`. On 2026-09-14 a tap on Create Chat Strand produced no dialog, `Strands 0`, and no JS log line for about 2 minutes.
