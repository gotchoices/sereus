description: The phone app now supplies a small stand-in for a standard browser error type that its JavaScript engine lacks, so every development launch stops warning about it, and the docs record what a device run settled about the phone's runtime.
files:
  - packages/reference-app-rn/polyfills/hermes.js (`DOMException` arm above the AbortSignal arms; `abortReason`)
  - packages/reference-app-rn/polyfills/audit.js
  - packages/reference-app-rn/test/polyfills/hermes-polyfills.spec.ts
  - packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts
  - docs/reference-app-rn.md (§ Global polyfills table; § The web APIs the phone's connectivity depends on; § Guards)
----

# Review: minimal `DOMException` on Hermes, boot audit probes settled

## What changed

A device run on 2026-09-16 (Galaxy Note 9, Android 10, Expo SDK 53 dev client) answered the boot audit's two open probes: `AggregateError` is native in Hermes, `DOMException` is absent. Every dev boot logged `✗ DOMException MISSING` and a warning.

- `polyfills/hermes.js`: new arm, guarded by `typeof globalThis.DOMException === 'undefined'`, installs `class DOMException extends Error` on `globalThis` and marks registry key `DOMException`. `constructor(message = '', name = 'Error')` sets `name` as an own property; a `code` getter reads the DOM's full legacy code table (22 names, 0 for anything else). Placed after `Promise.withResolvers` and before the AbortSignal arms. `abortReason` now does `new globalThis.DOMException(...)` (kept its try/catch fallback) so the spec's fake `globalThis` and the real bundle agree.
- `polyfills/audit.js`: `AggregateError` moved to the native group with a comment; `DOMException` moved to the installed group with `key: 'DOMException'`; the "Unresolved from a desk" block is gone.
- `hermes-polyfills.spec.ts`: header updated (abort reasons are now the stand-in); `DOMException` added to `REQUIRED_MARKS`; new `describe('DOMException, which Hermes does not have')` checks: installed on `globalThis` with constructor name `DOMException`; bare `abort()` reason is an instance of it and of `Error`, `name: 'AbortError'`, `code: 20`, `String()` → `AbortError: The operation was aborted.`; `AbortSignal.timeout` reason is an instance with `TimeoutError`/`23`; `new DOMException()` → `Error`/`''`/`0`; an unlisted name → code 0; `InvalidStateError` → 11.
- `dependency-globals.spec.ts`: `PROVIDED` gains `DOMException` (polyfill, hermes.js); `AggregateError` moved from `allowlist` to `by: 'react-native'` with "native in Hermes — confirmed on a device 2026-09-16" (same pattern as the existing `TextEncoder` and `EventTarget` entries, which Hermes also provides). "What this is NOT" now names the miss: packages with no `dist`, and copies in a sibling checkout's own `node_modules`, are not scanned. `p-timeout` is the example. The scan was not widened.
- `docs/reference-app-rn.md`: `DOMException` row in the polyfill table; the streams and `TextDecoder` rows say the device reports them `native` under SDK 53 and name what installs them (`expo/virtual/streams.js`, `expo/src/winter/runtime.native.ts`); `navigator.userAgent` row now says `js-libp2p/<version>` with the observed `js-libp2p/3.1.3 react-native/android-29`; the `AggregateError` paragraph now records the device answer; new `DOMException` paragraphs; the Guards table's audit row no longer mentions the `AggregateError` question.

## Where the ticket was wrong (corrected in code comments and docs)

- **`@expo/metro-runtime` does not read the global.** `src/location/Location.native.ts` (5.0.5) declares its own module-local `class DOMException extends Error` at line 4. A bundle text search matches it, but it was never at risk. Only `p-timeout` 7.0.1 (`index.js` line 10) constructs the global without checking.
- **The stand-in does not reach every module that checks for the global.** Searching the installed packages (not the dev bundle) found three. They check for a global `DOMException` and build their own when there is none:
  - `react-native-webrtc`'s nested `event-target-shim` 6.0.2 checks each time it raises `InvalidStateError`, so it now uses the stand-in (code 11, which the spec asserts).
  - `whatwg-fetch` 3.6.20 (React Native's `fetch`) checks once, when React Native lazily loads `fetch`. It uses the stand-in only if that happens after `hermes.js` runs. Nobody checked when that first load happens.
  - `expo/virtual/streams.js` is a Metro bundle polyfill (added by `@expo/cli`'s `withMetroMultiPlatform.js` `getPolyfills`). It runs before `index.js`, so it never sees the stand-in and keeps its own class.
  - I did not match these to the dev bundle's lines ~2830 and ~93101. Line ~2830 is probably the Expo streams polyfill, since bundle polyfills come first, but that is unconfirmed. Grep a `yarn start` dev bundle to settle it.

## Validation run

- `yarn vitest run --project polyfills` (from `packages/reference-app-rn`): 3 files, 30 tests pass, including the 4 new ones.
- `yarn test` (all app projects): 21 files, 315 tests pass.
- `yarn lint` (repo root): exit 0. `yarn typecheck` (app): exit 0.
- A one-off script (not committed, kept outside the repo) compiled the class with the app's own Metro Babel transformer and the Hermes Android dev options that `test/metro-babel/async-generator-cleanup.spec.ts` uses, as both `module` and `script`. Babel lowers the class through `_wrapNativeSuper`. In Node, the lowered output kept constructor name `DOMException`, both `instanceof` checks true, and correct `name`, `message`, `code` and `String()`, plus the defaults.

## Known gaps: please check these

- **Device confirmation is pending (not agent-runnable).** The next dev-client boot should show `∙ DOMException polyfilled`, `✓ AggregateError native`, and no MISSING warning.
- **The spec does not test the Babel-lowered class.** `hermes-polyfills.spec.ts` evaluates `hermes.js` as raw text in Node, where `class extends Error` is native. Only the uncommitted script above checked the lowered form, and only in Node, not Hermes. If Hermes' `Reflect.construct` behaves differently, only the device will show it. Consider whether the `metro-babel` project should compile `hermes.js` itself.
- **The unchecked `p-timeout` path was never exercised.** It needs a signal aborted without a reason. The docs call it probably unreachable today and made correct by the stand-in anyway.
- **Arm order on bare React Native (not the Expo setup here).** The `ReadableStream` arm, which loads `web-streams-polyfill`, sits above the `DOMException` arm. If that arm ever fires, the polyfill builds its own class instead of using the stand-in. That does no harm, and it does not fire under SDK 53. I left the order alone so the diff stays small.
- The stand-in has no static code constants (`DOMException.ABORT_ERR`). `@ungap/structured-clone` 1.3.0 copies it as a plain `Error` with only the message: it records the `Object.prototype.toString` tag (`Error`), not `.name`. Both limits are documented.
