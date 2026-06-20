----
description: Let the phone app form direct phone-to-peer connections instead of relaying every byte through the always-on drone. Wires the React Native WebRTC engine into the same relay-as-signaling upgrade the web app already proved, so a relayed connection hole-punches to a direct one.
prereq: rn-ice-config
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/index.js, packages/reference-app-rn/polyfills/webrtc.js, packages/reference-app-web/src/lib/cadre-web.ts
difficulty: hard
----

## Goal

Mirror the proven web WebRTC upgrade (completed ticket `web-webrtc-transport-to-bypass-relay`,
see `packages/reference-app-web/src/lib/cadre-web.ts:50-53,285-317`) into
`reference-app-rn`: add the `@libp2p/webrtc` browser transport, backed by
`react-native-webrtc`'s native WebRTC engine, so a phone's NAT-to-NAT connection upgrades from
**relayed** (`/p2p-circuit`, every byte through the drone) to **direct** (`/webrtc`). The relay
becomes signaling-only, exactly as on web.

The upgrade pattern is identical and already proven on web: reserve a circuit-relay slot → peer
dials in over `/p2p-circuit` → SDP exchanged over the circuit → direct WebRTC data path forms →
relay drops out of the data path. The per-reservation cap in db-p2p is a feature once the upgrade
works — **do not touch it**.

## What's settled (design decisions — do NOT re-open)

- **Transport scope: `webRTC()` only, not `webRTCDirect()`.** Phones cannot listen
  (`listenAddrs: []`, see `cadre-phone.ts:169`), and `webRTCDirect` listen requires generating a
  certificate with a fixed certhash that `react-native-webrtc` cannot produce. The realistic win
  (per the source plan) is **phone → peer direct upgrade over a relayed signaling path**, which is
  exactly what `webRTC()` delivers. `webRTCDirect()` **dial** (phone → a public peer advertising
  `/webrtc-direct`) is a separate, less-certain win deferred to backlog `rn-webrtc-direct-dial` —
  do not add it here.
- **Native WebRTC via `react-native-webrtc` + `registerGlobals()`.** `@libp2p/webrtc`'s browser
  variant is written against the global `RTCPeerConnection` / `RTCSessionDescription` /
  `RTCIceCandidate` / `RTCDataChannel` surface. `react-native-webrtc` provides exactly these and a
  `registerGlobals()` that installs them onto `global`. Call it in a polyfill imported from
  `index.js` **before** any libp2p/app code (the same discipline as `polyfills/hermes.js`).
- **Metro must resolve the `browser` variant of `@libp2p/webrtc`.** The package's `exports` default
  (Node) variant pulls `node-datachannel`, a native addon that does not exist on RN; the `browser`
  variant uses the global WebRTC we register. This is the **same** exports/`browser`-condition trap
  the metro config already documents for `@libp2p/crypto` (`metro.config.js:59-114`). The phone
  reuses the same runtime-discovered ICE config (`ice-config.ts` from `rn-ice-config`) the web path
  consumes — that satisfies the source plan's "consume the same runtime-discovered ICE config".

## Hard problem & how it's bounded for an agent run

The genuine risk is **native build + on-device interop**, which is **not agent-runnable** (needs
EAS Build / Xcode / Android Studio + a device or simulator). This ticket therefore has two tiers:

**Tier A — agent-runnable, must be green before handoff:**
- All code/config edits below.
- `yarn workspace @serfab/reference-app-rn typecheck` → 0 errors.
- `yarn workspace @serfab/reference-app-rn test` → existing vitest green (incl. the
  `rn-ice-config` spec).
