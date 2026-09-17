description: Every development launch of the phone app warns that a standard browser error type is missing. It really is missing on the phone, and one dependency uses it without checking, so add a small stand-in, stop the false alarm, and write down the other runtime facts the same device run settled.
files:
  - packages/reference-app-rn/polyfills/hermes.js (`abortReason`, abort-reason patch)
  - packages/reference-app-rn/polyfills/audit.js
  - packages/reference-app-rn/test/polyfills/hermes-polyfills.spec.ts
  - packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts
  - docs/reference-app-rn.md (§ The web APIs the phone's connectivity depends on)
repro: verified
----

# Install a minimal `DOMException` on Hermes and settle the boot audit's open probes

## Background

`polyfills/audit.js` runs at boot in development builds and prints each global the libp2p stack reads as `native`, `polyfilled`, `gap` (known absent, with a written reason) or `MISSING` (absent and unexplained, which also logs a warning). Two probes, `AggregateError` and `DOMException`, were added with no expectation because only a device could answer them.

The device run of 2026-09-16 (Galaxy Note 9, Android 10, Expo SDK 53 dev client) answered both:

- `AggregateError` is native. `typeof` is `function`, and `new AggregateError([new Error('x')], 'm')` has `errors.length === 1`, the right `message`, and is `instanceof Error`.
- `DOMException` is absent (`typeof DOMException === 'undefined'`). Every boot logs `✗ DOMException MISSING` plus the warning.

## Decision: polyfill it rather than record a gap

Readers of `DOMException` found in the dev bundle Metro served:

- `polyfills/hermes.js` `abortReason` — guarded with try/catch; falls back to an `Error` with `name` set.
- `p-timeout@7.0.1` `index.js` line 10: `signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')`. Unguarded. Copies are installed at the repo root and nested under `../optimystic/packages/db-p2p/node_modules` and `../Fret/packages/fret/node_modules` (pulled in by `p-queue` / `p-event`). Reached only when an aborted signal has no `reason`; the abort-reason patch in `hermes.js` sets one on every `AbortController.abort()`, so this is probably unreachable today (inferred from code, not exercised on the device). But a signal aborted by anything that bypasses `AbortController.prototype.abort` would turn a clean cancellation into `ReferenceError: DOMException is not defined`.
- `@expo/metro-runtime` `Location.native.ts` — throws `new DOMException(...)` from `location` setters and an untaken `reload()` fallback. Today those would throw a `ReferenceError` instead of the intended error; with the polyfill they throw the intended one.
- Two unidentified minified modules (dev bundle lines ~2830 and ~93101) read `global.DOMException` and check it before use. Installing it switches them onto their "present" branch; that is the branch they take in every browser, so it is expected to be safe, but see the TODO about checking them.

Recording a `gap` would mean arguing that the `p-timeout` path is unreachable forever, which rests on a different patch staying in place. A stand-in is a few lines, makes every reader above correct regardless, and lets `abortReason` produce real `DOMException`s, matching what libp2p sees in browsers and Node.

## Shape of the stand-in

Install in `polyfills/hermes.js`, guarded by `typeof globalThis.DOMException === 'undefined'`, placed **before** `abortReason` is first called (i.e. above the `throwIfAborted` / abort-reason / `AbortSignal.timeout` arms), then `markPolyfilled('DOMException')`.

```js
class DOMException extends Error {
	constructor(message = '', name = 'Error') {
		super(message);
		this.name = name;   // own property; callers branch on err.name
	}
	get code() { return LEGACY_CODES[this.name] ?? 0; }
}
```

- `LEGACY_CODES` only needs the names this stack uses: `AbortError: 20`, `TimeoutError: 23`, and optionally the rest of the spec's legacy table if it stays short. No `code` is not a failure; wrong `code` would be.
- Must satisfy `err instanceof Error`, `err.name === 'AbortError'`, `err.message`, and `String(err)` → `AbortError: ...`.
- No npm package: the known ones (`domexception`) pull `webidl-conversions`/`whatwg-url`-style machinery that is far larger than the need. Say so in the comment.
- Keep `abortReason`'s try/catch fallback: it still matters if the polyfill guard is ever removed, and it costs nothing. Update its comment to say the polyfill above normally supplies `DOMException`.

## Audit and guards

- `audit.js`: move `DOMException` to the "Installed by this directory" group with `key: 'DOMException'`. Move `AggregateError` to the React-Native-startup/native group with a one-line comment that the 2026-09-16 device run found it native in this Hermes. Delete the "Unresolved from a desk" comment block.
- `hermes-polyfills.spec.ts` still injects `DOMException` as `undefined` (line ~214), which remains correct (it models Hermes). Add assertions: after evaluation the fake `globalThis.DOMException` exists; an abort reason from `controller.abort()` with no argument is an instance of it, `instanceof Error`, `name === 'AbortError'`, `code === 20`; and the `AbortSignal.timeout` reason has `name === 'TimeoutError'`. Update the header paragraph that says abort reasons are plain `Error`s. Check how the spec reads globals back from the fake surface — the polyfill must assign `globalThis.DOMException`, and `abortReason` must read that (a bare `DOMException` identifier resolves to the injected `undefined` parameter in the spec's `new Function` scope; in the real bundle bare and `globalThis.` are the same). Prefer `globalThis.DOMException` inside `abortReason` so both agree.
- `dependency-globals.spec.ts`:
  - Add `DOMException: { by: 'polyfill', file: 'hermes.js', key: 'DOMException' }` to `PROVIDED`.
  - Rewrite the `AggregateError` allowlist `why` to "native in Hermes — confirmed on a device 2026-09-16"; consider moving it to `by: 'react-native'` with that reason (the type's doc comment says React Native's startup; if moving it there reads wrong, keep it `allowlist`).
  - Extend the header's "What this is NOT" list with the concrete miss that hid these readers: packages that live in a sibling checkout's own `node_modules` (e.g. `p-timeout` under `../optimystic/packages/db-p2p/node_modules`) and packages with no `dist` directory are not scanned. Do not widen the scan in this ticket.

## Docs (`docs/reference-app-rn.md`)

- Replace the "One question a headless test cannot answer" paragraph: `AggregateError` is native in this Hermes (device run 2026-09-16), so a fully failed dial carries its per-address causes. Remove "and the only thing that can answer the `AggregateError` question" from the Guards table's audit row.
- Add a short paragraph (or a row in the polyfill table around line 278–284) for `DOMException`: absent in Hermes, who reads it (`p-timeout`, `@expo/metro-runtime`, `abortReason`), what the stand-in covers (`name`, `message`, `code`, `instanceof Error`), and what it does not (no structured-clone serialization, no full legacy-code table if trimmed).
- `navigator.userAgent` row: the device announces `js-libp2p/3.1.3 react-native/android-29` (from `services.identify.host.agentVersion` and the node's own peer-store `AgentVersion`). Change `libp2p/<version>` to `js-libp2p/<version>`, and the "announces `browser/undefined`" sentence below the table likewise if it implies the prefix.
- `TextDecoder` row (line ~284) and the `ReadableStream`/`WritableStream`/`TransformStream` row: the device reports all four `native` under Expo SDK 53, so these polyfills' guards do not fire there. Say so.

## TODO

- Add the `DOMException` stand-in to `polyfills/hermes.js` above the first use of `abortReason`; mark `DOMException`; make `abortReason` read `globalThis.DOMException`; update its comment.
- Update `polyfills/audit.js` probe groups and comments (`DOMException` keyed, `AggregateError` native, drop the "Unresolved" block).
- Extend `test/polyfills/hermes-polyfills.spec.ts` with the `DOMException` assertions above; update its header.
- Update `test/polyfills/dependency-globals.spec.ts` (`PROVIDED` entry, `AggregateError` reason, header limitation).
- Update `docs/reference-app-rn.md` per the Docs section.
- Glance at the two minified modules that probe `global.DOMException` (search the dev bundle from `yarn start`, or grep `node_modules` for `global.DOMException` / `typeof DOMException`) and name them in the doc paragraph if identified; if they cannot be identified cheaply, say so in the review handoff.
- Run `yarn workspace reference-app-rn vitest run --project polyfills` (check the package's actual name/scripts in `packages/reference-app-rn/package.json`) and `yarn lint`.
- Device confirmation (not agent-runnable): next dev-client boot should show `∙ DOMException polyfilled` and no MISSING warning. Note it as pending in the review handoff.
