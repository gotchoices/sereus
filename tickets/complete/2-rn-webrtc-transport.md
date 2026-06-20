description: The phone app can now form direct phone-to-peer WebRTC connections instead of relaying every byte through the always-on drone. Code, config, and bundle are verified green; the actual relay→direct upgrade still needs a two-device test on real hardware (handed to human/CI).
prereq:
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/index.js, packages/reference-app-rn/polyfills/webrtc.js, packages/reference-app-rn/src/ice-config.ts
difficulty: hard
----

## Summary

Mirrored the proven web WebRTC upgrade into `reference-app-rn`: added the `@libp2p/webrtc`
transport (exact-pinned `6.0.14`, matching web) backed by `react-native-webrtc`'s native engine, so
a phone's NAT-to-NAT connection upgrades from **relayed** (`/p2p-circuit`) to **direct** (`/webrtc`),
leaving the relay signalling-only. Transport scope is `webRTC()` only (no `webRTCDirect()` — phones
can't listen / can't make a fixed certhash; deferred to backlog `rn-webrtc-direct-dial`).

Implementation across 6 files: `package.json` (deps), `app.json` (config plugin + permission
disclosures), `polyfills/webrtc.js` (new — `registerGlobals()`), `index.js` (ordered polyfill
import), `metro.config.js` (generalized browser-variant shim), `cadre-phone.ts` (transport wiring +
`await loadIceConfig()`). The connection-path classifier already maps `/webrtc` → direct, so no
diagnostics change was needed.

## Review findings

**Disposition: 1 minor finding (fixed inline). No major findings. Build/lint/tests green.**

### What was checked

- **Read the full implement diff (`43fb987`) with fresh eyes** before the handoff summary, then read
  every touched file (`cadre-phone.ts`, `metro.config.js`, `index.js`, `polyfills/webrtc.js`,
  `app.json`, `package.json`) plus the adjacent `ice-config.ts` and the web reference
  (`cadre-web.ts`) it mirrors.
- **Version pins (type safety / `@libp2p/interface` skew).** Confirmed `@libp2p/webrtc` is pinned to
  exactly `6.0.14` in both `reference-app-rn` and `reference-app-web` package.json (the `^`-range
  TS2322 trap is avoided). The `as unknown as TransportFactory` brand-bridge cast matches the web
  file and is runtime-safe (the `[transportSymbol]` is a global-registry key). Typecheck surfaces no
  transports-array error.
- **Metro browser-variant selection (THE load-bearing gate).** Inspected the installed
  `@libp2p/webrtc/package.json` `browser` field (4 file remaps + `node:net`/`node:os` → false) and
  independently reproduced the `loadLibp2pBrowserMap` shim: it maps exactly the 4 webrtc files
  (`webrtc/index.js`, `private-to-public/{listener,transport}.js`,
  `utils/get-rtcpeerconnection.js`) → their `.browser.js` variants, all sources and targets exist,
  and the non-string (`node:*` → false) entries are skipped. The package also ships a `react-native`
  field that remaps **only** `index.js` → `index.react-native.js`; forcing the `browser` variant for
  all 4 (as the implementer did) is correct — the `react-native` field would leave the three
  private-to-public modules on their `node-datachannel` originals.
- **Browser-variant internal consistency (corroborates the polyfill-ordering invariant).** Read
  `index.browser.js` (`export const RTCPeerConnection = globalThis.RTCPeerConnection`) and the
  private-to-public browser variants (bare `RTCPeerConnection` free references resolved off the
  global). All read the WebRTC engine off the global surface that `registerGlobals()` installs, so
  the strict `index.js` import order (hermes → webrtc → … → expo-router/entry) is genuinely
  load-bearing — confirmed the order is correct in `index.js`.
- **`app.json` config-plugin wiring.** Verified `@config-plugins/react-native-webrtc` v12's
  `withPermissions` reads exactly `cameraPermission` / `microphonePermission` from props — the keys
  in `app.json` match, so the "Unused: …" disclosure strings will actually be injected (not silently
  dropped in favour of default copy).
- **Classifier.** `connection-path.ts` orders the `/webrtc` check before `/p2p-circuit`, so a
  `…/p2p-circuit/webrtc/…` mid-upgrade connection is correctly classified `direct` — no change
  needed, as claimed.
