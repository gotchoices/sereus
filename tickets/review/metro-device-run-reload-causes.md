description: Adds tools to find and prevent unexpected app reloads during phone test runs: a dev-server mode that ignores file changes, a log line saying why each reload happened, and a script that shows which changed file reached the phone. It also documents which writes actually cause reloads (ticket and doc writes never do).
files:
  - packages/reference-app-rn/polyfills/reload-reason.js (new; dev-only `DevSettings.reload` wrapper)
  - packages/reference-app-rn/index.js (imports it after polyfills/audit, before expo-router/entry)
  - packages/reference-app-rn/test/polyfills/reload-reason.spec.ts (new; `polyfills` Vitest project)
  - packages/reference-app-rn/scripts/metro-hmr-observe.mjs (new; `yarn metro:observe`)
  - packages/reference-app-rn/package.json (`start:frozen`, `metro:observe` scripts)
  - packages/reference-app-rn/metro.config.js (accepted-tradeoff NOTE at `watchFolders`; no blockList)
  - packages/reference-app-rn/vitest.config.ts (polyfills project comment)
  - docs/reference-app-rn.md (§ Build & Development Workflow → Iterating, new § Device test runs)
  - docs/testing.md (polyfills project now holds three specs)
----

# Why a connected phone reloads mid-test: tools and guidance

## Background

A device session on 2026-09-15 had two mid-scenario reloads that were blamed on ticket commits. Headless measurement on 2026-09-16 (in the implement ticket, summarized in the new doc section) showed that writes outside the app's module graph never reload the app. `.md` files send nothing, other watched files send an empty update, and only a real content change to a bundled module reloads it. The two remaining hypotheses are (H1) someone changed bundled source or `dist` output during the run, and (H2) the HMR (hot module replacement) connection dropped and a later lazy `import()` reloaded the app. The Android native side discards the reload reason, so neither could be checked afterwards. This ticket adds the tools to tell them apart next time. It does not diagnose the 2026-09-15 reloads.

## What was built

- **`polyfills/reload-reason.js`**: when `__DEV__` is set, wraps `DevSettings.reload` on the shared React Native object so that it calls `console.warn('[reload] <reason>')` first (logcat: `W ReactNativeJS: [reload] No root boundary`). React Native's callers (`setUpReactRefresh.js` `performFullRefresh`, `HMRClient.js` `registerBundleEntryPoints`) look the method up at call time on that same object (checked in the installed RN 0.79.6 sources), so installing it while `index.js` evaluates covers them. Reloads started natively (dev menu Reload, `r` in the Metro terminal) print nothing. That conclusion comes from reading the code and was not checked on a device.
- **`yarn workspace @serfab/reference-app-rn start:frozen`**: `CI=1 expo start --dev-client`. Side effects of `CI=1`, read from `@expo/cli` sources: watch disabled; no interactive terminal (no QR code, no `r`/`m`/`j` keys); the session is not registered with Expo's servers, so a signed-in dev client does not suggest the project; if the port is busy it does not prompt for another port (pass `--port`).
- **`yarn workspace @serfab/reference-app-rn metro:observe [--port n] [--host h] [--platform android] [--bundle-url u]`**: gets the bundle URL from Expo's manifest (`GET /` with `expo-platform: android`), so no query string is hard-coded. It opens `ws://…/hot`, sends `register-entrypoints`, and prints only updates that add, modify or delete modules, with logcat-style local timestamps and each module's path. If the server returns `GraphNotFoundError` (no client has built that bundle yet), it fetches the bundle once and registers again. It never fetches a bundle whose graph already exists, because a concurrent bundle request can consume a pending change before the HMR server delivers it to the phone (reasoning in the script header).
- **Watch-scope blockList: declined.** An accepted-tradeoff `NOTE:` at `watchFolders` records the measurement, the risk that an unanchored pattern would break module resolution, and when to revisit (a red box cleared by an empty update hides a failure mid-run).
- **Docs**: new § Device test runs. It has a table of which writes reach the phone, the H2 disconnect case, frozen mode and its differences from normal mode, how to read `[reload]` reasons, and how to use the observer and read its output.

