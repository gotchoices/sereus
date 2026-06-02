----
description: Add @libp2p/webrtc (webRTC + webRTCDirect) to the reference-app-web libp2p node so a relayed NAT-to-NAT path upgrades to a direct browser↔browser / browser↔node WebRTC connection. The circuit relay becomes signaling-only; the data path goes direct. ICE servers come from the runtime ice-config manifest. Keep the relay reservation limit ON.
prereq: peer-record-resolution-layer
files: packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/package.json, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/e2e/distributed/connection-path.spec.ts, packages/reference-app-web/e2e/distributed/_helpers.ts
----

## Problem

`reference-app-web` configures its libp2p node with `transports: [webSockets(), circuitRelayTransport()]` and listens on `['/p2p-circuit']` (`optimystic.ts:172,179`). `circuitRelayTransport()` on its own **never upgrades a relayed connection to a direct one** — the browser upgrade path in libp2p is WebRTC, which is not present. So browser↔browser and browser↔NAT'd-peer connections relay *every byte* of every transaction for the connection lifetime, and the 128 KiB / 2 min per-reservation cap (enforced on the service relay via db-p2p `relayServerInit`) becomes a pain people are tempted to remove — the wrong direction.

This ticket adds the canonical js-libp2p browser pattern: reserve a relay slot → peer dials in over the circuit → SDP exchanged over the circuit → direct WebRTC connection forms → relay drops out of the data path.

## Current state (verified this pass)

- `optimystic.ts:46-47` imports `webSockets` and `circuitRelayTransport`; `:172` sets `transports: [webSockets(), circuitRelayTransport()]`; `:179` sets `listenAddrs: isDistributed ? ['/p2p-circuit'] : []`; `:185` sets the `connectionGater: { denyDialMultiaddr: () => false }` local-testing relaxation.
- `transports`/`listenAddrs` flow straight through `NodeOptions` into `createLibp2pNodeBase` (`../optimystic/.../libp2p-node-base.ts:99-100,210-211`) — explicit values override the Node defaults verbatim. **DCUtR and AutoNAT are already always-on** in the node base (`:240-241`); they are the node↔node upgrade path and are inert for WS-only browsers — no action needed here.
- `@libp2p/webrtc` is **not yet a dependency** anywhere in the monorepo (checked root + optimystic). The compatible version for this libp2p generation (libp2p `^3.1.3`, `@libp2p/circuit-relay-v2 ^4.1.3`, `@libp2p/websockets ^10.1.3`, `@libp2p/interface ^3.x`) is **`@libp2p/webrtc@^6.0.24`** (latest 6.x), which exports `webRTC` and `webRTCDirect`.
- `ice-config.ts` already ships `loadIceConfig(): Promise<RTCIceServer[]>` (from `webrtc-stun-turn-infrastructure`, complete). It resolves a manifest URL (`VITE_ICE_CONFIG_URL` → `localStorage['ice-config-url']`), fetches/validates, and returns `[]` on any failure — never throws. This is the ICE-servers source; do **not** hard-code STUN.
- The connection-path classifier (from `relay-usage-connectivity-observability`, complete) already classifies a `…/p2p-circuit/webrtc/p2p/…` connection as `direct`/`webrtc` (WebRTC checks precede `/p2p-circuit`), so the success-criteria observability is in place. `__optimystic.getConnectionPaths()` is the assertion surface.
- `e2e/distributed/connection-path.spec.ts` already contains the **"WEBRTC-TICKET FLIP POINT"** marker (asserts `relayed >= 1` today; instructs the consumer ticket to add the `direct`/`webrtc` + `stuckOnRelay === 0` assertion). That consumer ticket is this one.

## Design

### Transports

```ts
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { loadIceConfig } from './ice-config.js';

// inside startNode(), before building `config`:
const iceServers = await loadIceConfig();

transports: [
  webSockets(),            // dial public WS nodes (kept)
  circuitRelayTransport(), // the signaling substrate (kept)
  webRTC({ rtcConfiguration: { iceServers } }), // browser↔browser; relay = signaling only
  webRTCDirect(),          // browser→public node (e.g. a storage drone w/ a public addr); no relay
],
```

- `iceServers` may be `[]` when no manifest URL is configured — that is the documented degraded-but-safe path (host/LAN candidates still work; NAT traversal needs STUN). `webRTC` accepts an empty `iceServers` array; do not throw or skip the transport on `[]`.
- `webRTC` automatically uses the existing circuit-relay connection for SDP signaling — no extra wiring beyond keeping `circuitRelayTransport()` present.

