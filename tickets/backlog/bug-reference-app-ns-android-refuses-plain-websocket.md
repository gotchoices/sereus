description: The NativeScript sample app on Android is expected to be unable to connect to a node on the local network or on the development machine, because the app does not ask Android for permission to make unencrypted connections and those are the only kind such a node offers.
architecture: docs/platforms/nativescript.md#what-the-app-must-provide
files: packages/reference-app-ns/App_Resources/Android/src/main/AndroidManifest.xml, packages/reference-app-ns/App_Resources/Android/app.gradle, packages/reference-app-ns/src/polyfills/websocket.ts, packages/reference-app-ns/scripts/run-e2e.mjs, packages/reference-app-ns/README.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Nobody has seen the refusal on a device, the README already tells the reader to use an encrypted address, and allowing unencrypted traffic in a sample app's manifest is a setting some maintainers would rather confine to debug builds or leave off.
----

# NativeScript app on Android: a plain WebSocket address is expected to be refused

## What is wrong

The edge node the app runs dials other nodes over WebSocket. A node on the same Wi-Fi, a drone on the development machine reached through the emulator's `10.0.2.2` or through `adb reverse`, and a self-run relay without a TLS certificate all have addresses ending in `/ws`, which is an unencrypted `ws://` connection underneath (the libp2p connection inside it is still encrypted and authenticated).

Android refuses unencrypted connections by default for an app that targets API level 28 or later, unless the manifest sets `android:usesCleartextTraffic="true"` or names a network security configuration that allows them.

- `App_Resources/Android/app.gradle` sets `targetSdkVersion 35`.
- `App_Resources/Android/src/main/AndroidManifest.xml` sets neither attribute, and the package has no network security configuration file.
- The app's WebSocket comes from `@valor/nativescript-websockets` (`src/polyfills/websocket.ts`), whose Android bridge (`bridge.android.js` in the installed package) builds an `okhttp3.OkHttpClient`. OkHttp applies the platform's cleartext policy and fails such a connection before any byte is sent.

So a `/ws` dial is expected to fail on Android, and with it every local arrangement the app is tested in: the device-test drone, and the end-to-end runner (`scripts/run-e2e.mjs`), whose drone listens on `ws` port 4002.

The React Native side handles the same rule: the kit's Expo config plugin sets `android:usesCleartextTraffic="true"` at prebuild (`packages/cadre-rn/README.md`, "Release builds need cleartext WebSocket" in `docs/platforms/react-native.md`). The edge node's `allowPrivateDial` option exists so that these same local addresses can be dialled; the manifest is the part the NativeScript app is missing.

## Expected behaviour

A development build of the NativeScript app can dial a `/ws` address on the local network, on `10.0.2.2` and on `127.0.0.1`. Whether a release build may is the maintainer's choice; a debug-only manifest or a network security configuration limited to private addresses would keep it out of release builds.

## Evidence and confirmation

Read from the manifest, the Gradle file and the plugin's source. Not confirmed on a device or emulator; `packages/reference-app-ns/README.md` (Troubleshooting) words it as expected for that reason.

To confirm: on an Android emulator, start a cadre-cli node listening on `/ip4/0.0.0.0/tcp/4002/ws`, enter `/ip4/10.0.2.2/tcp/4002/ws/p2p/<peer id>` as the bootstrap address and tap **Connect**. The expected result is a failed dial, with a logcat line from OkHttp saying cleartext communication to the host is not permitted by network security policy.
