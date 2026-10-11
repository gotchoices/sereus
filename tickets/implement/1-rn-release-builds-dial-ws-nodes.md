description: Android release builds of Sereus phone apps cannot connect to any node over plain WebSocket addresses, because Android blocks unencrypted traffic unless the app opts in; debug builds work. Ship the opt-in with the React Native kit so every app gets it with one config line, and document why it is safe.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/app.plugin.cjs (new), packages/cadre-rn/package.json (exports, files), packages/cadre-rn/README.md, packages/reference-app-rn/app.json (plugins), docs/reference-app-rn.md (Transport & Connectivity), knip.ts (only if knip flags `expo`), .release-notes.pending.md
----
# React Native release builds can dial `/ws` nodes

Reported as gotchoices/sereus#38: the health app's signed release APK on a Galaxy S21 could not claim a cadre-cli 1.14 node; every `/ws` address was unreachable on Wi-Fi and cellular. Allowing cleartext in the release manifest fixed it at once. The reply already drafted in `tickets/blocked/report-issue-replies-2026-10-11.md` promises exactly this shape, so keep to it.

## Cause

Since API 28 Android refuses non-TLS connections unless the app opts in, and it classifies `ws://` as cleartext by scheme. React Native templates opt in for debug only (`android/app/src/debug/AndroidManifest.xml`, `usesCleartextTraffic="true"`). `reference-app-rn`'s `android/` directory is prebuild output (gitignored) and follows that template, so every app built from it hits this on its first release build.

## Why opting in is safe

Every libp2p connection is encrypted and authenticated by the Noise handshake against the peer id in the address. TLS underneath would add a certificate-authority dependency and no security; avoiding certificate authorities is a design goal. A claim's secret never crosses the wire either: `claimNode` sends an HMAC proof inside the Noise channel.

## Design

### How Expo finds the plugin (verified in `@expo/config-plugins` 10.1.2, Expo SDK 53)

`utils/plugin-resolver.js` → `resolvePluginForModule`: for a bare package reference like `"@serfab/cadre-rn"` it calls `resolve-from(projectRoot, '@serfab/cadre-rn/app.plugin.js')` and loads the result with plain `require()`. Two consequences for this package:

- **The subpath must be in `exports`.** `resolve-from` uses Node's resolver, which honours the `exports` map; the kit has no `main` and no `"."` export, so without an `"./app.plugin.js"` entry resolution fails with `PLUGIN_NOT_FOUND`.
- **The file must be CommonJS.** The kit is `"type": "module"`, so a `.js` file at its root is ESM, and `require()` of ESM only works on recent Node releases. Map the export to a `.cjs` file: `"./app.plugin.js": "./app.plugin.cjs"`. This is the same pattern as `"./metro": "./metro/index.cjs"`. `resolveConfigPluginExport` takes `module.exports` (or `.default`) and requires a function.

### The plugin imports nothing from Expo at load time

`require('expo/config-plugins')` from the kit's own file does not resolve in this monorepo: `expo` lives only in `packages/reference-app-rn/node_modules`, and Node resolves the kit through its real path `packages/cadre-rn/`, whose ancestors' `node_modules` hold no `expo` (checked: neither `packages/cadre-rn/node_modules` nor the root has `expo` or `@expo/*`). It would also fail under any strict installer that does not hoist `expo`.

So, following `metro/index.cjs` ("imports nothing from metro, expo… the app passes in the config its own toolchain produced"), the plugin resolves Expo's helpers from the **app**: inside the plugin function, `createRequire(path.join(config._internal.projectRoot, 'package.json'))('expo/config-plugins')`. `@expo/config` sets `_internal.projectRoot` before it applies static plugins (`build/Config.js`, "Apply static json plugins, should be done after _internal"). If `_internal?.projectRoot` is missing, throw an error naming the cause rather than guessing a directory. The kit declares no `expo` or `@expo/config-plugins` dependency, peer or otherwise: any app that can run a config plugin already has `expo`, the same way `/metro` relies on the app's toolchain.

Rejected: adding `@expo/config-plugins` (or `expo`) as an optional peer and requiring it from the kit file. A peer does not make it resolvable from `packages/cadre-rn/` here, and a devDependency copy at the root would be a second Expo toolchain beside the app's (the same reason `react-native` is not a devDependency; see the cadre-rn block in `knip.ts`).

### What the plugin does

```js
// @ts-check
// @serfab/cadre-rn/app.plugin.js — referenced from app.json "plugins" as "@serfab/cadre-rn".
'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');

/** @param {any} config  — typed loosely: the kit has no Expo types to import */
function withCadre(config) {
	const projectRoot = config._internal?.projectRoot;
	if (!projectRoot) throw new Error('@serfab/cadre-rn config plugin: Expo did not pass the project root (config._internal.projectRoot)');
	const { withAndroidManifest, AndroidConfig } = createRequire(path.join(projectRoot, 'package.json'))('expo/config-plugins');
	return withAndroidManifest(config, (cfg) => {
		AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults).$['android:usesCleartextTraffic'] = 'true';
		return cfg;
	});
}
module.exports = withCadre;
```