- **Metro graph resolves**: `yarn workspace @serfab/reference-app-rn test:bundle` (runs
  `expo export --platform android`) completes — this is the load-bearing agent gate. It proves
  Metro resolves `react-native-webrtc` (JS) **and** the `browser` variant of `@libp2p/webrtc`
  (i.e. it did **not** try to bundle `node-datachannel`). Stream it: `... test:bundle 2>&1 | tee
  /tmp/rn-bundle.log` (do not silently redirect — the runner's 10-min idle timer). If
  `expo export` is not runnable in this environment (no Expo CLI / network), document that and fall
  back to typecheck as the floor.

**Tier B — human/CI only, documented in the review handoff (NOT a blocker):**
- `eas build --profile development` (or `expo run:ios` / `expo run:android`) to link the native
  module, then a two-device run asserting the relay→direct flip. This mirrors how the web e2e was
  handed to human/CI under the prereq ticket. Green Tier A means "it compiles, bundles, and Metro
  picks the right variant", **not** "the upgrade fires on a device".

If a Tier-A step surfaces a defect that is **clearly pre-existing** (broken at HEAD, outside this
diff), write `tickets/.pre-existing-error.md` per the stage rules and finish your own ticket.

## Implementation detail

### Dependencies (`package.json`)
- Add `react-native-webrtc` (pick the version matching RN 0.79 / Expo SDK 53 / new architecture —
  `newArchEnabled: true` in `app.json`; verify the chosen version declares new-arch support).
- Add `@libp2p/webrtc`. **Pin exactly**, mirroring the web lesson: the web ticket pinned
  `6.0.14` because a `^`-range pulled `@libp2p/interface@3.2.x` and broke the transports array.
  Match the version installed for web (`packages/reference-app-web/package.json`) so both apps
  resolve the same `@libp2p/interface` generation that db-p2p pins.
- Optionally add `@config-plugins/react-native-webrtc` (devDependency) for the Expo prebuild plugin
  (next section).

### Native config (`app.json`)
- Add the react-native-webrtc Expo config plugin to `plugins` (`@config-plugins/react-native-webrtc`).
  It injects the iOS `NSCameraUsageDescription` / `NSMicrophoneUsageDescription` strings and the
  Android `CAMERA` / `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` permissions the native module links
  against — **even though Sereus uses only data channels**, the native lib requires them to build.
  Note in the plugin config (or a comment) that media is unused; do not request media at runtime.
- This makes the app **prebuild-only** (already true — `expo-dev-client` is present, EAS is
  configured in `eas.json`). It was never Expo-Go-runnable; this does not regress that.

### Globals polyfill (`polyfills/webrtc.js` + `index.js`)
- New `polyfills/webrtc.js`: `import { registerGlobals } from 'react-native-webrtc'; registerGlobals();`
  with a header comment matching the `polyfills/hermes.js` style (why it must run before libp2p).
- Import it from `index.js` **after** `./polyfills/hermes` (which sets up `crypto.getRandomValues`,
  used by DTLS) and **before** `expo-router/entry` (which mounts the React tree that imports
  `cadre-phone.ts` → `@libp2p/webrtc`). Order: hermes → webrtc → intl/event → expo-router.

### Metro (`metro.config.js`)
- Ensure Metro resolves `@libp2p/webrtc` to its `browser` variant. Two viable approaches; pick the
  one that makes `test:bundle` green and is least invasive:
  1. Add `'browser'` to `config.resolver.unstable_conditionNames` (canonical libp2p-on-RN fix).
     Verify it doesn't regress other packages' resolution (re-run `test:bundle`).
  2. A targeted `resolveRequest` rewrite for `@libp2p/webrtc`, mirroring the existing
     `@libp2p/crypto` browser-map shim (`metro.config.js:75-114`).
  Document which you chose and why in a comment, consistent with the existing metro commentary.

### Transport wiring (`cadre-phone.ts`)
Mirror `cadre-web.ts:50-53,272,285-317`:
- Import `{ webRTC }` from `@libp2p/webrtc` and `loadIceConfig` from `./ice-config` (the
  `rn-ice-config` file). Import `loadIceConfig`'s `IceServer[]` and map onto react-native-webrtc's
  config type at the call site.
- In `startPhoneNode`, before building `config`: `const iceServers = await loadIceConfig();`
  (never throws; `[]` when unconfigured).
- Change `network.transports` from `[webSockets(), circuitRelayTransport()]` to add
  `webRTC({ rtcConfiguration: { iceServers } })`. Use the documented brand-bridge cast
  (`as unknown as TransportFactory`, the db-p2p `Libp2pTransports[number]` type — see the
  `TransportFactory` doc block in `cadre-web.ts:66-74`) since the RN tsconfig has no `dom` lib and
  the `@libp2p/webrtc` `[transportSymbol]` brand skews against db-p2p's pinned `@libp2p/interface`
  (runtime-safe — the symbol is a global-registry key, identical across copies). No `any`.
- **Keep `listenAddrs: []`** — phones do not listen. (Unlike web, which conditionally listens on
  `['/p2p-circuit', '/webrtc']` when a relay is reserved. The phone's dialed circuit reservation +
  the `/webrtc` upgrade variant are advertised over the existing identify/cohort flow without a
  listen addr; this is the asymmetry the source plan calls out.)
- The phone does **not** currently set `connectionGater` — the web app added a permissive
  `denyDialMultiaddr: () => false` for its local/insecure reference dials. Evaluate whether the
  phone needs it for WebRTC dials. The libp2p browser default denies dialing private/loopback;
  the phone dials a real relay/drone over `wss`, so it likely does **not** need the override. If a
  WebRTC dial is gated out, add the same gater the web uses and document why; otherwise leave the
  phone's config untouched. Decide via the bundle/typecheck and document the call (do not add it
  speculatively).

### Diagnostics — already done
The connection-path classifier is canonical in cadre-core
(`packages/cadre-core/src/diagnostics/connection-path.ts`) and already maps `/webrtc` → `direct`
(WebRTC checks ordered before `/p2p-circuit`). `cadre-phone.ts:getConnectionPaths` already exposes
it. **No classifier changes needed** — the relay-usage observability signal the source plan wants
to measure against is already wired.

## Edge cases & interactions

- **Polyfill ordering / partial globals.** If `registerGlobals()` runs after `@libp2p/webrtc`
  loads, the transport factory sees no `RTCPeerConnection` and either throws at construction or
  silently never upgrades. Assert (in a comment + the review handoff) that `index.js` imports the
  webrtc polyfill before `expo-router/entry`. The Tier-A bundle does not catch this (globals are
  runtime); it is a Tier-B device check.
