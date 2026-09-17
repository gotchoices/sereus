description: The phone app now supplies a small stand-in for a standard browser error type that its JavaScript engine lacks, so every development launch stops warning about it, and the docs record what a device run settled about the phone's runtime.
files:
  - packages/reference-app-rn/polyfills/hermes.js
  - packages/reference-app-rn/polyfills/audit.js
  - packages/reference-app-rn/test/polyfills/hermes-polyfills.spec.ts
  - packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts
  - docs/reference-app-rn.md
----

# Complete: minimal `DOMException` on Hermes, boot audit probes settled

A device run on 2026-09-16 (Galaxy Note 9, Android 10, Expo SDK 53 dev client) found that `AggregateError` is native in Hermes and `DOMException` is absent. So every dev boot logged `✗ DOMException MISSING`.

- `polyfills/hermes.js` installs `class DOMException extends Error` on `globalThis` when there is none. It has `name`, `message`, the legacy numeric `code` table and `instanceof Error`, and marks the registry key `DOMException`. `abortReason` now builds its abort reasons from `globalThis.DOMException`.
- `polyfills/audit.js`: `AggregateError` is in the native group and `DOMException` in the installed group. The "unresolved from a desk" block is gone.
- Specs: `DOMException` is in `REQUIRED_MARKS`, with a new describe block covering the constructor name, the abort and timeout reasons, the defaults and the legacy codes. In `dependency-globals.spec.ts`, `PROVIDED` gains `DOMException` and moves `AggregateError` to `react-native`. Its header now says the scan does not see packages with no `dist` or copies in sibling checkouts.
- `docs/reference-app-rn.md`: new polyfill table row. The `AggregateError` and `DOMException` paragraphs record the device answers. The streams, `TextDecoder` and `navigator.userAgent` rows are corrected.

Device confirmation is still pending (not agent-runnable). The next dev-client boot should show `∙ DOMException polyfilled`, `✓ AggregateError native`, and no MISSING warning.

## Review findings

Checked: the implement diff (`3965655`) in all five files. I checked the class against the DOM spec's constructor defaults and legacy code table. I checked the `web-streams-polyfill` claim (its ponyfill does test the constructor name `"DOMException"`, confirmed in `dist/ponyfill.js`), the docs table and paragraphs, audit probe grouping, and spec coverage.

- **Fixed: wrong ordering claim.** The comment "Must stay above the AbortSignal arms, which call `abortReason`" was false. `abortReason` reads `globalThis.DOMException` when an abort happens, not when the arms install, so arm order does not matter. I removed the claim.
- **Fixed: the comment repeated the docs.** The 22-line block restated the docs' paragraphs about which modules check for the global (event-target-shim, whatwg-fetch, expo streams). I cut it to a `Required by:` line, a one-sentence summary and a pointer to the docs section, in the style of the other arms.
- **Tripwire, parked as a `NOTE:` on the class in `hermes.js`:** the Babel-lowered class (`_wrapNativeSuper`) was checked only in Node. The spec evaluates unlowered source. If the device audit shows a wrong `instanceof` or `name`, compile `hermes.js` in the `metro-babel` project.
- **Considered, no action:**
  - `name` is an own enumerable property, where the spec has a prototype getter. Callers only read `.name` and `String()`, and it matches the fallback `abortReason` pattern.
  - The `abortReason` try/catch fallback is now effectively unreachable. It is pre-existing and documented as a guard in case the arm is removed.
- **Not verified (carried from the handoff, not reproducible here):**
  - When `whatwg-fetch` first loads relative to `hermes.js`.
  - Which dev-bundle lines hold the injected classes.
  - The unchecked `p-timeout` path at runtime.
  - The device boot.
  - These are documented in the docs as unconfirmed, and none can be settled without a device or a dev bundle.
- **No new tickets:** no finding is major.
- **Validation:**
  - `yarn lint` (root): exit 0.
  - `yarn typecheck` (app): exit 0.
  - `yarn vitest run --project polyfills --project metro-babel --project react`: 6 files, 60 tests pass.
  - `yarn test` could not start the `node` project. Its stale-build guard reported `@optimystic/db-core: dist is stale`, a sibling checkout this ticket does not touch (an environmental build state, not a failing test). The implementer's run of that project was green, and this review changed only comments in `hermes.js`, which the `node` project does not exercise.
