description: The phone app can now form direct phone-to-peer WebRTC connections instead of relaying every byte through the always-on drone — code/config/bundle all verified, but the actual relay→direct upgrade is unproven until a two-device test on real hardware.
prereq:
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/index.js, packages/reference-app-rn/polyfills/webrtc.js
difficulty: hard
----

## What was built

Mirrored the proven web WebRTC upgrade (`web-webrtc-transport-to-bypass-relay`) into
`reference-app-rn`: added the `@libp2p/webrtc` transport, backed by `react-native-webrtc`'s native
engine, so a phone's NAT-to-NAT connection upgrades from **relayed** (`/p2p-circuit`) to **direct**
(`/webrtc`), leaving the relay signalling-only. Transport scope is `webRTC()` **only** — no
`webRTCDirect()` (phones can't listen / can't make a fixed certhash; that dial path is deferred to
backlog `rn-webrtc-direct-dial`).

### Changes (6 files)
- **`package.json`** — added `@libp2p/webrtc@6.0.14` (**exact pin**, matching web — a `^`-range
  reintroduces the multi-`@libp2p/interface`-copy transports-array TS2322), `react-native-webrtc`
  `^124.0.6` (resolved to `124.0.7`, already in the lockfile transitively from the web app; 124.x
  supports the new architecture), and dev `@config-plugins/react-native-webrtc@^12.0.0` (the `^12`
  line is the one whose peer is `expo: ^53`).
- **`app.json`** — added the `@config-plugins/react-native-webrtc` plugin. It injects the iOS
  `NSCamera`/`NSMicrophone` usage strings + Android `CAMERA`/`RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS`
  permissions the native module links against. **Media is unused** (data channels only) — both
  permission strings are set to copy that says so; nothing requests media at runtime.
- **`polyfills/webrtc.js`** (new) — `registerGlobals()` from `react-native-webrtc`, installing the
  native `RTCPeerConnection`/`RTCSessionDescription`/`RTCIceCandidate`/`RTCDataChannel` surface the
  browser variant of `@libp2p/webrtc` reads off `globalThis`.
- **`index.js`** — imports the new polyfill **after** `./polyfills/hermes` (DTLS needs
  `crypto.getRandomValues`) and **before** `expo-router/entry` (which mounts cadre-phone.ts →
  `@libp2p/webrtc`). Order: hermes → webrtc → intl → event → expo-router.
- **`metro.config.js`** — generalized the existing `@libp2p/crypto` browser-map shim into
  `loadLibp2pBrowserMap(scope, name)` and merged in `@libp2p/webrtc`'s `browser` field so Metro
  resolves its 4 node-datachannel-pulling modules to their `.browser.js` variants. Skips the
  `node:net`/`node:os` → `false` entries (already handled by the `extraNodeModules` empty shims).
- **`cadre-phone.ts`** — imported `webRTC` + `loadIceConfig`; `await loadIceConfig()` inside
  `startPhoneNode` (not hoisted — re-fetched each cold-start/resume since ICE servers rotate; the
  5 s deadline bounds a hung manifest host); added
  `webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory` to
  `network.transports`; kept `listenAddrs: []`. No classifier change (cadre-core already maps
  `/webrtc` → `direct`).

## Tier-A validation — ALL GREEN (this is the floor, not the finish line)

Run from repo root unless noted. Every command below was run and passed:

