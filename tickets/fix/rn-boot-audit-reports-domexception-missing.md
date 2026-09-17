----
description: Every start of the phone app in development prints a warning that a standard browser error type is missing. On the phone it really is missing, but nobody has decided whether that matters, so the warning fires on every launch and trains people to ignore the one check meant to catch missing web APIs.
files:
  - packages/reference-app-rn/polyfills/audit.js
  - packages/reference-app-rn/polyfills/hermes.js (`abortReason`, abort-reason patch)
  - packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts
  - docs/reference-app-rn.md (§ The web APIs the phone's connectivity depends on)
repro: verified
----

# The boot audit flags `DOMException` as MISSING on every launch

## Observed

Device run 2026-09-16 (Galaxy Note 9, Android 10, Expo SDK 53 dev client; see `complete/rn-device-audit-and-reload-run`). Every boot logs:

```
I ReactNativeJS:   ✓ AggregateError                         native
I ReactNativeJS:   ✗ DOMException                           MISSING
W ReactNativeJS: [reference-app-rn] MISSING globals before libp2p load: DOMException — something in the stack will read one of these and get undefined. ...
```

`typeof DOMException` evaluated on the device through the inspector: `"undefined"`.

The audit's contract is that a MISSING row is absent *and unexplained*. The `DOMException` probe was added with no expectation, to be answered on a device. It is now answered, so the row should be either polyfilled or recorded as a `gap` with a reason.

## Who reads it (from the dev bundle Metro served in this run)

- `polyfills/hermes.js` `abortReason`: already guarded (try/catch, falls back to a named `Error`).
- `p-timeout/index.js`, two copies nested under `../optimystic/packages/db-p2p/node_modules` and `../Fret/packages/fret/node_modules`: `signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')`. Unguarded. It is reached only when an aborted signal has no `reason`. The abort-reason patch in `hermes.js` sets `reason` on every `AbortController.abort()`, so this is probably unreachable today. That is inferred from the code and was not exercised on the device.
- `@expo/metro-runtime` `Location.native.ts`: throws `new DOMException(...)` on `location` setters and in a `reload()` fallback branch that is not taken (the device run showed `reload` going through `DevSettings.reload`).
- Two minified modules (bundle lines ~2830 and ~93101, not identified) read `global.DOMException` and check it before use.

`dependency-globals.spec.ts` never saw these readers: it scans `@optimystic/db-p2p`'s own `dist` but not packages nested in its `node_modules`, and has no `DOMException` entry.

## Expected

- No MISSING row on a clean boot. Either install a small `DOMException` (an `Error` subclass with `name` and `code`) and mark the registry, or record the probe as a `gap` whose reason names the readers above and why they are safe.
- The drift-guard spec accounts for `DOMException` (provided or allowlisted), so a new unguarded reader is not invisible.

## Related doc facts the same run settled

`docs/reference-app-rn.md` still calls these open. Update them with this ticket:

- `AggregateError` is native in this Hermes (`typeof` is `function`; `new AggregateError([new Error('x')], 'm')` gives `errors.length === 1`, correct `message`, `instanceof Error`). The "One question a headless test cannot answer" paragraph, the `AggregateError` allowlist reason in `dependency-globals.spec.ts`, and the comment in `audit.js` can say so.
- The identify agent string the phone announces is `js-libp2p/3.1.3 react-native/android-29` (read from `services.identify.host.agentVersion` and from the node's own peer-store `AgentVersion`). The doc's `navigator.userAgent` row says `libp2p/<version> react-native/android-<version>`; the prefix is `js-libp2p/`.
- `TextDecoder`, `ReadableStream`, `WritableStream` and `TransformStream` read `native` on the device, so their polyfills' guards do not fire under Expo SDK 53.
