description: Ran the phone app's startup check of web APIs and the tools that explain unexpected app reloads on the Android test phone for the first time. Both work as designed. The run found one API the startup check always flags and several places where the guide differs from what the phone logs, and filed both.
files:
  - packages/reference-app-rn/polyfills/audit.js
  - packages/reference-app-rn/polyfills/reload-reason.js
  - packages/reference-app-rn/scripts/metro-hmr-observe.mjs
  - docs/reference-app-rn.md
----

# Device run: boot polyfill audit, reload diagnostics, node start

Run by an agent driving the phone over adb and Metro's inspector, 2026-09-16 22:29–22:43.

## Setup

- Galaxy Note 9 (SM-N960U), Android 10 (API 29), debug `reference-app-rn` dev client (Expo SDK 53), JS from Metro over `adb reverse tcp:8081 tcp:8081`, launched with `sereus-chat://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`.
- Sereus `139d9ff` (clean), Optimystic `7cd71341`, Quereus `ff1c619c6` (uncommitted edits in `schema-differ.ts` by another runner, not rebuilt during the run), Fret `8f6bd03`.
- Screen awake and unlocked throughout. `stay_on_while_plugged_in` was `0`; set to `usb` for the run. Restored to `0` after adb recovered from a hang at cleanup (see the notes at the end).
- The first launch after `yarn start --clear` failed with the dev launcher's "timeout" screen. Fetching the Android bundle once from the PC (20 s, 4825 modules) fixed the next launch.

## Results

| Check | Result | Evidence |
|---|---|---|
| 1. Boot audit table | **Pass, one MISSING** | Below |
| 1. `AggregateError` native in Hermes | **Yes** | Audit row `native`; inspector eval: `new AggregateError([new Error('x')],'m')` → `errors.length 1`, `message 'm'`, `instanceof Error` |
| 1. Identify agent string | `js-libp2p/3.1.3 react-native/android-29` | `services.identify.host.agentVersion`, and the node's own peer-store metadata `AgentVersion`; `ProtocolVersion` `optimystic/control-7ddabbe9-…/0.1.0` |
| 2a. `yarn start`, edit `polyfills/event.js` | **Pass** | Observer `22:37:48.281 update: 1 modified … packages/reference-app-rn/polyfills/event.bundle`; logcat `22:37:47.715 W/ReactNativeJS '[reload] (no reason given) caller:', 'Error: reload caller\n at logReload … at reload … at performFullRefresh …'`; `22:37:55.399 Running "main"`. Phone clock ran ~0.65 s behind the PC. The revert reloaded the same way (22:38:26) |
| 2b. `start:frozen`, same edit and revert | **Pass** | Metro: `Metro is running in CI mode, reloads are disabled`. Dev client connected via deep link. 45 s after edit and revert: no observer output, no JS log lines |
| 2c. `yarn start`, write/modify/delete `tickets/zz-reload-probe.md` and `.json` | **Pass** | 30 s window: no observer output, no JS log lines |
| 2d. Dev menu (`keyevent 82`) → Reload | **No `[reload]` line** | `22:39:37 polyfill audit`, `22:39:42 Running "main"`, nothing matching `[reload]` |
| 3. Connect, empty party id | **Pass** | Two runs. Under `yarn start`: `[start] total 4982 ms` (`createControlNode` 386, `controlDatabase.initialize` 4515, of which `loadSchema` 4442). Under `start:frozen`: total 4885 ms (`controlDatabase.initialize` 4436, `loadSchema` 4354). UI "Connected", Strands 0, "Reachable: No — no relay configured". Only error: see push-wake below |

Every temporary edit was reverted (`event.js` restored from a copy, probe files deleted). `git status` was clean after each check.

### Audit table (identical on every boot)

native: `process.env`, `queueMicrotask`, `performance.now`, `EventTarget`, `WebSocket`, `AbortController`, `TextEncoder`, `crypto.getRandomValues`, `TextDecoder`, `ReadableStream`, `WritableStream`, `TransformStream`, `Symbol.asyncIterator`, `AggregateError`.
polyfilled: `setTimeout`, `crypto.subtle.digest`, `structuredClone`, `Promise.withResolvers`, `AbortSignal.prototype.throwIfAborted`, `AbortSignal.timeout`, `AbortSignal.any`, `WebSocket.prototype.bufferedAmount`, `CustomEvent`, `Intl.PluralRules`, `RTCPeerConnection`.
gap: `crypto.subtle.importKey`, `crypto.subtle.encrypt`.
MISSING: `DOMException`, with the boot warning.

## Found during the run

- **Filed `fix/rn-boot-audit-reports-domexception-missing`.** `DOMException` is absent. Its readers are guarded or probably unreachable, but the warning fires on every boot and the drift-guard spec cannot see the readers. The ticket also lists the doc facts this run settled (`AggregateError`, agent string prefix `js-libp2p/`).
- **Filed `fix/rn-reload-docs-disagree-with-device`.** The reload tools behave as documented. The logcat line format, the "unconfirmed" caveats and the cold-Metro launch timeout need doc updates.
- **Not filed: push-wake cannot get a device token on this build.** 3 s after each node start: `[push-wake] getDevicePushTokenAsync failed: … Default FirebaseApp is not initialized …`. The package has no `google-services.json`, so push wake cannot work on this dev build. The app logs a warning and carries on. Providing FCM credentials is a setup decision, not a code defect.
- The dev menu lists "Fast refresh OFF", yet HMR updates arrived and triggered full reloads. Not investigated.
- The peer id `12D3KooWCBCswrmKEWKdhCzpkVuAPFeRNvrhigWDsZPsKprwAm2B` was the same across force-stops, as expected from the enclave-stored identity.

## Driving the phone: notes

- Inspector: `ws://localhost:8081/inspector/debug?device=<id>&page=1` (from `/json/list`). Page 2 has no React DevTools hook. Node 22's global `WebSocket` is enough for `Runtime.evaluate`. The node is found by walking `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(1)` for an object with `getControlNode`.
- Settings tab tap `(810, 2030)`; Connect button `(540, 1292)` with the keyboard down.
- The adb server on port 5037 is ASUS GlideX's `adb.exe` (`C:\Program Files\ASUS\GlideX\adb.exe`, orphaned, started 01:32), not the SDK's. Every command in this run went through it. At 22:44, during cleanup (after Metro was stopped and the logcat capture killed), it stopped answering: `adb reverse --remove`, `adb devices` and `adb reverse --list` all hung for more than 2 minutes, while Windows still listed "SAMSUNG Android ADB Interface" as present. After the stuck client was killed, the SDK's own adb started a fresh server on 5037 and the phone came back. The reverse rule list was then empty, and `stay_on_while_plugged_in` was set back to `0` (read back as `0`). To avoid the clash, end the GlideX adb process before a device session.