## Validation done

- `yarn workspace @serfab/reference-app-rn typecheck`: clean.
- `yarn workspace @serfab/reference-app-rn test`: 20 files / 306 tests pass. `@serfab/cadre-core` had to be rebuilt first because its `dist` was stale from edits that are not mine.
- `yarn lint`: exit 0. `scripts/**` is in ESLint's global ignores (existing policy; backlog `debt-tooling-scripts-unlinted-and-unchecked`), so the observer script was linted separately with `npx eslint --no-ignore`: clean. `knip` does not flag the new files.
- `reload-reason.spec.ts`: logs then reloads, in that order, with the reason and `this` passed through; logs `(no reason given)` when no reason is passed; leaves `reload` untouched when `__DEV__` is false. The first version passed the release-build case trivially, because Vitest caches a `vi.mock` factory result across `vi.resetModules`. The spec now keeps one fake object and swaps its `reload` in each case (commented in the spec).
- **Headless, normal `yarn start --port 8093`**, with the observer attached through its GraphNotFound → build → re-register path: writing `tmp/metro-hmr-probe.json` (watched, not in the bundle) printed nothing. Appending a line to `src/connection-status.ts` printed `update: 1 modified … modified packages/reference-app-rn/src/connection-status.bundle`, and restoring the file printed another update.
- **Headless, `yarn start:frozen --port 8094`**: Metro printed "Metro is running in CI mode, reloads are disabled", the bundle was served, the observer attached, and the same edit and restore printed nothing in 12 s each.
- **Stale reload under frozen mode**: on `--port 8095`, adding an exported string marker to `src/connection-status.ts` and fetching the bundle again returned a bundle without the marker. This confirms the doc's claim that a reload serves the code Metro read at startup.
- Sibling-repo path formatting (`../optimystic/…` after normalizing Windows backslashes) was checked by running `url.format` + `jsc-safe-url` exactly as Metro's serializer calls them. No real optimystic file was edited.

## Known gaps: reviewer, start here

- **No device verification.** A phone (`26e2d245db217ece`, development build) was attached, but the app had been in the foreground for about 21 hours with no Metro or `adb reverse` attached. That may be someone's long-running observation, and relaunching the app against a fresh Metro would have ended it. Still to do with the phone: (1) on `yarn start`, change a module imported outside components (for example `polyfills/event.js` or a linked `dist` file) and confirm that `W ReactNativeJS: [reload] No root boundary` (or similar) appears, followed by `Running "main"`, and that `metro:observe` names the file; (2) on `start:frozen`, make the same change and confirm no reload; (3) write a `tickets/*.md` on either and confirm no reload; (4) check whether dev menu → Reload prints a `[reload]` line (expected: no).
- **Metro terminal forwarding of the `[reload]` line is not claimed in the docs.** RN 0.79 forwards console output to Metro only when `console._isPolyfilled` (`setUpDeveloperTools.js`), which was not checked on Hermes. The docs point only at logcat.
- **`Running "main"` as the reload marker** comes from the fix ticket and was not re-verified. While inspecting the phone, logcat showed `I ReactNativeJS: log level = info` every 15 minutes from a new PID each time (20:35, 20:50, 21:05, 21:20), while the foreground app process kept running. So `log level = info`, which the fix ticket used to spot a reload, also appears when some other JS runtime starts (probably the background task). Whoever runs the device check should confirm which line reliably marks a real reload.
- **Attaching the observer sends the phone's HMR group one `isInitialUpdate` message.** From reading `metro/src/HmrServer.js` `_registerEntryPoint`: it is empty unless a change was already being processed, and in that case it carries the change the phone was about to receive. React Native's `HMRClient` skips the "Refreshing..." banner for initial updates, but `metro-runtime` still applies the modules. Not device-verified.
- **`CI=1` with the dev client** was not tried on the phone. The side effects above come from reading the Expo CLI source.
- **H1 vs H2 for the 2026-09-15 reloads stays open.** This ticket provides the instruments, not the diagnosis.
