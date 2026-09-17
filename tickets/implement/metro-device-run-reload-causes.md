description: A phone connected to the dev server sometimes reloads the app in the middle of a device test. Tests showed that ticket and doc writes are not the cause, so this adds a way to run the dev server with file watching off for test runs, makes the app log why each reload happened, and corrects the testing guide about which writes must pause.
files:
  - packages/reference-app-rn/package.json (new `start:frozen` script)
  - packages/reference-app-rn/polyfills/ (new dev-only reload-reason logger, imported from index.js)
  - packages/reference-app-rn/index.js (polyfill import order)
  - packages/reference-app-rn/scripts/ (new Metro update observer script)
  - packages/reference-app-rn/metro.config.js (optional blockList, see below)
  - docs/reference-app-rn.md (§ Build & Development Workflow → Iterating; new "Device test runs" subsection)
repro: verified
----

# Why a connected phone reloads mid-test, and how to stop it

## Background

The fix ticket (`metro-reloads-the-app-on-any-repo-write`) reported two Fast Refresh reloads during a device session on 2026-09-15. It blamed ticket and doc commits, because Metro (the React Native dev server) watches the whole `sereus` root plus the whole `optimystic`, `quereus` and `Fret` roots (`metro.config.js` `watchFolders`). The first reload came at 23:44:17, 33 seconds after an optimystic commit (`0f963518`, 23:43:44) that changed only two `.md` files under `tickets/`.

## What was measured (2026-09-16)

A probe script started `expo start --dev-client` on port 8093 from `packages/reference-app-rn`, fetched the Android dev bundle (`/packages/reference-app-rn/index.bundle?platform=android&dev=true&lazy=true&...`, 4824 modules; the server root is the monorepo root, so the path includes `packages/reference-app-rn`), opened `ws://…/hot`, and sent `register-entrypoints` with that URL, which is what the phone does. It then wrote files and logged every HMR (hot module replacement) message Metro sent:

| Write | What Metro sent the client |
|---|---|
| `.md` file under `sereus/tickets` or `optimystic/tickets` | nothing |
| `.json` under `sereus/tickets/.logs`, `.db` under `optimystic/tickets/.index`, `.ts` under `sereus/docs`, new `package.json` under `tickets/.logs/…` | an **empty** update: `update-start`, `update` with 0 added / 0 modified / 0 deleted, `update-done` |
| Byte-identical rewrite of one, then all 170, `.js` files in `optimystic/packages/db-core/dist/src` (what a plain `tsc` build does to unchanged output) | empty updates (0 modules) |
| Real content change to `optimystic/packages/db-core/dist/src/index.js`, then restoring it | `update` with modified = 1, each time |
| Any of the above with `CI=1` set on `expo start` | nothing at all. Expo prints "Metro is running in CI mode, reloads are disabled", and the bundle is still served |

Why each result happens, from the installed sources:

- `metro-file-map` ignores `.git`/`.hg` directories and any file whose extension is not in `sourceExts` + `assetExts` + `watcher.additionalExts`. `.md` is in none of them. The extensions that are watched include `json`, `db`, `yaml`, `html` and `env`.
- `DeltaCalculator._getChangedDependencies` only traverses changed files that are already in the bundle's module graph. For any other file it returns an empty delta, and `HmrServer` still sends the empty `update-start`/`update`/`update-done` sequence.
- On an empty update, the React Native client (`react-native/Libraries/Utilities/HMRClient.js`) shows and hides the "Refreshing..." banner, runs `LogBox.clearAllLogs()` and `dismissRedbox()`, and **does not reload**.
- A non-empty update goes through `metro-runtime/src/polyfills/require.js`. If a changed module is not a React Refresh boundary (true of any library module, such as a `dist` file), it calls `performFullRefresh("No root boundary" | "Invalidated boundary" | "Dependency cycle")`, which becomes `DevSettings.reload(reason)`, a full reload. On Android `DevSettingsModule.reloadWithReason` discards the reason, so logcat never shows it.

**Conclusion: ticket files, docs and commits cannot reload the app.** Adding `tickets/` and `docs/` to a Metro blockList would not change device behavior.

## What can reload the app

- **H1: a real content change to a bundled module.** This includes any `src` file the app imports from a sereus workspace package, and any linked `dist` file in optimystic, quereus or Fret that changed. An agent that edits source or builds with real changes during the run causes it. Unchanged rebuilds do not, because Metro filters them out. This is the most likely cause of the 2026-09-15 reloads, but it is unconfirmed: the builds other agents ran that evening left no record with timestamps.
- **H2: "Bundle Splitting – Metro disconnected".** If the HMR websocket ever closes (Wi-Fi drop, `adb reverse` lost, Metro restart), `HMRClient` records `hmrUnavailableReason`. The next lazily loaded bundle, meaning a dynamic `import()` fetched from Metro in a dev build with `lazy=true` (via `@expo/metro-runtime/src/async-require/loadBundle.ts` → `HMRClient.registerBundle`), then calls `DevSettings.reload('Bundle Splitting – Metro disconnected')`. Code that hits its first dynamic `import()` only when a new path runs, such as founding a strand, would reload at exactly that moment. `optimystic/packages/db-p2p/dist/src/libp2p-node-base.js` has one (`await import('p2p-fret')`, on the dispute path), and libp2p dependencies may have more. Not confirmed on a device.