- **Metro picks the Node variant.** If the `browser` condition is not applied, Metro tries to
  resolve `node-datachannel` and `test:bundle` fails (or, worse, bundles a broken transport). The
  bundle step is precisely the guard; treat a bundle failure mentioning `node-datachannel` /
  `node:*` as "wrong variant resolved", not a missing polyfill.
- **`@libp2p/interface` version skew.** A `^`-range on `@libp2p/webrtc` reintroduces the web
  ticket's TS2322 (multiple `@libp2p/interface` copies → transports array type break). Exact pin
  only; if typecheck shows the transports-array error, the pin is wrong.
- **ICE timeout on boot.** `loadIceConfig` is now awaited inside `startPhoneNode`, which the
  `BackgroundRunner` cold-start path (`use-cadre.ts:205-214`) re-invokes on every foreground
  resume. The 5 s abort deadline from `rn-ice-config` bounds this; confirm a hung manifest host
  cannot wedge a resume. (No manifest configured → returns immediately.)
- **Background / killed-node resume.** `startPhoneNode` is idempotent and re-run by the runner;
  the new `await loadIceConfig()` must sit inside it (re-fetched each cold start) — acceptable,
  ICE servers may rotate. Do not hoist it to module scope.
- **No relay configured (solo phone).** With `listenAddrs: []` and no bootstrap, the phone has no
  one to upgrade with; `webRTC()` is registered-but-idle. Must not error at start — same posture as
  web solo (four transports present, none listening).
- **TURN credentials.** Manifest may carry TURN entries with credentials; they flow straight into
  `rtcConfiguration.iceServers`. TURN is gated off by default upstream (`turnPolicy: 'off'`), but
  the wiring must not choke on a populated `username`/`credential`. (TURN-relayed paths
  misclassified as `direct` is a known, dormant backlog item — `turn-relayed-path-metrics`.)
- **New architecture (`newArchEnabled: true`).** Confirm the chosen `react-native-webrtc` version
  supports the new arch / TurboModules; an older version will fail the native build (Tier B).
- **iOS background DTLS.** The phone runs headless/background (push-wake). WebRTC connections may
  not survive backgrounding; this is a Tier-B observation, not something to solve here — note it in
  the handoff so the reviewer/human knows the upgrade is a foreground-first win.

## Validation summary (what to run, in order)

- `yarn workspace @serfab/reference-app-rn typecheck` — 0 errors.
- `yarn workspace @serfab/reference-app-rn test` — green (includes `rn-ice-config` spec).
- `yarn workspace @serfab/reference-app-rn test:bundle 2>&1 | tee /tmp/rn-bundle.log` — Metro
  resolves both new packages, no `node-datachannel` / `node:*` resolution error. (If Expo CLI/
  network unavailable in-env, document the deferral; typecheck is then the floor.)
- Tier B (handoff to human/CI, not run here): EAS development build + two-device relay→direct flip,
  success criteria below.

### Tier-B success criteria (for the human/CI device pass)
- Two phones (or phone + NAT'd host) in the same cadre connect via the relay; within ~60 s
  `getConnectionPaths()` on ≥1 side reports a `direct` path with `transport === 'webrtc'` and
  `stuckOnRelay === 0`; the pair's relayed count trends toward 0.
- Solo phone boots with `listenAddrs: []`, no reservation, `webRTC` registered-but-idle, no error.

## TODO

### Phase 1 — deps & native config
- Add `react-native-webrtc` (new-arch-compatible version) and an exact-pinned `@libp2p/webrtc`
  (match web) to `package.json`; optionally `@config-plugins/react-native-webrtc` (dev).
- Add the react-native-webrtc Expo config plugin to `app.json` `plugins`; note media is unused.

### Phase 2 — globals & Metro
- Add `polyfills/webrtc.js` calling `registerGlobals()`; import it from `index.js` after
  `./polyfills/hermes` and before `expo-router/entry`.
- Update `metro.config.js` so `@libp2p/webrtc` resolves to its `browser` variant (condition name or
  targeted resolver); comment the choice.

### Phase 3 — transport wiring
- In `cadre-phone.ts`: import `webRTC` + `loadIceConfig`; `await loadIceConfig()` in
  `startPhoneNode`; add `webRTC({ rtcConfiguration: { iceServers } })` to `network.transports` with
  the documented `TransportFactory` brand-bridge cast; keep `listenAddrs: []`.
- Decide on `connectionGater` for the phone (only add the permissive gater if a WebRTC dial is
  actually gated out; document the decision).

### Phase 4 — validate & hand off
- Run typecheck + vitest + `test:bundle` (streamed). All green / documented deferral.
- Write the `review/` handoff: Tier-A results, the Tier-B device-validation gap (honest — the
  upgrade is unproven until a human/CI device run), the polyfill-ordering and Metro-variant
  invariants the reviewer must eyeball, and the `rn-webrtc-direct-dial` follow-on.