- **Lint + tests + bundle (all re-run here, all green):**
  - `yarn workspace @serfab/reference-app-rn typecheck` → **0 errors**.
  - `yarn workspace @serfab/reference-app-rn test` → **7 files, 123 tests pass**.
  - `yarn eslint` on all changed files → **clean**.
  - `yarn workspace @serfab/reference-app-rn test:bundle` (`expo export --platform android`) →
    **exit 0, "Exported: dist", 4463 modules, 0 `node-datachannel` references, no `node:*`
    resolution errors**. The only WARN spam is the pre-existing `multiformats … sha2-browser.js …
    not listed in exports → file-based resolution` pattern (plus an identical `event-target-shim`
    exports-fallback from react-native-webrtc) — exports-fallback noise across the whole libp2p
    tree, not introduced here.

### What was found and done

- **MINOR (fixed inline) — stale `ice-config.ts` header comment.** The comment claimed "RN's
  tsconfig does not include `dom`" and that the next ticket "maps it onto react-native-webrtc's type
  at the call site." Both are now false: `expo/tsconfig.base` sets `lib: ["DOM", "ESNext"]` (DOM
  types resolve), and `cadre-phone.ts` passes the `IceServer[]` straight into
  `rtcConfiguration.iceServers` (structurally assignable to `RTCIceServer[]`) with no per-element
  mapping. Reworded the comment to reflect reality and to state the local `IceServer` type is kept
  deliberately for `dom`-decoupling/portability. Comment-only; typecheck + lint re-verified green.

### What was NOT found (explicitly, with reason)

- **No correctness bug in the transport wiring.** The `webRTC({ rtcConfiguration: { iceServers } })`
  call, the brand-bridge cast, `listenAddrs: []`, and the in-`startPhoneNode` `await loadIceConfig()`
  (5 s-bounded, re-fetched per cold-start so rotated ICE servers are picked up) all match the web
  reference and typecheck/bundle clean.
- **No new test added.** `cadre-phone.ts`'s transport array cannot be unit-tested in the vitest
  (node) env without pulling `react-native-webrtc`'s native module; the meaningful proof is the
  device pass (Tier-B). The existing `ice-config` spec covers the one agent-testable new seam. This
  is an accepted gap, not an oversight.
- **`connectionGater` omission is acceptable.** The implementer deliberately did not add the web
  app's permissive `denyDialMultiaddr: () => false`. libp2p's connection gater acts on the
  libp2p-level dial (the circuit dial to a public `wss` relay — allowed), while WebRTC ICE
  candidates (including private/host LAN candidates) are negotiated inside the native RTCPeerConnection,
  not through libp2p's dialer — so the default gater should not block the upgrade. This remains an
  unverified-on-device assumption, but it is honestly documented and trivially reversible; not a
  blocker and not worth a separate ticket (the whole device pass is already deferred).

## Outstanding (handed to human/CI — NOT agent-runnable, as designed)

Tier-A (compiles + bundles + Metro picks the right variant) is proven. It does **NOT** prove the
upgrade fires on a device — the native module only links under a real build, and the relay→direct
flip needs two live peers + relay infra (EAS Build / Xcode / Android Studio + device/simulator).
Device pass to run: `eas build --profile development` (or `expo run:android` / `expo run:ios`), then
a two-party run. Success criteria:

- Two phones (or phone + NAT'd host) in the same cadre connect via the relay; within ~60 s
  `getConnectionPaths()` on ≥1 side reports a `direct` path with `transport === 'webrtc'` and
  `stuckOnRelay === 0`; the pair's relayed count trends toward 0.
- Solo phone boots with `listenAddrs: []`, no reservation, `webRTC` registered-but-idle, no error.

Known device-pass risks (documented, not solved here): **polyfill ordering** (runtime-only, can't be
caught by the bundle); **`connectionGater`** assumption above; **iOS background DTLS** (the phone
runs headless/push-wake — WebRTC may not survive backgrounding; foreground-first win); **TURN
credentials** flow into `rtcConfiguration.iceServers` but TURN is off by default upstream, and a
TURN-relayed path is knowingly misclassified `direct` (dormant backlog `turn-relayed-path-metrics`).

Follow-on: backlog `rn-webrtc-direct-dial` (phone → public `/webrtc-direct` peer) — a separate,
less-certain win, intentionally out of scope.
