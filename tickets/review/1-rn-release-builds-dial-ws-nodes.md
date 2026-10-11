description: Android release builds of Sereus phone apps could not connect to any node over plain WebSocket addresses, because Android blocks unencrypted traffic unless the app opts in. The React Native kit now ships an Expo config plugin that opts in with one line in the app's config, and the docs say why that is safe.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/app.plugin.cjs (new), packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/app.json, docs/reference-app-rn.md, .release-notes.pending.md
----
# React Native release builds can dial `/ws` nodes: review handoff

Reported as gotchoices/sereus#38. Android (API 28 and later) refuses non-TLS connections unless the app sets `android:usesCleartextTraffic="true"`, and it counts `ws://` as cleartext. React Native's template sets it in the debug manifest only, so release builds could dial no `/ws` address. The reply drafted in `tickets/blocked/report-issue-replies-2026-10-11.md` (#38 section) promises this exact shape; it still matches.

## What changed

- **`packages/cadre-rn/app.plugin.cjs`** (new, CommonJS): `withCadre(config)` → `withAndroidCleartextWebSocket`, which uses `withAndroidManifest` to set `android:usesCleartextTraffic="true"` on the main `<application>`. It imports nothing from Expo at load time. `appConfigPlugins(config)` resolves `expo/config-plugins` with `createRequire(<_internal.projectRoot>/package.json)`, and throws a named error when `_internal.projectRoot` is missing. Its header comment says why the opt-in is safe and links the docs section. The Expo helper types it uses are local JSDoc typedefs.
- **`packages/cadre-rn/package.json`**: `exports["./app.plugin.js"] = "./app.plugin.cjs"` (Expo resolves `<pkg>/app.plugin.js` through Node's resolver, which honours `exports`), and `app.plugin.cjs` in `files`.
- **`packages/reference-app-rn/app.json`**: `"@serfab/cadre-rn"` appended to `plugins`.
- **`docs/reference-app-rn.md`**: new `### Release builds: cleartext WebSocket` under Transport & Connectivity: the cause, the plugin, why it is safe (Noise against the peer id; no certificate authority; the claim proof is an HMAC inside Noise, `claim-proof.ts`), the `networkSecurityConfig` caveat, and iOS recorded as unverified with the check that settles it. The Key Dependencies row for `@serfab/cadre-rn` names the plugin.
- **`packages/cadre-rn/README.md`**: an imports-table row, and `## Config plugin (Expo)` (after the `/metro` section): the `app.json` line, what it sets, a one-sentence safety reason with a link, the override, plugin order and `networkSecurityConfig` notes, iOS unchanged, and the hand-edit for bare React Native.
- **`.release-notes.pending.md`**: a `@serfab/cadre-rn` entry.

## Deviation from the ticket: plugin order

The ticket said "the last plugin in `app.json` order wins". Expo's source and a test both say the opposite. In `@expo/config-plugins` 10.1.2 `withBaseMod`, each newly registered mod runs first and then calls the one registered before it, so the plugin listed **first** applies its change last and wins. A scratch script (`compileModsAsync` in introspect mode against the reference app, no files written) gave: `[setsFalse, cadre]` → `false`, `[cadre, setsFalse]` → `true`. The README states first-listed wins. Consequence for the reference app: the plugin is appended last, so any earlier plugin that set `false` would beat it. None of the current plugins set the attribute.

## Verification done

- `npx expo config --type introspect --json` from `packages/reference-app-rn`: the Android manifest mod result's `<application>` has `"android:usesCleartextTraffic": "true"`. Introspect read the developer's local `android/app/src/main/AndroidManifest.xml`, whose `<application>` lacks the attribute, so the value comes from the plugin. Expo resolved the plugin through the bare `"@serfab/cadre-rn"` reference, which exercises the `exports` entry.
- Scratch script: `withCadre({ name: 'x' })` with no `_internal` throws `@serfab/cadre-rn config plugin: Expo did not pass the project root (config._internal.projectRoot), so expo/config-plugins cannot be resolved from the app`.
- `yarn pack --dry-run` in `packages/cadre-rn` lists `app.plugin.cjs`.
- `yarn lint`: exit 0. `tsc --checkJs --strict` over `app.plugin.cjs`: no errors (the file is `@ts-check` but in no tsconfig, like `metro/index.cjs`).
- `yarn check:dep-ranges`: pass. knip reports nothing about `expo` or `app.plugin.cjs`, so `knip.ts` is unchanged.
- **`yarn dep-check` exits 1, and the cause is pre-existing and not this ticket's:** knip reports `@multiformats/multiaddr` unused in `packages/cadre-host/package.json`. Commit `e08a7c74` (claim-code-phone-addresses) removed its last importer. Recorded in `tickets/.pre-existing-error.md`.

## Not done / for the reviewer

- **No device run and no prebuild.** Nobody has yet built a release APK and dialed a `/ws` node with it. A human check is `expo prebuild --platform android --no-install` (it overwrites the local generated `android/`) and then a release build that claims a cadre-cli node over `/ws`. The agent did not run prebuild, because `android/` is a developer's local generated project.
- **iOS** is unchanged and recorded as unverified in the docs. The introspect output shows `NSAllowsArbitraryLoads: true`, but that comes from `@expo/config-plugins`' built-in fallback Info.plist (`withIosBaseMods.js` `getInfoPlistTemplate`, "TODO: Fetch the versioned template file"), used because there is no `ios/` directory. It is not evidence of what a real prebuild produces.
- **No tests added**, because the plugin is configuration and introspection verified it. The ordering and missing-root checks were one-off scratch runs and are not in the repo.
- The plugin sets `true` unconditionally, overriding an app's deliberate `false`. The README documents this as the intended behaviour.