That is the shape, not final code: split into small functions per the repo style, put the "why it is safe" reasoning in the file's header comment (it travels with the setting), and avoid `any` where a JSDoc typedef for the few fields used is cheap. Name the Android function so a later iOS arm (below) can sit beside it.

### iOS is not changed

The reference app does not set `NSAllowsArbitraryLoads`, and whether App Transport Security (ATS) applies to React Native's WebSocket on iOS is unverified. Record that in the docs as unverified, with the check that would settle it: an iPhone release build dialing a public `/dns4/…/ws` address over cellular. If ATS refuses it, the same reasoning supports an ATS exception added to this plugin. No code for it now.

### Docs

- **`docs/reference-app-rn.md`**: a `### Release builds: cleartext WebSocket` subsection under `## Transport & Connectivity` (after `### Phone (RN app) Configuration`). Says: Android blocks `ws://` in release builds unless the app opts in; the kit's config plugin opts in; why it is safe (Noise, no CA, claim proof is HMAC inside Noise); the `networkSecurityConfig` caveat; iOS unverified with the settling check. Also add the plugin to the "Key Dependencies" row for `@serfab/cadre-rn` if that row lists what the app uses the kit for.
- **`packages/cadre-rn/README.md`**: a `## Config plugin (Expo)` section (near `## @serfab/cadre-rn/metro`): the one `app.json` line, what it sets, one sentence on why it is safe linking to the docs section, the override and `networkSecurityConfig` notes, and for bare React Native (no prebuild) the manifest line to add by hand: `android:usesCleartextTraffic="true"` on `<application>` in `android/app/src/main/AndroidManifest.xml`.
- **`.release-notes.pending.md`**: a short `@serfab/cadre-rn` entry: release builds can now dial `/ws` nodes once the app adds `"@serfab/cadre-rn"` to its Expo plugins (#38).

Keep the docs DRY: the full reasoning lives once in `docs/reference-app-rn.md`; the README and the plugin's header comment state it in a sentence and link.

## Edge cases & interactions

- **App already sets `usesCleartextTraffic`** (true or false) in its manifest or via another plugin (e.g. `expo-build-properties` `android.usesCleartextTraffic`): this plugin sets `true`, overriding a deliberate `false`, and the last plugin in `app.json` order wins. Say so in the README. Verified by inspection.
- **App with a `networkSecurityConfig`** that restricts cleartext per domain: Android lets that file override the manifest flag, so `/ws` dials stay blocked. Note it in both docs; do not edit the app's network security config. Inspection.
- **Bare React Native without Expo prebuild** cannot use a config plugin; the README gives the manifest line. Inspection.
- **`_internal.projectRoot` absent** (a config tool that does not set it): the plugin throws a clear error rather than resolving from the wrong directory. Inspection.
- **Published install**: `app.plugin.cjs` must be in `files`, or `yarn smoke:published` fails ("exports targets are missing"). The `files` entry is the guard; no new check needed.
- **Debug manifest** already sets the flag; setting it on main too is harmless (manifest merge, same value).
- **Plugin order** in `reference-app-rn/app.json`: independent of the other plugins; append it at the end.

## Verification

- `yarn dep-check` (knip + dep ranges) passes. knip derives `app.plugin.cjs` as an entry from `exports`. If it reports `expo` as an unlisted dependency because of the `createRequire(...)('expo/config-plugins')` call, add `'expo'` to the cadre-rn `ignoreDependencies` in `knip.ts` with a one-line comment (resolved from the app's project root at prebuild time, never installed by the kit).
- `yarn lint` passes (covers `.cjs` like `metro/index.cjs`).
- From `packages/reference-app-rn`, run `npx expo config --type introspect` and confirm the Android manifest mod result shows `android:usesCleartextTraffic: "true"` on the `<application>` element. Introspect evaluates mods without writing native files. **Do not** run `expo prebuild` over `packages/reference-app-rn/android/` (it is a developer's local generated project), and do not make a scratch copy of the repo by hand. The sibling-repos rule forbids recursive deletes over `node_modules` junctions; `docs/testing.md` → "Scratch worktrees and clones" covers it. If introspect does not surface the manifest, record that in the handoff and leave the check to a human `expo prebuild --platform android --no-install` run.
- No unit test: the plugin is configuration, verified by introspection.

## TODO

- `packages/cadre-rn/app.plugin.cjs` as designed above, with the reasoning in its header comment.
- `packages/cadre-rn/package.json`: `exports["./app.plugin.js"] = "./app.plugin.cjs"`, and `"app.plugin.cjs"` in `files`.
- `packages/reference-app-rn/app.json`: append `"@serfab/cadre-rn"` to `plugins`.
- `docs/reference-app-rn.md` subsection and `packages/cadre-rn/README.md` section as above, iOS recorded as unverified.
- `.release-notes.pending.md` entry.
- `yarn dep-check`, `yarn lint`, the introspect check; adjust `knip.ts` only if knip asks.