### Listen addrs

```ts
listenAddrs: isDistributed ? ['/p2p-circuit', '/webrtc'] : [],
```

- `/webrtc` (not `/webrtc-direct`) — browsers can only *listen* for webRTC over a circuit reservation; `webRTCDirect` is dial-only from a browser. After the `/p2p-circuit` reservation is made, libp2p constructs the `/<relay>/p2p-circuit/webrtc/p2p/<self>` listen address and advertises it via `identify`, which is how a dialing peer learns to upgrade.
- Solo mode stays `[]` — unchanged behavior.

### Keep the relay reservation limit ON

Do **NOT** set `applyDefaultLimit: false`. Note: that cap lives on the **service relay** nodes (`circuitRelayServer(relayServerInit)` in db-p2p), *not* in `optimystic.ts` — the browser is a relay *client*, not a server, so there is nothing to change here. The point of this requirement is a guard-rail: this ticket must not "fix" relayed-byte pressure by loosening the service-relay cap. Once WebRTC upgrade works, the 128 KiB / 2 min cap is a *feature* (bounds relay-as-data-path abuse, pressures a prompt upgrade). Leave it untouched.

### connectionGater

Keep `connectionGater: { denyDialMultiaddr: () => false }` (`:185`) — it must continue to permit the local reference-peer fixture (`/ip4/127.0.0.1/.../ws/...`). WebRTC dials are not affected by this relaxation; leave it as-is.

### Peer-address resolution / the dial path (soft dependency — read carefully)

The prereq `peer-record-resolution-layer` implements a signed, freshness-stamped `CadreNode.resolvePeerAddrs(peerId)` in **`@serfab/cadre-core`**. **`reference-app-web` does not import cadre-core** (no dependency in its `package.json`); it drives `@optimystic/db-p2p` directly via `NetworkTransactor` → `RepoClient` → `Libp2pKeyPeerNetwork.connect()` → `libp2p.dialProtocol(peerId)`. That dial consults the libp2p **peerStore** for the target's addresses.

The existing relayed browser↔browser path **already works today** (the Tier-2 e2e specs converge cross-browser over `/p2p-circuit`), which means the peerStore is already being populated with peers' `/p2p-circuit` addrs through the running relay/identify/cohort flow. Adding `/webrtc` to `listenAddrs` makes each peer advertise the `…/p2p-circuit/webrtc` *variant* of that same address, carried by the same propagation; libp2p then prefers the webrtc-dialable addr and upgrades. **So for the web app, the transport addition is expected to be self-sufficient** — `resolvePeerAddrs` is the robust, signed resolution for the CadreNode/CLI/RN consumers and to replace the copy-paste workaround, not a code path the browser bundle calls.

**Therefore:** implement the transport wiring as the concrete deliverable. Do **not** add a cadre-core dependency to the web app or build a db-p2p address-resolver hook in this ticket. If the e2e flip-point spec (below) shows the upgrade does *not* fire because the dialer lacks the target's `/webrtc` circuit addr in its peerStore, **do not expand this ticket** — file a `tickets/backlog/` follow-on (e.g. `web-webrtc-signaling-addr-resolution`) describing the missing glue (wire a db-p2p peerStore address-resolver seam, or have the web app consume `resolvePeerAddrs`) and note it in the review handoff. The `prereq:` is kept for topo-ordering and design coherence; the web diff's hard dependency is only on `@libp2p/webrtc` + `ice-config.ts`, both present.

## Expected behavior / success criteria

- Two-browser Tier-2 scenario: after a short settle window the inter-browser connection is a direct `webrtc` connection and the relayed-connection count drops to ~0 steady-state (per `getConnectionPaths()`).
- Browser→public-drone connections use `webRTCDirect`/`webSockets` and never establish a `/p2p-circuit` connection.
- Solo-mode behavior unchanged (`listenAddrs: []`, no reservation, transports present but idle).
- Killing the relay after a browser↔browser connect does not drop the session (data path is direct).

## References

