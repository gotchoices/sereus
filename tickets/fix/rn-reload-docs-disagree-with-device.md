----
description: The phone app's guide for diagnosing unexpected reloads was written before anyone tried it on a phone. A device run confirmed the tools work, but the log lines look different from what the guide shows, and the guide still says it is unconfirmed, so people following it will search for text that never appears.
files:
  - docs/reference-app-rn.md (§ Device test runs)
  - tickets/backlog/debt-verify-reload-diagnostics-on-device.md
repro: verified
----

# Device-test-run docs lag what the phone actually logs

Device run 2026-09-16, recorded in `complete/rn-device-audit-and-reload-run`. The behaviour matched the docs. Only the wording and some details differ.

## Differences found

- **Format of the `[reload]` line.** The doc shows

  ```
  W ReactNativeJS: [reload] (no reason given) caller: Error: reload caller
  W ReactNativeJS:     at ...
  ```

  On the device, `console.warn` with two arguments prints both quoted and comma-separated on one logcat line, with the stack's newlines escaped:

  ```
  W/ReactNativeJS(16513): '[reload] (no reason given) caller:', 'Error: reload caller\n    at logReload (http://127.0.0.1:8081/...:99635:65)\n    at anonymous (...)\n    at reload (...:108284:38)\n    at performFullRefresh (...:520:31)\n ...
  ```

  `grep '\[reload\]'` still finds it. A grep for `caller: Error` does not match.
- **Hermes names the caller.** `performFullRefresh` appears by name in the stack (followed by `metroHotUpdateModule` and `injectUpdate`). The "has not been checked on a device" caveat can go.
- **`Running "main" with {...}` marks each JS (re)start reliably.** It appeared once per launch, per HMR full reload, and per dev-menu Reload. `I ReactNativeJS: log level = info` also appeared from a different pid (25002) during the run, which confirms the backlog ticket's warning not to use it.
- **The dev-menu Reload prints no `[reload]` line**, only `Running "main"`, as the doc predicts. Confirmed.
- **`start:frozen`** prints `Metro is running in CI mode, reloads are disabled. Remove CI=true to enable watch mode.` before `Waiting on http://localhost:8081`. The dev client connected through `adb reverse` and the deep link. An edit to `polyfills/event.js`, and reverting it, caused no reload, and `metro:observe` stayed silent. Confirmed.
- **Observer timing.** `metro:observe` printed the modified module at the same moment as the phone's `[reload]` line, within the ~0.65 s the phone clock ran behind the PC. "Just before" holds only after allowing for clock skew. Its paths are as documented (`packages/reference-app-rn/polyfills/event.bundle`). When Metro stops, it prints `Metro closed the HMR socket` and exits 1.
- **Cold Metro and the dev launcher.** After `yarn start --clear`, the first deep-link launch failed after ~10 s with the dev launcher's "There was a problem loading the project. timeout" screen (okhttp `readResponseHeaders`). Fetching the Android bundle once from the PC first (~20 s) fixed the next launch. The Device test runs section should say to warm the bundle, or to expect one retry.
- Writes of `.md` and `.json` files under `tickets/` under `yarn start`: no observer output and no JS log lines. Confirmed.

## Not checked in that run

- `Bundle Splitting – Metro disconnected` after a Metro restart followed by a lazy `import()`.
- Whether attaching the observer changes anything visible on the phone. Nothing was noticed, but nobody looked for it.

The backlog ticket `debt-verify-reload-diagnostics-on-device` can shrink to those two items once the doc is updated.
