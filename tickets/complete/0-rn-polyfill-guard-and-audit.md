description: Review the tests, boot-time check and documentation added to keep the phone's hand-written web API patches from silently disappearing, plus the two small leak fixes in those patches.
files:
  - packages/reference-app-rn/polyfills/hermes.js (AbortSignal.any detach, AbortSignal.timeout clear + comment, new abort-reason patch, registry marks)
  - packages/reference-app-rn/polyfills/registry.js (new — records which patches fired)
  - packages/reference-app-rn/polyfills/audit.js (new — boot-time native/polyfilled/gap/MISSING table)
  - packages/reference-app-rn/polyfills/event.js, intl-pluralrules.js, webrtc.js (registry marks), node-crypto.js (`@noble/hashes/sha2.js` subpath)
  - packages/reference-app-rn/index.js (imports the audit after the polyfills)
  - packages/reference-app-rn/vitest.config.ts (fourth project, `polyfills`)
  - packages/reference-app-rn/test/polyfills/hermes-polyfills.spec.ts (new)
  - packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts (new — drift guard)
  - packages/reference-app-rn/test/polyfills/metro-resolution.ts (new — finds installed packages via metro.config.js nodeModulesPaths)
  - packages/reference-app-ns/src/polyfills/audit.ts (comment only)
  - docs/reference-app-rn.md (§ Key Dependencies), docs/testing.md (lint-coverage bullet)
difficulty: medium
----

# Guard the Hermes polyfills, and write down what is still missing

## What landed

Two interrupted runs did this work. The first is committed as `6c59b45` (partial, salvaged); this run finished it with a few fixes listed at the end.

**`polyfills/hermes.js`**
- `AbortSignal.any` returns early without registering anything when an input has already aborted, and otherwise removes its `abort` listener from every input once the combined signal aborts. It stores (signal, listener) pairs rather than a Map, so a signal passed twice is detached twice.
- `AbortSignal.timeout` registers `clearTimeout(handle)` on the signal's own abort. The wrong "raw timer" comment is replaced by what actually happens: the bare `setTimeout` resolves at call time to the `.ref()`/`.unref()` wrapper, so the handle is an object.
- **Beyond the ticket:** a new patch on `AbortController.prototype.abort` that records `signal.reason`. React Native installs `abort-controller@3.0.0` (`Libraries/Core/setUpXHR.js`), which predates `reason`, so every `controller.abort(err)` lost its error. That is a likely reason the device failure showed only a generic `AbortError`. Without this patch the `TimeoutError` from `AbortSignal.timeout` would also be dropped. `throwIfAborted` now rethrows `this.reason`.
- Every patch calls `markPolyfilled(key)` from the new `registry.js` when it applies.

**Boot audit.** `polyfills/audit.js` probes a list of dotted global paths and prints `native` / `polyfilled` / `gap` / `MISSING`, with a `console.warn` for anything MISSING. It runs at module scope under `__DEV__`. `index.js` **imports** it after the other polyfills and before `expo-router/entry`, instead of calling it from its body as the ticket suggested. ES imports all evaluate before a module's body runs, so a call in the body would run after the app tree had loaded, and after any crash caused by a missing global. `AggregateError` and `DOMException` are probed with no expectation. `crypto.subtle.importKey` / `encrypt` are marked as known gaps. Both audit files now carry a comment saying why their probe lists are deliberately not shared.

**Tests (Vitest project `polyfills`, no stale-build guard):**
- `hermes-polyfills.spec.ts` reads the file as text and runs it with `new Function(...)`, passing a fake runtime as arguments: the real `abort-controller` classes React Native installs, a WebSocket class with no `bufferedAmount`, a `Promise` without `withResolvers`, `DOMException` set to `undefined`, timers that return numbers, and a stubbed `require` for `react-native-get-random-values` and `./registry`. It then drives `@libp2p/websockets`' own `webSocketToMaConn` (read by path from `dist/src/websocket-to-conn.js`) and checks `canSendMore: true`. A control case, using a WebSocket class the polyfill never patched, checks `canSendMore: false`. The fake socket was enough for the real connection code; no weaker substitute was needed. There are also tests for timeout/TimeoutError, `any` (reason, already-aborted, detach, register-nothing), abort reasons, digest, TextDecoder, withResolvers, and timer wrap/unwrap.
- `dependency-globals.spec.ts` searches the `dist` text of 24 listed packages for a fixed set of global names. Each name that appears must be recorded in `PROVIDED` as installed by React Native, by a polyfill, or allowlisted with a reason. The test fails if any `WATCHED` name (things Hermes lacks that nothing reads today) starts appearing. Sentinel names must still be found, so a broken scan cannot pass by finding nothing. It also checks that each polyfill-provided name still has its `markPolyfilled` call, and that every registry key named in `audit.js` is marked by some polyfill. Its header states the limits: substring search, hand-listed packages, comments count as hits, no knowledge of which file variant Metro picks.

