description: Android release builds of Sereus phone apps could not connect to any node over plain WebSocket addresses, because Android blocks unencrypted traffic unless the app opts in. The React Native kit now ships an Expo config plugin that opts in with one line in the app's config, and the docs say why that is safe.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/app.plugin.cjs, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/app.json, docs/reference-app-rn.md, docs/architecture.md, .release-notes.pending.md
----
# React Native release builds can dial `/ws` nodes

Reported as gotchoices/sereus#38. Android (API 28 and later) refuses non-TLS connections unless the app sets `android:usesCleartextTraffic="true"`, and it counts `ws://` as cleartext. React Native's template sets it in the debug manifest only, so release builds could dial no `/ws` address.

## What landed

- `packages/cadre-rn/app.plugin.cjs`: the Expo config plugin `withCadre`, which uses `withAndroidManifest` to set `android:usesCleartextTraffic="true"` on the main `<application>`. It resolves `expo/config-plugins` from the app's project root (`config._internal.projectRoot`) and throws a named error without it, so the kit installs nothing from Expo.
- `packages/cadre-rn/package.json`: `exports["./app.plugin.js"]` → `./app.plugin.cjs`, and the file in `files`.
- `packages/reference-app-rn/app.json`: `"@serfab/cadre-rn"` in `plugins`.
- Docs: `docs/reference-app-rn.md` § Release builds: cleartext WebSocket (cause, plugin, why it is safe, network-security-config caveat, iOS unverified); kit README § Config plugin (Expo); a release-notes entry; and (review) a sentence in `docs/architecture.md`'s `@serfab/cadre-rn` paragraph.

The planned ticket said the last-listed plugin wins; Expo's code says the first-listed wins, and the README says so.

## Review findings

Read the `ticket(implement): rn-release-builds-dial-ws-nodes` diff before the handoff.

- **Correctness, plugin resolution:** checked. Expo resolves `<pkg>/app.plugin.js` through Node's resolver, which honours `exports`; `require('@serfab/cadre-rn/app.plugin.js')` from the reference app returns the function. Re-ran `npx expo config --type introspect --json`: the Android manifest's `<application>` carries `android:usesCleartextTraffic: "true"`.
- **Correctness, `_internal.projectRoot`:** checked in `@expo/config` `getConfig`: `ensureConfigHasDefaultValues` fills `_internal` before `withConfigPlugins` applies the plugins (the source comment says "should be done after _internal"), so the throw fires only outside Expo's config loader. No change.
- **Correctness, plugin order claim:** confirmed in `@expo/config-plugins` `withMod.js`: each mod runs its own action, then calls the one registered before it, so the first-listed plugin's change is applied last and wins. The handoff's deviation is right.
- **Docs, minor, fixed:** the README bullet "It overrides `false`… even where … another plugin set `false`" contradicted its own next sentence (an earlier-listed plugin setting `false` beats this one). Split into two bullets: overrides a `false` in the manifest; against another plugin, the first listed wins.
- **Docs, minor, fixed:** `docs/architecture.md`'s paragraph listing what `@serfab/cadre-rn` carries did not mention the plugin. Added one sentence linking the reference-app section. Other docs that list the kit's pieces (`packages/reference-app-rn/README.md`, `docs/testing.md`) cover polyfills and Metro only, and the plugin is not a test or a polyfill, so no change.
- **Type safety / hygiene:** the plugin is `@ts-check` with local JSDoc typedefs for the Expo helpers it uses; no `any` leaks except the `createRequire` result assigned to the typed return. File is 78 lines with comments that state why (CommonJS, no Expo dependency, safety reasoning link). No change.
- **Error handling / resource cleanup:** the one error path (missing project root) throws with a specific message; nothing is opened or held. No change.
- **Tests:** none added, none cut. The plugin is configuration with one branch; introspection against the real reference app covers it, and a unit test would mock Expo's mod system, which this repo does not own the shape of in a stable way.
- **Lint / checks:** `yarn lint` exit 0. `yarn dep-check` exit 0 (the `@multiformats/multiaddr` knip failure the implementer flagged was resolved by the runner's triage commit).
- **Not verified, unchanged from handoff:** no release APK has been built and dialed at a `/ws` node, and iOS App Transport Security behaviour for React Native's WebSocket is unchecked; both are documented in `docs/reference-app-rn.md` with the check that settles them. These need a device and a human, so no ticket.
- **Behaviour choice, no change:** the plugin forces `true` over an app's deliberate manifest `false`; the README states it. No tripwire needed, since that is the plugin's whole purpose.
