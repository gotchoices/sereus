description: Updated the phone app's guide for diagnosing unexpected reloads to match what a real device run showed (the exact log line format, the confirmed findings, and a fix for the first launch timing out on a cold dev server), and shrank the follow-up backlog ticket to the two checks still open.
files:
  - docs/reference-app-rn.md (§ Device test runs)
  - tickets/backlog/debt-verify-reload-diagnostics-on-device.md
  - packages/reference-app-rn/scripts/metro-hmr-observe.mjs (header comment only, in review)
----

# § Device test runs brought in line with the 2026-09-16 device run

Documentation-only change to `docs/reference-app-rn.md` § Device test runs, based on `tickets/complete/rn-device-audit-and-reload-run.md`:

- Frozen dev server: names the `Metro is running in CI mode…` line and records the on-device confirmation (connect via `adb reverse` + deep link; edit/revert of `polyfills/event.js` caused no reload and no observer output).
- New "First launch on a cold Metro" paragraph: the ~10 s dev-client timeout after `yarn start --clear`, the ~20 s / 4825-module build, and the warm-up (start `metro:observe` first, or fetch the exact bundle URL the observer prints; don't shorten it, since the query carries transform options).
- "Why it reloaded": the observed two-argument, quoted, comma-joined logcat line; grep advice (`\[reload\]`, not `caller: Error`); `Bundle Splitting` shape marked inferred.
- Reason table and following paragraph: Hermes stack names `performFullRefresh` → `metroHotUpdateModule` → `injectUpdate`; `Running "main"` is the per-JS-start marker; dev-menu Reload prints no `[reload]`; don't use `log level = info` as a marker.
- Observer: `tickets/` `.md`/`.json` writes are silent; `Metro closed the HMR socket` + exit code 1 on Metro stop; observer block and `[reload]` line coincide once the phone/PC clock offset is allowed for.
- Backlog `debt-verify-reload-diagnostics-on-device` reduced to the two unchecked items (`Bundle Splitting` line shape; visible effect of attaching the observer).

The implement stage deliberately did not use a shortened `index.bundle?platform=android&dev=true` warm-up URL, because Expo's manifest URL carries transform options that make a different build.

## Review findings

Checked: the implement diff (`4f941d8`) line by line against the archived device run's evidence table and notes, the fix-stage plan (`21cd1be`), `scripts/metro-hmr-observe.mjs`, `polyfills/reload-reason.js`, and other references to these tools (`docs/testing.md`, `index.js`, `metro.config.js`).

- **Accuracy of new claims:** every timing, line shape and confirmation traces to the device run (2a–2d, setup notes) or to script source. The clock arithmetic is consistent (phone 47.715 + ~0.65 s ≈ PC 48.37, about 80 ms after the observer's 48.281, so "same moment" is fair). The `log level = info` note comes from the prior backlog ticket's text, as the handoff says.
- **Warm-up advice ("start `metro:observe` first") not directly observed:** the build-on-attach path follows from the script's `GraphNotFoundError` → `buildGraph` code, and the device run showed the observer receiving the phone's updates under `yarn start`, so the manifest URL it builds matches the dev client's graph. Accepted as written; no ticket.
- **Minor, fixed:** the header comment of `scripts/metro-hmr-observe.mjs` said a printed block comes "just before a reload", contradicting the doc's new "same moment" wording. Changed to "at the same moment as a reload". Comment-only; the file is in ESLint's ignore list, so lint does not cover it.
- **Other docs:** `docs/testing.md`, `index.js` and `metro.config.js` mention these tools but make no claim the device run contradicts. No stale "not yet confirmed" wording remains (grep).
- **Hard wraps / formatting:** new paragraphs are single lines; the table was not changed structurally.
- **Tests / lint:** no runtime code changed; nothing to run beyond the comment edit. No test covers doc text.
- **Major findings / new tickets:** none. The two open checks are already tracked in `debt-verify-reload-diagnostics-on-device`.
- **Tripwires:** none new. The run's unexplained "Fast refresh OFF yet HMR full reloads" observation stays only in the archived run ticket; it has no effect on diagnosis and was not investigated.