**Docs.** `docs/reference-app-rn.md` § Key Dependencies now covers: the three dial-path APIs and why the phone could not dial without them; abort reasons; `crypto.subtle` being `digest`-only and which key operations therefore throw; a table of APIs checked and found not to be gaps (`queueMicrotask`, `performance.now`, `BroadcastChannel`, `WebAssembly`, `navigator.userAgent`); the unanswered `AggregateError` question; and a table of the guards. `docs/testing.md` has a matching bullet.

## Where this departs from the ticket — check these

- **The ticket's `navigator.userAgent` finding was wrong, and the docs say the opposite.** libp2p 3.1.3's package.json `react-native` field maps `user-agent.js` to `user-agent.react-native.js` (checked this run: `node -e` on `node_modules/libp2p/package.json`), which uses `Platform.OS`. So identify announces `react-native/android-<version>`, not `browser/undefined`. The first run also reports that the exported Android bundle contains `react-native/` and no `browser/`. This run did not re-export a bundle to confirm that.
- **`AbortSignal.timeout`'s timer cannot really be cleared early.** Only its own timer can abort the signal, because the controller is never handed out. The added `clearTimeout` on abort therefore only covers the case where the timer has already fired, which is a no-op. After a caller finishes, the timer still runs out its full duration (10 s for a dial). No API reports "operation finished" to the signal, and browsers behave the same way. The comment in `hermes.js` says this plainly. A reviewer should decide whether that comment is enough or whether the listener should go.
- The abort-reason patch is new scope, covered by two tests and documented.
- `node-crypto.js` and `hermes.js` now import `@noble/hashes/sha2.js` (the exported subpath) instead of `sha2`. Metro used to reach `sha2` by falling back to file-based resolution, with a warning on every bundle.

## Fixes made in this run

- `audit.js`: replaced `resolve()` with `isPresent()`, which reads the last path segment inside a try and counts a throwing getter as present. Before this, a future native `bufferedAmount` accessor read off `WebSocket.prototype` could throw and crash dev boot.
- `audit.js` + docs: noted that `EventTarget` always reads `native`, because `event-target-polyfill` installs it without marking the registry.
- `hermes-polyfills.spec.ts`: the fake runtime's timers now return numeric ids like Hermes. Before, Node's timer objects already had `ref`/`unref`, `wrapTimer` passed them through, and the timer test could not fail. It now also checks that `clearTimeout` actually cancels.
- `reference-app-ns/src/polyfills/audit.ts`: added the "probe lists are deliberately not shared" comment the ticket asked for in both files.

## Validation run

- `yarn workspace @serfab/reference-app-rn vitest run --project polyfills`: 22 passed.
- Mutation checks, run by editing `hermes.js` in place and restoring it from a backup (confirmed clean with `git status`):
  - Disabling the `bufferedAmount` getter failed 3 tests: installs-every-patch, keep-sending, zero-buffered.
  - Skipping the `any` detach failed the detach test.
  - Removing the `clearTimeout` unwrap failed the timer test.
- `yarn workspace @serfab/reference-app-rn test`: 19 files, 299 passed.
- `yarn workspace @serfab/reference-app-rn typecheck` and `@serfab/reference-app-ns typecheck`: exit 0. `yarn lint`: exit 0. The first run also passed root `yarn typecheck`, including the gate that checks every Vitest-collected test file is type-checked. This run added no test files.

## Known gaps

