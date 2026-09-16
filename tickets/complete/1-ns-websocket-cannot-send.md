description: Fixed the NativeScript reference app so it can actually send data over a WebSocket connection to another machine (mirroring the React Native fix), and stopped its AbortSignal.any polyfill from leaking listeners.
files:
  - packages/reference-app-ns/src/polyfills/websocket.ts
  - packages/reference-app-ns/src/polyfills/index.ts
  - packages/reference-app-ns/src/polyfills/hermes.ts
  - packages/reference-app-ns/src/polyfills/abort.ts
  - packages/reference-app-ns/src/polyfills/audit.ts
  - packages/reference-app-ns/app/app.ts
  - packages/reference-app-ns/test/polyfills.spec.ts
  - packages/reference-app-ns/README.md
  - docs/reference-app-ns.md
----

# NativeScript WebSocket bufferedAmount shim + AbortSignal.any listener leak

## What shipped

- **`WebSocket.prototype.bufferedAmount` shim.** `@valor/nativescript-websockets` declares `bufferedAmount` in its types but never assigns it (confirmed again in review: the name appears only in `websocket.d.ts`). `@libp2p/websockets` gates every send on `bufferedAmount < maxBufferedAmount`, so against `undefined` it never writes and the dial dies on the 10 s timeout. The shim is a prototype getter returning `0`, guarded so a real implementation wins, and reported by the boot audit. Same defect as the React Native fix in commit `7a0fd6c`.
- **Load order.** The shim lives in `src/polyfills/websocket.ts`, which imports `@valor/nativescript-websockets` itself before patching, and is the last entry in the polyfill barrel. `app/app.ts` now has a single polyfills import.
- **`AbortSignal.any` (`src/polyfills/abort.ts`)** detaches its listeners from every input once the combined signal aborts, and registers nothing when an input is already aborted. The never-aborted case (Optimystic's repo client clearing, not aborting, its deadline) is not fixable inside the polyfill and stays tracked in `tickets/backlog/bug-abortsignal-any-leaks-listeners-on-hermes.md`.
- `AbortSignal.timeout` logic unchanged; a `NOTE:` explains why there is no timer to clear.

## Review findings

**Diff read:** `73b47d1` (implement commit), plus the RN counterparts in `packages/reference-app-rn/polyfills/{hermes,audit}.js` and `test/polyfills/hermes-polyfills.spec.ts`.

**Structure / maintainability — fixed inline.** The implementation exported `patchWebSocketBufferedAmount()` from `hermes.ts` and relied on `app.ts` calling it after a separate plugin import. The ordering reasoning was correct (a module-scope patch in the barrel would have run before the global existed and silently done nothing), but the fix depended on two lines in `app.ts` staying in order, and it was the one polyfill that broke the "runs at import time" rule, which needed paragraphs of docs to explain. Replaced with `src/polyfills/websocket.ts`: it imports the plugin and then patches, so the ordering is enforced by the module graph and cannot be undone by moving a call. Removed the export and the explanatory exceptions from `hermes.ts`, `index.ts`, `app.ts`, and the docs.

**Test coverage — fixed inline.** The implement pass added no tests for either change (RN has a spec for both). Added `test/polyfills.spec.ts` (7 tests): the shim installs after a mocked plugin sets the global and marks the registry; an existing `bufferedAmount` is left alone; `AbortSignal.any` takes the firing input's reason, detaches from non-firing inputs, detaches both registrations when a signal is passed twice, and registers nothing when an input is already aborted. Each test removes Node's native global, re-evaluates the module with `vi.resetModules`, and restores the global afterwards.

**Docs — fixed inline.** `docs/reference-app-ns.md`: startup sequence rewritten for the single import. The barrel-order sentence was already stale before this ticket (it left out `process`, `intl-datetimeformat`, `abort`, `broadcast-channel`); corrected it. The polyfill table now points at `websocket.ts`. `README.md` layout lines and the `audit.ts` header comment updated to match.

**AbortSignal.timeout wording (implementer's question 2).** Confirmed: the implement ticket's correction paragraph replaced its TODO wording. Only the timer can abort that signal, so there is nothing to clear on abort. No change.

**Correctness / error handling / resource cleanup.** `any` matches the verified RN version, including the duplicate-signal case (pairs rather than a Map) and the early return. The combined signal's own abort listener is `once`, so it doesn't hold on after firing. No issues found.

**Type safety.** The shim guards on `typeof globalThis.WebSocket === 'function'` and a non-null prototype. The test casts are confined to the fake globals. No `any`.

**Performance.** Not relevant: these are one-time boot patches plus one listener per input per `any` call. Nothing to change.

**Tripwire.** The NS audit reads `WebSocket.prototype.bufferedAmount` off the prototype with no try. If the plugin ever ships a real accessor that throws when called without an instance, boot would crash. Parked as a `NOTE:` on that probe in `src/polyfills/audit.ts`, pointing at the RN audit's try/catch.

**Not verified: device check (implementer's question 3).** There is still no NativeScript device or emulator in this pipeline, so no one has watched a real dial succeed. The only thing that could make this fix unnecessary is the plugin setting `bufferedAmount` from native code, which a source search can't see. The shim is harmless in that case because the guard defers to an existing property. So this doesn't block completion. `test:bundle:native` and `test:e2e` (Maestro) were not run; they need a device and a human should run them.

**Validation (all in this review pass):**
- `yarn workspace @serfab/reference-app-ns typecheck`: clean.
- `yarn workspace @serfab/reference-app-ns test`: 6 files, 110 tests passed.
- `yarn workspace @serfab/reference-app-ns test:bundle`: webpack compiled with 0 errors and 0 warnings.
- `yarn lint`: exit 0.
- The stale-build guard tripped on `@optimystic/db-p2p` because of uncommitted, in-progress edits in the sibling `../optimystic` checkout. Rebuilding printed type errors from that sibling's own in-progress test files (`test/under-replication-drain.spec.ts`), which this ticket doesn't touch. `tsc` still emitted and the guard then passed. This is not a failing test in this repo, so no pre-existing-error report was filed.
