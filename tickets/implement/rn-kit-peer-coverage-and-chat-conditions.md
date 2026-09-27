description: Two small follow-ups from reviewing the new React Native kit: two native helper modules that the fast-encryption library uses should be listed so the kit keeps them at one copy, and the bundler helper should be tested with the settings sereus-chat actually uses.
files:
  - packages/cadre-rn/package.json (peerDependencies, peerDependenciesMeta)
  - packages/cadre-rn/metro/index.cjs (rule 1, the peer rule)
  - packages/cadre-rn/README.md (peer list)
  - packages/cadre-rn/test/ (with-cadre-metro spec)
  - tickets/blocked/report-rn-kit-to-app-projects.md
----

# RN kit: cover quick-crypto's native helpers, and test Metro with sereus-chat's conditions

From sereus-rn's review of the kit (2026-09-27). Nothing here blocks the release, but do it before the release if the runner reaches it first.

1. **Add `react-native-nitro-modules` and `react-native-quick-base64` as optional peers**, next to `react-native-quick-crypto`. Both are JS-plus-native modules that quick-crypto uses, and the kit's rule 1 (peers resolve from the app) only covers declared peers. Today a single copy is loaded only because of how the dependencies happen to be hoisted: nitro exists only in the app, and quick-base64 is 3.0.1 at both the root and the app. Take the ranges from what quick-crypto ^1.1.7 requires. Add both to the README's peer list; nitro is currently mentioned only in prose. If the reference app doesn't list them as its own dependencies, add them there too, because autolinking needs the app to list native modules.
2. **Add a `withCadreMetro` spec case using sereus-chat's resolver settings**: `unstable_enablePackageExports: true` and `unstable_conditionsByPlatform` with `react-native`, `import`, `require` and `default` (see `../sereus-chat/apps/mobile/metro.config.js`, read-only). Show that rule 3 (the browser-variant rewrite for `@libp2p/crypto` and `@libp2p/webrtc`) and rule 2 (the `@babel/runtime` redirect) still apply. Today that is argued from reading the code only.
3. **In `blocked/report-rn-kit-to-app-projects.md`, add the adoption condition:** sereus-chat's crypto shim stubs `sign()` because the FCM notifier was in cadre-core's root import graph (0.8.x). Push moved behind `./push-node` in cadre-core 0.9.0. The kit drops the stub, so an app must adopt it on a cadre-core version at or above the kit's own paired release, which is well past 0.9.0. Name that version in the report text.

`react-native-get-random-values` stays as it is: a missing copy already fails at bundle time, and the README says it's required for `./polyfills`.
