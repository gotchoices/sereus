description: Someone with an Android phone needs to build the React Native reference app with its new native encryption and try each encryption setting on a real device, because the change can only be checked for bundling on this machine, not for compiling or running.
prereq: reference-app-rn-native-noise-crypto
architecture: docs/reference-app-rn.md#device-test-runs
files: packages/reference-app-rn/package.json, packages/reference-app-rn/app/settings.tsx, packages/cadre-rn/polyfills/index.js, packages/cadre-rn/src/noise-crypto.ts, docs/reference-app-rn.md
repro: none
----
# Native Noise crypto and the shared kit: nobody has run them on a phone

**Blocked on:** a physical Android phone (or an emulator) plus a native build of the reference app. That is a dependency outside what an agent can do here. It is unblocked when a person runs the session below and records the results in this ticket.

## Why a person is needed

The work in `rn-kit-package-and-native-noise-crypto`, `rn-kit-polyfills`, `rn-kit-metro-helper` and `reference-app-rn-native-noise-crypto` was checked headlessly: the package builds and packs, the crypto adapter matches the pure-JavaScript implementation under Node, and the app's JavaScript bundle builds. None of that proves the native modules (`react-native-quick-crypto`, `react-native-nitro-modules`, `react-native-quick-base64`) compile and link under Expo 53 / React Native 0.79, or that the polyfills still install correctly now that they load from a package.

## What to run

Follow `docs/reference-app-rn.md` § Device test runs. Rebuild the native app first (§ When Native Rebuild Is Needed), because this change adds native modules.

1. **Build.** `expo run:android` (or an EAS development build) completes. If it fails, record the error; the likely cause is a version of nitro or quick-crypto that does not support React Native 0.79.
2. **Boot audit.** In a development build, logcat shows the `[cadre-rn] polyfill audit` table with no `MISSING` rows, and `RTCPeerConnection` reads `polyfilled`. The WebRTC globals now load after the EventTarget and `Intl.PluralRules` patches instead of before them, so a WebRTC failure here points at that change. The one known effect: `react-native-webrtc`'s own `event-target-shim` now finds `event-target-polyfill`'s global `Event` / `EventTarget` when it loads and chains its classes onto them (before, there were none to find).
3. **Each mode.** In Settings, pick each connection-encryption mode in turn (`symmetric`, then `full`, then `off`). For each, Connect to a Node host over the local relay and bring up a strand, as sereus-chat did in its "Pass 3" run (`../sereus-chat/design/specs/mobile/STATUS.md`). Record: whether the strand attaches, how long bring-up takes, and whether the relay's log shows `aborting connection due to ping failure`. The Node card must show the mode that ran.
4. **Interop.** In `full` mode, the phone completes handshakes with a Node peer that uses Node's own crypto. A mismatch in the x25519 key encoding would fail here and nowhere else.

## Expected outcome

`symmetric` and `full` attach without ping-failure aborts. `off` reproduces the old behaviour on a slow enough device (on a fast emulator it may not). sereus-chat measured five of seven attaches with native crypto on; its two failures were `StrandAwaitingFirstSyncError`, a separate intermittent problem, and should not be charged to this change.

If `full` misbehaves where `symmetric` does not, the default stays `symmetric`. File what you saw against the adapter (`packages/cadre-rn/src/noise-crypto.ts`).
