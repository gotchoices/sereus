description: Adds tools to find and prevent unexpected app reloads during phone test runs: a dev-server mode that ignores file changes, a log line saying why each reload happened, and a script that shows which changed file reached the phone. It also documents which writes actually cause reloads (ticket and doc writes never do).
files:
  - packages/reference-app-rn/polyfills/reload-reason.js
  - packages/reference-app-rn/index.js
  - packages/reference-app-rn/test/polyfills/reload-reason.spec.ts
  - packages/reference-app-rn/scripts/metro-hmr-observe.mjs
  - packages/reference-app-rn/package.json
  - packages/reference-app-rn/metro.config.js
  - packages/reference-app-rn/vitest.config.ts
  - docs/reference-app-rn.md
  - docs/testing.md
----

# Why a connected phone reloads mid-test: tools and guidance

## Summary

A device session on 2026-09-15 had two mid-scenario reloads that were blamed on ticket commits. Headless measurement showed that writes outside the app's module graph never reload the app. That leaves two explanations: (H1) bundled source or linked `dist` output changed during the run, or (H2) the connection to Metro dropped and a later lazy `import()` reloaded the app. This ticket adds the tools to tell them apart next time. It does not diagnose the 2026-09-15 reloads.

- `polyfills/reload-reason.js`: in development builds, wraps `DevSettings.reload` so a `[reload] …` warning goes to logcat before any reload started from JavaScript. When the caller gives no reason, the warning also includes the caller's stack.
- `yarn workspace @serfab/reference-app-rn start:frozen`: runs `CI=1 expo start --dev-client`, so Metro does not watch files and no write reaches the phone.
- `yarn workspace @serfab/reference-app-rn metro:observe`: attaches to Metro's HMR (hot module replacement) socket for the phone's bundle and prints each update that adds, modifies or deletes modules.
- Watch-scope blockList declined, with an accepted-tradeoff `NOTE:` at `watchFolders` in `metro.config.js`.
- Docs: `docs/reference-app-rn.md` § Device test runs; `docs/testing.md` polyfills project.

## Review findings

**Major, fixed in this pass: the reload reason the docs promised is never logged in this app.** The implementation and docs said a changed module that Fast Refresh can't apply would log `[reload] No root boundary` (or `Invalidated boundary` / `Dependency cycle`). Reading the installed sources shows otherwise:

- Metro's `performFullRefresh` in `metro-runtime/src/polyfills/require.js` calls `window.location.reload()` whenever it exists, with no reason. It only falls back to React Native's `setUpReactRefresh` (which does pass the reason) when `window.location` is missing.
- `@expo/metro-runtime` runs before the main module (Expo's `getModulesRunBeforeMainModule`, and `expo-router/entry-classic` imports it too). In development on native, its `location/install.native.ts` installs `window.location`, because `app.json` `extra.router` doesn't set `origin: false`.
- The `reload` that `Location.native.ts` installs calls `DevSettings.reload()` with no argument.

So this case would have logged `[reload] (no reason given)`, and the docs' reason table would have misled whoever debugs the next reload. `Location.reload` is defined as a non-writable property, so it can't be wrapped instead.

Fix: when no reason is given, the wrapper now also logs `new Error().stack`, which names the caller (`performFullRefresh`). The doc's reason table, the polyfill header, the observer script header and the spec were rewritten to match. The spec gained a case that checks the caller's function name is in the logged stack, and a case that checks no stack is added when a reason is given. The `Bundle Splitting – Metro disconnected` path (H2) is unaffected: `loadBundle.ts` → `HMRClient.native.ts` re-exports React Native's `HMRClient`, which passes that reason directly. The doc now also mentions React Native's own `Disconnected from Metro` warning, which comes earlier. Whether Hermes stack frames show `performFullRefresh` by name has not been checked on a device (the doc says so).

**Checked, no change needed:**

- `DevSettings` wrap coverage: `DevSettings.js` exports one mutable object. `HMRClient.js`, `setUpReactRefresh.js`, the `react-native` index getter and Expo's `Location.native.ts` all look up `reload` on that object when they call it, so a wrap installed while `index.js` evaluates covers them.
- `@expo/metro-runtime`'s `messageSocket.native.ts` handles only `rsc-reload`, so the Metro terminal's `r` stays a native reload, which the docs already say prints nothing.
- Observer script: error handling (a failed manifest request, a missing `launchAsset.url`, GraphNotFound rebuilt only once, a rejected rebuild closes the socket with exit code 1), cleanup (the process exits when the socket closes), and path parsing that keeps sibling repos' `../`. The functions are small and single-purpose.
- `start:frozen` on Windows: the repo uses Yarn 4.12 (`packageManager`), whose own shell runs the `CI=1 cmd` prefix. The implementer ran it headless on Windows.
- The accepted-tradeoff `NOTE:` at `watchFolders` states what was declined, why, and when to revisit. Nothing has changed since, so it was left alone.
- Docs: `docs/reference-app-rn.md` (Iterating, Device test runs) and `docs/testing.md` match the code after the fix above. The `vitest.config.ts` comment is accurate.
- Type safety: the polyfill is plain JS like its sibling polyfills. The spec is typed with no `any`.

**Validation:** `yarn workspace @serfab/reference-app-rn typecheck`: exit 0. `yarn workspace @serfab/reference-app-rn test`: 20 files / 307 tests pass. `yarn lint`: exit 0. `npx eslint --no-ignore` on the observer script and the polyfill: clean (`scripts/**` is globally ignored, tracked by backlog `debt-tooling-scripts-unlinted-and-unchecked`).

**Tripwires:** none new. The existing one about the blockList stays at `watchFolders` in `metro.config.js`.

**Still open, filed:** none of this has been verified on a device. That includes the corrected reason reading, frozen mode with the dev client, which logcat line reliably marks a reload, and whether attaching the observer has any effect on the phone. Filed as backlog `debt-verify-reload-diagnostics-on-device`. H1 vs H2 for the 2026-09-15 reloads stays undiagnosed until a reload happens again with these tools running.