- `packages/reference-app-web/src/lib/optimystic.ts:46-47,147-186` (imports, `startNode`, transports, listen addrs, gater)
- `packages/reference-app-web/src/lib/ice-config.ts` (`loadIceConfig`, `IceConfigManifest`)
- `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:99-100,210-211` (transports/listenAddrs passthrough), `:240-241` (DCUtR/AutoNAT already on), `:76-87` (relay reservation limit — service-side, keep on)
- `../optimystic/packages/db-p2p/src/libp2p-key-network.ts:294-316` (`connect()` → `dialProtocol`; runOnLimitedConnection over the relay)
- `packages/reference-app-web/e2e/distributed/connection-path.spec.ts` (flip-point marker), `e2e/distributed/_helpers.ts` (`connectToBootstrap`, `collectBootstrapMultiaddrs`, fixture helpers)
- `@libp2p/webrtc@^6.0.24` exports `webRTC({ rtcConfiguration: { iceServers } })` and `webRTCDirect()`.
- Follow-on: `tickets/backlog/rn-webrtc-transport.md` (mirror this into reference-app-rn).

## TODO

### Phase 1 — dependency + transport wiring
- Add `"@libp2p/webrtc": "^6.0.24"` to `packages/reference-app-web/package.json` dependencies; run `yarn install` and confirm it resolves against the existing `@libp2p/*` 3.x/4.x/10.x generation (no peer-dep conflicts). Stream install output with `tee`.
- In `optimystic.ts`: import `{ webRTC, webRTCDirect }` from `@libp2p/webrtc` and `{ loadIceConfig }` from `./ice-config.js`.
- In `startNode`, before constructing `config`, `const iceServers = await loadIceConfig();` and set `transports: [webSockets(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers } }), webRTCDirect()]`.
- Change `listenAddrs` to `isDistributed ? ['/p2p-circuit', '/webrtc'] : []`.
- Update the `listenAddrs` doc-comment (`:173-178`) to explain that `/webrtc` accepts the WebRTC connections upgraded over the reservation; leave the `/p2p-circuit` rationale intact.
- Do NOT touch `connectionGater` or introduce any `applyDefaultLimit` change.

### Phase 2 — e2e flip-point assertion
- Extend `e2e/distributed/connection-path.spec.ts` (or add a sibling `webrtc-upgrade.spec.ts` using the same `_helpers.ts`): after the cross-browser dial + convergence, `expect.poll` on `getConnectionPaths()` until the pair shows a `direct`/`webrtc` path and `stuckOnRelay === 0` within a generous settle window (e.g. 30–60s, intervals ramping). Keep the existing `relayed >= 1` assertion as the *pre-upgrade* check or relax it to "≥1 relayed *or* converged-then-direct" so the spec is honest about the transition. Remove/replace the FLIP-POINT comment block to reflect that the assertion now exists.
- This spec is **not agent-runnable under tess** (needs `yarn build && yarn preview` + Chromium + the Tier-2 reference-peer fixture). Author it, typecheck it, and document in the review handoff that it must be run by a human/CI with the fixture. Note the realistic risk: if the upgrade does not fire, see the backlog follow-on in the Design section rather than forcing it green.

### Phase 3 — validation (foreground, `tee`)
- `yarn workspace @serfab/reference-app-web run typecheck` (tsc --noEmit) → 0 errors.
- `yarn workspace @serfab/reference-app-web exec svelte-check` → 0 errors / 0 warnings.
- `yarn workspace @serfab/reference-app-web run build` (tsc --noEmit && vite build) → confirm the WebRTC transport bundles for the browser (watch for any Node-only polyfill breakage from `@libp2p/webrtc`; it is browser-targeted, but verify the vite build does not choke). Stream with `tee`; if vite build wall-clock approaches ~10 min, treat as not-agent-runnable and document the deferral.
- There is no ESLint surface for this package (no lint script) — typecheck + svelte-check + build are the floor.

### Key tests (TDD intent — expected outputs)
- **Upgrade flip:** two browsers connect via the Tier-2 fixture; within the settle window `getConnectionPaths()` on at least one side reports a `direct`/`webrtc` path with `transport === 'webrtc'` and `stuckOnRelay === 0`; steady-state relayed count for the pair trends to ~0. (e2e, human/CI.)
- **No relay for public drone:** a browser→public-node connection classifies `webrtc`/`webrtc-direct` or `websocket`, never `circuit-relay`. (e2e/manual.)
- **Solo unchanged:** solo mode still boots with `listenAddrs: []`, no reservation, transports present-but-idle; existing `solo/*.spec.ts` stay green. (typecheck/build + existing specs.)
- **ICE empty path:** with no `VITE_ICE_CONFIG_URL` / no `localStorage` override, `loadIceConfig()` → `[]` and the node still constructs (webRTC with empty `iceServers`); no throw at startup. (unit-observable via typecheck + boot.)
