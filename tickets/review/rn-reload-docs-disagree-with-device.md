description: Updated the phone app's guide for diagnosing unexpected reloads to match what a real device run showed (the exact log line format, the confirmed findings, and a fix for the first launch timing out on a cold dev server), and shrank the follow-up backlog ticket to the two checks still open.
files:
  - docs/reference-app-rn.md (§ Device test runs)
  - tickets/backlog/debt-verify-reload-diagnostics-on-device.md
  - tickets/complete/rn-device-audit-and-reload-run.md (source of the facts; read only)
  - packages/reference-app-rn/scripts/metro-hmr-observe.mjs (read only)
  - packages/reference-app-rn/polyfills/reload-reason.js (read only)
----

# Review: § Device test runs brought in line with the 2026-09-16 device run

Documentation-only. No code changed. Every new claim should trace to `tickets/complete/rn-device-audit-and-reload-run.md`, to the implement ticket's own notes (which carried the `log level = info` finding), or to the source of `metro-hmr-observe.mjs` / Expo CLI.

## What changed in `docs/reference-app-rn.md`

- **Frozen dev server bullets:** the `Waiting on` bullet now names the preceding `Metro is running in CI mode, reloads are disabled. Remove CI=true to enable watch mode.` line. A new paragraph after the bullets records the device confirmation: `adb reverse` plus the deep link connected, and an edit/revert of `polyfills/event.js` caused no reload, no JS log lines, no observer output.
- **New "First launch on a cold Metro" paragraph** (after the frozen part, before "Why it reloaded"; says it applies to both modes): the ~10 s "timeout" failure after `yarn start --clear`, the ~20 s / 4825-module build, and the warm-up: start `metro:observe` first (it builds the bundle when no client has), or fetch by hand the URL the observer prints on its first line.
- **"Why it reloaded" code block:** replaced with the observed two-argument, quoted, comma-joined, `\n`-escaped line. New paragraph: search with `grep '\[reload\]'`, not `caller: Error`; the single-argument `Bundle Splitting` shape is inferred.
- **Table, `performFullRefresh` row:** Hermes names `performFullRefresh`, then `metroHotUpdateModule` and `injectUpdate`.
- **Paragraph after the table:** removed "not yet confirmed on a device". Now: `Running "main" with {...}` logs once per JS start (launch, Fast Refresh full reload, dev-menu Reload); dev-menu Reload printed no `[reload]` line; don't use `I ReactNativeJS: log level = info` as a marker (other pid, ~every 15 min); `Bundle Splitting` still unchecked.
- **Observer paragraphs:** `.md`/`.json` writes under `tickets/` were silent on a device; "attaching does not change what the phone receives" kept, with an explicit note that a visible effect on the phone was not checked; `Metro closed the HMR socket` + exit code 1 on Metro stop. New paragraph replacing "just before": the observer block and the `[reload]` line appear at the same moment once the ~0.65 s phone-clock offset is allowed for (22:37:48.281 PC vs 22:37:47.715 phone), with `Running "main"` ~8 s later.

## Deviation from the ticket

The implement ticket suggested a curl warm-up of `http://localhost:8081/index.bundle?platform=android&dev=true`. Not used. `metro-hmr-observe.mjs` reads the bundle URL from Expo's manifest (`launchAsset.url`), and Expo CLI's `createBundleUrlSearchParams` (`packages/reference-app-rn/node_modules/@expo/cli/build/src/start/server/middleware/metroOptions.js`) adds `hot=false`, `lazy`, `transform.engine=hermes`, `transform.bytecode`, `transform.routerRoot`, `unstable_transformProfile=hermes-stable` and others. A shortened URL requests a differently-transformed build, so the doc points at the observer's printed `bundle <url>` line instead. This is a reading of source, not measured: nobody has timed whether the shortened URL would partly warm Metro's cache.

## Known gaps for the reviewer

- Metro was not run for this ticket (port 8081 had a stray connection attempt from another process; starting Expo here risked colliding with a device session). So the warm-up advice "start `metro:observe` first" is inferred from the script's `GraphNotFoundError` → `buildGraph` path, not observed. The device run fixed the timeout with a manual bundle fetch, not with the observer. Under `start:frozen` the device run did have the observer running (it reported "no observer output"), which suggests it attaches there, but its build-on-attach path was not exercised under either mode.
- "`Running "main"` once per JS start" and the dev-menu Reload confirmation come from the archived run's evidence table (2a, 2d). The `log level = info` other-pid observation is only in the implement ticket's text, not in the archived run's body; kept as written there.
- The header comment in `scripts/metro-hmr-observe.mjs` still says a printed block comes "just before a reload". Left unchanged (ticket was docs-only, and the full restart does follow ~8 s later, so it is not wrong).
- `yarn lint` not run: ESLint's flat config covers only JS/TS sources, and only two Markdown files changed. No `unwrap:md` script exists at the repo root; the edits contain no hard-wrapped paragraphs.

## Backlog ticket

`tickets/backlog/debt-verify-reload-diagnostics-on-device.md` now lists only the `Bundle Splitting` check (record the exact line shape) and the watch-the-phone-while-attaching check, references the archived run, and keeps `tradeoffs:` (dropped "about half an hour" as no longer measured for the smaller scope). `files:` dropped `package.json`.

## Validation

- Read § Device test runs top to bottom for consistency with the "What reaches the phone" table (the `.md` row says nothing is sent; the new `tickets/` confirmation agrees).
- `grep -n "not yet been confirmed" docs/reference-app-rn.md` → no match.
- `grep -n "caller: Error" docs/reference-app-rn.md` → only the "does not match" advice.
