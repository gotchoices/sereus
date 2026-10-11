description: Android release builds of Sereus phone apps cannot connect to any node over plain WebSocket addresses, because Android blocks unencrypted traffic unless the app opts in; debug builds work. Ship the opt-in with the React Native kit so every app gets it with one config line, and document why it is safe.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/package.json (exports, files), packages/cadre-rn/README.md, packages/reference-app-rn/app.json (plugins), docs/reference-app-rn.md
----
# React Native release builds can dial `/ws` nodes

Reported as gotchoices/sereus#38 by kjeib: the health app's signed release APK on a Galaxy S21 could not claim a cadre-cli 1.14 node; every `/ws` address was unreachable on Wi-Fi and cellular. Allowing cleartext in the release manifest fixed it at once.

## Cause

Since API 28 Android refuses non-TLS connections unless the app opts in, and it classifies `ws://` as cleartext by scheme. React Native templates opt in for debug only (`android/app/src/debug/AndroidManifest.xml`, `usesCleartextTraffic="true"`), and `reference-app-rn`'s prebuilt project follows that template. Every app built from it hits this on its first release build.

## Why opting in is safe

Every libp2p connection is encrypted and authenticated by the Noise handshake against the peer id in the address. TLS underneath would add a certificate-authority dependency and no security; avoiding certificate authorities is a design goal. A claim's secret never crosses the wire either: `claimNode` sends an HMAC proof inside the Noise channel.

## What to build

- **A config plugin in `@serfab/cadre-rn`**: `app.plugin.js` at the package root (Expo resolves a package's plugin from there), using `withAndroidManifest` from `@expo/config-plugins` to set `android:usesCleartextTraffic="true"` on `<application>`, with a comment giving the reason above. Add it to `files`. An app enables it with one entry, `"@serfab/cadre-rn"`, in `app.json` plugins. Chosen over telling each app to add `expo-build-properties`, so the reason travels with the setting and every Sereus app gets the same thing. Check whether the kit's dependency rules (`yarn dep-check`, knip) accept `@expo/config-plugins` as a peer or optional dependency; an app using Expo already has it.
- **`reference-app-rn` uses it** in `app.json` plugins.
- **Docs:** a "Release builds" note in `docs/reference-app-rn.md` and the kit README: why it is needed and why it is safe.
- **iOS is not changed here.** The reference app does not set `NSAllowsArbitraryLoads`, and whether App Transport Security applies to React Native's WebSocket is unverified. Record it in the docs note as unverified, and leave the check to a device run: an iPhone release build dialing a public `/dns4/…/ws` address over cellular. If ATS refuses it, the same reasoning supports an ATS exception added to the same plugin.

## Edge cases & interactions

- An app that already sets `usesCleartextTraffic` (to true or false) in its own manifest: the plugin sets true; say so in the README, since a deliberate `false` would be overridden.
- An app with a `networkSecurityConfig` that restricts cleartext per domain: Android lets that file override the manifest flag. Note it in the docs; do not try to edit the app's network security config.
- Bare React Native apps without Expo prebuild cannot use a config plugin; the README gives the one manifest line to add by hand.

Verification: a prebuild of `reference-app-rn` (`npx expo prebuild --platform android --no-install` into a scratch copy, or inspecting the generated main manifest) shows the attribute on `<application>` in the main manifest, not only the debug one. No unit test: the plugin is configuration.

## TODO

- `packages/cadre-rn/app.plugin.js` and its `files` entry.
- `reference-app-rn/app.json` plugin entry.
- Release-builds note in `docs/reference-app-rn.md` and `packages/cadre-rn/README.md`, including iOS as unverified.
- `.release-notes.pending.md` entry.