Neither hypothesis can be decided after the fact, because the reason is discarded. The first TODO below is to log it.

## Design

**Frozen dev server for device test runs.** Add `"start:frozen": "CI=1 expo start --dev-client"` to `packages/reference-app-rn/package.json`. Yarn's portable shell accepts the `VAR=value cmd` prefix on Windows too, so there is no need for `cross-env`. With watching off, no write anywhere (source, `dist`, tickets) reaches the phone, so other agents do not need to hold writes during a run. Tradeoff to document: in this mode, a manual reload from the dev menu serves the bundle as it was when Metro started, so a rebuilt dependency needs a Metro restart. Check whether `CI=1` also changes anything the dev client needs (for example, the QR code or the interactive prompt; neither is needed when the app is already installed and pointed at the host).

**Reload-reason logging (dev only).** Add a polyfill, for example `polyfills/reload-reason.js`, imported from `index.js` before `expo-router/entry`. When `__DEV__` is true, it wraps `DevSettings.reload` from `react-native` so that it first logs `console.warn('[reload] ' + reason)` and then calls the original. That covers both paths above, because `setUpReactRefresh.js` calls `DevSettings.reload(reason)` at call time, and `HMRClient` does too. The line appears in logcat as `W ReactNativeJS: [reload] No root boundary` or `[reload] Bundle Splitting – Metro disconnected`, and is forwarded to the Metro terminal when HMR is connected. Confirm that the wrap is in place before `HMRClient.setup` or `setUpReactRefresh` could first run a reload. Both read `DevSettings.reload` when they call it, so a wrap installed during `index.js` evaluation should be enough. Verify this on the device by using the dev menu → Reload, and check whether that route passes through JS at all. It may be native-only, in which case no line appears, and that is acceptable.

**Update observer script.** Add `packages/reference-app-rn/scripts/metro-hmr-observe.mjs`. It attaches to an already-running Metro (the port is an argument, default 8081), registers the same Android bundle URL the phone uses, and prints one timestamped line per non-empty `update` with its module `sourceURL`s. It prints nothing for empty updates. During a device run, this shows exactly which file change reached the phone, which answers H1 directly. Node 22+ has a global `WebSocket`, so no dependency is needed. Registering a second HMR client does not affect the phone's client. The two clients share the same graph, and Metro only sends each one the update notifications. Keep the script's bundle URL query in sync with what `expo start` serves the dev client, and read it from the Metro log line when it is unknown.

**Watch-scope narrowing (optional, low value).** The measurements show it does not stop reloads. It would only reduce empty "Refreshing…" flashes and LogBox clears, which come from watched-extension writes such as `tickets/.logs/*.json` and optimystic's `tickets/.index/index.db`, rewritten after every optimystic commit by its post-commit hook. If you do it, use a `resolver.blockList` with each repo's root path anchored to top-level `tickets`, `docs`, `ops`, `tmp`, `.runs` directories. **Do not** add an unanchored `/tickets/` or `/docs/` pattern: `blockList` also blocks module resolution, so an unanchored pattern would break any `node_modules` package that ships such a folder. Keep `dist` and `node_modules` watched. Skip this if it complicates the config. Record the decision either way in a `NOTE:` next to `watchFolders`.

**Docs.** In `docs/reference-app-rn.md`, correct the guidance. Ticket, doc and commit writes never need to pause. During a device run on the normal `yarn start`, the writes that matter are edits to source the app bundles and builds that change linked `dist` output. `yarn start:frozen` removes even that requirement. Also describe how to read the `[reload]` line and the observer script output.

## Verification

- Headless (already reproduced; re-run after the changes): start `yarn start:frozen`, register an HMR client, change a linked `dist` file's content (restore it afterward), and confirm Metro sends nothing. On normal `yarn start`, confirm one `update` with `modified=1`, and that the observer script prints the file.
- Device (needs the phone; coordinate so nobody else is using it): with the app connected to normal `yarn start`, change a bundled module's content and confirm `W ReactNativeJS: [reload] No root boundary` or a similar line, followed by `Running "main"`. With `yarn start:frozen`, make the same change and confirm no reload. Write a `tickets/*.md` file on either and confirm no reload.

## TODO

- Add `polyfills/reload-reason.js` (dev-only `DevSettings.reload` wrapper logging `[reload] <reason>`) and import it early in `index.js`; add a small Vitest spec if the wrapper can be tested against a stubbed `DevSettings`
- Add `start:frozen` script to `packages/reference-app-rn/package.json`; check `CI=1` side effects on the dev-client flow
- Add `scripts/metro-hmr-observe.mjs` (attach to running Metro, print non-empty updates with source URLs)
- Decide on the optional anchored `blockList`; either implement it or leave a `NOTE:` at `watchFolders` saying why not
- Update `docs/reference-app-rn.md`: Iterating section + new "Device test runs" subsection (what must stay quiet, frozen mode and its stale-reload tradeoff, reading `[reload]` lines, observer script)
- Run `yarn workspace @serfab/reference-app-rn typecheck`, its tests, and `yarn lint`
- Device verification above, if the phone is available; otherwise state in the review handoff that it was deferred