- **No device run.** Next device session: confirm the boot audit prints no `MISSING` rows, and record what it reports for `AggregateError` and `DOMException`. If Hermes lacks `AggregateError`, a fully failed dial throws `ReferenceError` instead of its causes and needs its own ticket. Also check that identify shows `react-native/`.
- `Symbol.asyncIterator`'s patch is not exercised by the spec, because the test runner's `Symbol` already has it (the spec's `REQUIRED_MARKS` comment explains this). The boot audit is the only check.
- The drift guard only sees the 24 listed packages and plain names. A global reached as `globalThis[name]` is invisible to it. Resolution through `metro-resolution.ts` follows `nodeModulesPaths` only, not the `node_modules` folders next to the importing file (noted in that file).
- The `abort-controller` classes are patched in place inside the Vitest worker. Nothing else in the `polyfills` project requires that module today.

## Review findings

Read both implement commits (`6c59b45`, `34bce69`) before the handoff. Checked every file in the diff, plus `docs/reference-app-rn.md` § Key Dependencies, `docs/testing.md`, Optimystic's repo client, `p-wait-for/index.js`, and the NativeScript ticket that copies the same abort-signal plan.

**Major, filed as a ticket:**
- **The `AbortSignal.any` detach does not fix the leak its comment and the docs named.** Optimystic's repo client (`../optimystic/packages/db-p2p/src/repo/client.ts:91`) clears its deadline timer on success and never aborts that controller. So the combined signal never aborts, and the listener stays on `options.signal` for every successful RPC. The polyfill cannot detach in that case: the DOM holds combined signals weakly, and Hermes gives the polyfill no garbage-collection hook. The fix belongs at the call site. Filed as `tickets/backlog/bug-abortsignal-any-leaks-listeners-on-hermes.md` (repro: static; whether any caller passes a session-long signal is unconfirmed). `p-wait-for` is covered, because its other input is an `AbortSignal.timeout`, which always fires. I corrected the `hermes.js` comment and the docs table row. I also added a correction to `tickets/implement/1-ns-websocket-cannot-send.md`, which planned the same detach for NativeScript on the same wrong premise and told the implementer to add the no-op timer clear too.

**Minor, fixed in this pass:**
- `AbortSignal.timeout`: removed the `clearTimeout(handle)` abort listener. Only the timer can abort that signal, so the listener could never clear a live timer; it was dead code with an eight-line comment. The implementer asked the reviewer to decide on this. The four-line "`setTimeout` resolves to the wrapper" comment went with it, since nothing needs the handle now. What remains is a `NOTE:` tripwire: the timer runs its full duration, bounded by `ms`; if long timeouts are created at a high rate, those callers should use a controller they can clear.
- The default AbortError message was "This operation was aborted" in the reason patch and "The operation was aborted." in `throwIfAborted` and `any`. Both now use the second wording.

**Checked, no change:**
- Abort-reason patch: sets `reason` before delegating, so `abort` listeners, including `any`'s `reasonOf`, see it. It is guarded by `'reason' in AbortSignal.prototype`, so a React Native that ships a native `reason` skips it. It is covered by two tests.
- `index.js` importing the audit, instead of calling it from the module body: correct, because ES imports all evaluate before the importing module's body runs.
- `audit.js` `isPresent` guards against a throwing getter. Its probe keys are cross-checked against `markPolyfilled` calls by `dependency-globals.spec.ts`.
- Test design: the fake runtime uses numeric timers, the real `abort-controller`, and a control class the polyfill never patched, so the tests can fail. The implementer's mutation checks cover the outage case.
- Resource cleanup and error handling in the specs: fake timers around the connection that stalls by design; `resolvePackageDir` throws instead of silently skipping.
- Accepted-tradeoff `NOTE:`s at these sites: none found.

**Gaps noted, not ticketed:**
- The audit has no row for `AbortSignal.reason`. The patch stores `reason` as an instance property, so a dotted-path probe on the prototype would report MISSING even after patching. The registry key is still marked and asserted by the spec. Recording this here rather than adding a special-case probe.
- The handoff's own known gaps still apply: no device run, `Symbol.asyncIterator` untested in Node, and the drift guard's substring and hand-listed-package limits.
- Sizes (`wc -l`): `hermes.js` 401 lines, `hermes-polyfills.spec.ts` 509, `dependency-globals.spec.ts` 292. The polyfill file is a flat list of independent guarded blocks and the spec is mostly doc-commented fixtures; no split warranted today.

**Validation after the review edits:** `yarn workspace @serfab/reference-app-rn vitest run --project polyfills` 22 passed; `yarn workspace @serfab/reference-app-rn test` 19 files / 299 passed; `yarn workspace @serfab/reference-app-rn typecheck` exit 0; `yarn lint` exit 0.
