description: Update the phone app's guide for diagnosing unexpected reloads so it matches what a real device run showed: the exact log line format, the confirmed findings, and a tip about the first launch timing out on a cold dev server. Then shrink the follow-up backlog ticket to the two checks that are still open.
files:
  - docs/reference-app-rn.md (§ Device test runs, lines ~688–741 at time of writing)
  - tickets/backlog/debt-verify-reload-diagnostics-on-device.md
  - packages/reference-app-rn/polyfills/reload-reason.js (read only; source of the log line)
  - packages/reference-app-rn/scripts/metro-hmr-observe.mjs (read only; prints `Metro closed the HMR socket`, exit code 1)
repro: verified
----

# Bring § Device test runs in line with the 2026-09-16 device run

The device run (archived in `tickets/complete/rn-device-audit-and-reload-run.md`) confirmed the reload diagnostics behave as documented. What is wrong is the doc's wording and a few missing details. Documentation-only change; no code changes.

Decision: fix the doc to match the device, not the code to match the doc. `polyfills/reload-reason.js` calls `console.warn('[reload] (no reason given) caller:', stack)` with two arguments, and React Native's logcat output quotes each argument and joins them with `, ` on one line with `\n` escaped (the same shape the doc already shows for the `sereus:cadre:timing` `%s` line further down). Folding it into one string was considered, but how logcat renders an embedded multi-line string has not been measured on a device, and the one-line form is easy to grep. Leave the code alone.

## Edits to `docs/reference-app-rn.md` § Device test runs

**"Why it reloaded" code block.** Replace the three-line example with the observed shape (keep the doc's existing `W ReactNativeJS:` prefix convention, not the `W/ReactNativeJS(pid)` of `adb logcat` brief format):

```
W ReactNativeJS: [reload] Bundle Splitting – Metro disconnected
W ReactNativeJS: '[reload] (no reason given) caller:', 'Error: reload caller\n    at logReload (http://127.0.0.1:8081/...)\n    at anonymous (...)\n    at reload (...)\n    at performFullRefresh (...)\n    at metroHotUpdateModule (...)\n    at injectUpdate (...)\n ...'
```

Add a sentence: the no-reason line is one logcat line with the stack's newlines escaped, so search with `grep '\[reload\]'`; a search for `caller: Error` does not match. Note that the `Bundle Splitting` form (single argument) was not reproduced on the device, so its exact shape is still inferred.

**Reason table, `performFullRefresh` row.** Add that Hermes names the caller: the stack shows `performFullRefresh` followed by `metroHotUpdateModule` and `injectUpdate`.

**Paragraph after the table.** Remove "These readings come from React Native 0.79 and Expo SDK sources and have not yet been confirmed on a device." Replace with what was confirmed: `Running "main" with {...}` appears once per launch, per Fast Refresh full reload, and per dev-menu Reload, so it is the marker for every JavaScript (re)start; the dev-menu Reload prints no `[reload]` line. Add: do not use `I ReactNativeJS: log level = info` as a marker — it also appears from a different process (seen with a different pid during the run; also every ~15 minutes, probably the background task). State that the `Bundle Splitting` path has not been checked on a device.

**Frozen dev server bullets.** The `Waiting on http://localhost:8081` line is preceded by `Metro is running in CI mode, reloads are disabled. Remove CI=true to enable watch mode.` Confirmed on device: the dev client connects through `adb reverse tcp:8081 tcp:8081` plus the deep link, and a change to a module outside components (`polyfills/event.js`) and its revert caused no reload, with `metro:observe` silent.

**Observer paragraph.** "Just before" is not what was observed: the observer's line and the phone's `[reload]` line had the same timestamp once the phone clock's offset from the PC (~0.65 s behind in that run) is allowed for. Say they appear at the same moment, and that comparing timestamps needs the clock offset taken into account. Add: when Metro stops, the observer prints `Metro closed the HMR socket` and exits with code 1. Confirmed: writes to `.md` and `.json` files under `tickets/` produced no observer output and no JS log lines under `yarn start`. Keep "Attaching does not change what the phone receives" but do not claim it has no visible effect on the phone — that was not looked for.

**Cold Metro tip** (new short paragraph, near the start of the Device test runs section or the frozen dev server part — it applies to both `yarn start` and `start:frozen`). After `yarn start --clear` (a cold Metro cache), the first dev-client launch from the deep link failed after ~10 s with "There was a problem loading the project. timeout" (okhttp `readResponseHeaders`), because building the Android bundle took ~20 s. Warm the bundle first by fetching it once from the PC (for example `curl -s -o /dev/null "http://localhost:8081/index.bundle?platform=android&dev=true"` — check the exact entry path against Metro's manifest or the `metro:observe` script, which already builds the bundle when no client has), or expect one retry. Simplest documented option to check: starting `metro:observe` before launching the app already builds the bundle when no client has (see the header comment in `scripts/metro-hmr-observe.mjs`), so it doubles as the warm-up on `yarn start`; under `start:frozen` a manual fetch is still needed if the observer cannot attach.

## Backlog ticket shrink

Rewrite `tickets/backlog/debt-verify-reload-diagnostics-on-device.md` so it lists only the two unchecked items:

- Stop and restart Metro, then reach a lazily bundled module (a dynamic `import()` such as optimystic's `import('p2p-fret')`); confirm logcat shows `[reload] Bundle Splitting – Metro disconnected` and record its exact line shape in the doc.
- Watch the phone while attaching `metro:observe` to a running app and confirm nothing visible happens.

Update its `description:` (plain language, two items remain) and keep `tradeoffs:`. Reference the device run in `complete/rn-device-audit-and-reload-run` in the body.

## TODO

- Edit the "Why it reloaded" code block and add the grep note.
- Update the `performFullRefresh` table row.
- Replace the "not yet confirmed on a device" sentence with the confirmed findings and the `log level = info` warning; note `Bundle Splitting` remains unchecked.
- Add the CI-mode line and on-device confirmation to the frozen dev server part.
- Fix the observer timing wording; add `Metro closed the HMR socket` / exit 1; confirm `tickets/` writes are silent; keep the no-visible-effect claim out.
- Add the cold-Metro warm-up tip, verifying the bundle URL against `scripts/metro-hmr-observe.mjs` before writing it.
- Shrink `tickets/backlog/debt-verify-reload-diagnostics-on-device.md` to the two open checks.
- Check the prose has no hard wraps (`yarn unwrap:md docs/reference-app-rn.md` if needed) and `yarn lint` is unaffected.