- `yarn workspace @serfab/reference-app-rn typecheck` → **0 errors**. This also settled the
  ticket's open type question: `expo/tsconfig.base` actually sets `lib: ["DOM", "ESNext"]`, so
  `RTCConfiguration`/`RTCIceServer` DO resolve and `IceServer[]` (the local `ice-config.ts` type) is
  structurally assignable to `RTCIceServer[]` — no DOM-type cast needed at the call site, only the
  `TransportFactory` brand-bridge. (The `ice-config.ts` header comment claiming "RN's tsconfig does
  not include dom" is stale/over-cautious — not corrected here to keep that file diff-free, but
  worth a reviewer's eye.)
- `yarn workspace @serfab/reference-app-rn test` → **7 files, 123 tests, all pass** (incl. the
  `rn-ice-config` spec).
- `yarn workspace @serfab/reference-app-rn test:bundle` (`expo export --platform android`) →
  **Exported, 4462 modules, exit 0**. Full log streamed to `/tmp/rn-bundle.log`. **Zero**
  `node-datachannel` references and zero resolution errors — the load-bearing proof that Metro
  picked the `browser` variant of `@libp2p/webrtc` (the node variant imports
  `node-datachannel/polyfill`, which is unresolvable on RN, so a clean bundle could not have used
  it). The `multiformats .../sha2-browser.js ... not listed in exports → file-based resolution`
  WARN spam is **pre-existing** (same exports-fallback pattern across the whole libp2p tree, not
  introduced here).
- Isolated check of the metro shim confirmed it maps exactly the 4 webrtc files
  (`webrtc/index.js`, `private-to-public/{listener,transport}.js`, `get-rtcpeerconnection.js`) →
  their `.browser.js` variants, all targets existing, `node:*`-false entries skipped.
- `yarn eslint` on all 6 changed files → **clean**.

## Tier-B — NOT run here, NOT a blocker, MUST be done by human/CI before this is "real"

Tier-A proves *it compiles, bundles, and Metro picks the right variant*. It does **NOT** prove the
upgrade fires on a device. The native module only links under a real build, and the relay→direct
flip only happens with two live peers + relay infra — neither is agent-runnable (needs EAS
Build / Xcode / Android Studio + a device or simulator). This mirrors how the web e2e was handed to
human/CI under the prereq ticket.

**Device pass to run:** `eas build --profile development` (or `expo run:android` / `expo run:ios`),
then a two-party run. Success criteria:
- Two phones (or phone + NAT'd host) in the same cadre connect via the relay; within ~60 s
  `getConnectionPaths()` on ≥1 side reports a `direct` path with `transport === 'webrtc'` and
  `stuckOnRelay === 0`; the pair's relayed count trends toward 0.
- Solo phone boots with `listenAddrs: []`, no reservation, `webRTC` registered-but-idle, no error.

## Reviewer: invariants to eyeball + judgement calls I made (verify these)

1. **Polyfill ordering is load-bearing and Tier-A can't catch it** (globals are a runtime concern).
   Confirm `index.js` imports `./polyfills/webrtc` after `./polyfills/hermes` and before
   `expo-router/entry`. If `registerGlobals()` ran *after* `@libp2p/webrtc` evaluated, the transport
   factory would capture `undefined` for `RTCPeerConnection` and either throw at construction or
   silently never upgrade. (Tier-B device check.)
2. **Metro variant selection.** A bundle failure mentioning `node-datachannel` / `node:*` would mean
   "wrong variant resolved" (shim regressed), not a missing polyfill. Currently clean.
3. **`connectionGater` — I deliberately did NOT add one** (the ticket said don't add speculatively).
   The web app added `denyDialMultiaddr: () => false` for its *local/insecure* reference dials; the
   phone dials a real relay/drone over `wss` (not private/loopback), so libp2p's default should not
   gate the WebRTC-over-circuit dial out. **This is an unverified assumption** — if the Tier-B
   device run shows the `/webrtc` dial being gated out, add the same permissive gater the web uses
   (cadre-core threads it to both the control node and each strand cohort node) and document why.
4. **`@libp2p/interface` skew.** The `TransportFactory` cast (`as unknown as Libp2pTransports[number]`)
   is the same brand-bridge the web file documents — runtime-safe (the `[transportSymbol]` is a
   global-registry key). If the exact pin ever drifts to a `^`-range, typecheck will surface the
   transports-array TS2322; that's the signal the pin is wrong.

## Known gaps / forward pointers (honest)

- **The upgrade is unproven until Tier-B.** Treat green Tier-A as "compiles + bundles + right
  variant", nothing more.
- **iOS background DTLS.** The phone runs headless/background (push-wake). WebRTC connections may
  not survive backgrounding — this is a foreground-first win. Not solved here; flagged for the
  device pass.
- **TURN credentials** flow straight from the manifest into `rtcConfiguration.iceServers`. TURN is
  off by default upstream (`turnPolicy: 'off'`); the wiring doesn't choke on populated
  `username`/`credential`, but a TURN-relayed path is (knowingly) misclassified as `direct` —
  dormant backlog `turn-relayed-path-metrics`.
- **Follow-on:** backlog `rn-webrtc-direct-dial` (phone → public `/webrtc-direct` peer) is a
  separate, less-certain win, intentionally out of scope here.
