----
description: Review the @libp2p/webrtc (webRTC + webRTCDirect) transport addition to reference-app-web's libp2p node. Relay becomes signaling-only; NAT-to-NAT browser pairs upgrade to a direct WebRTC data path. ICE from the runtime manifest. Relay reservation cap left ON.
files: packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/package.json, packages/reference-app-web/e2e/distributed/webrtc-upgrade.spec.ts, packages/reference-app-web/e2e/distributed/connection-path.spec.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/src/lib/connection-path.ts
----

## What this delivers

`reference-app-web`'s libp2p node now carries the canonical browser WebRTC pattern: reserve a circuit-relay slot → peer dials in over `/p2p-circuit` → SDP exchanged over the circuit → direct WebRTC connection forms → relay drops out of the data path. The 128 KiB / 2 min per-reservation cap (service-relay side, in db-p2p) was **not** touched — once the upgrade works that cap is a feature, not a pain point.

## What changed (concrete diff)

**`packages/reference-app-web/package.json`**
- Added `"@libp2p/webrtc": "6.0.14"` (exact pin — see "Version decision" below; this is NOT the `^6.0.24` the source ticket guessed).

**`packages/reference-app-web/src/lib/optimystic.ts`**
- Imported `{ webRTC, webRTCDirect }` from `@libp2p/webrtc` and `{ loadIceConfig }` from `./ice-config.js`.
- In `startNode`, before building `config`: `const iceServers = await loadIceConfig();`.
- `transports` is now `[webSockets(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers } }), webRTCDirect()]`. The two webRTC factories carry a documented `as unknown as TransportFactory` brand-bridge cast (see "Type cast" below).
- `listenAddrs` is now `isDistributed ? ['/p2p-circuit', '/webrtc'] : []` (solo stays `[]`).
- Doc-comments updated to explain `/webrtc` (listen for upgraded WebRTC over the reservation) and the transport roles.
- `connectionGater` and the relay cap were left exactly as-is, per the ticket.

**`packages/reference-app-web/e2e/distributed/webrtc-upgrade.spec.ts`** (NEW)
- The flip-point assertion: after a cross-browser dial + convergence, polls `getConnectionPaths()` until at least one side holds a `direct` / `transport === 'webrtc'` path AND `stuckOnRelay === 0` on both sides (60 s ramping window), then asserts the pair's relayed count trends to 0 and every webrtc path is well-formed (`/webrtc` in remoteAddr, `kind === 'direct'`, not stuck).

**`packages/reference-app-web/e2e/distributed/connection-path.spec.ts`**
- Removed the "WEBRTC-TICKET FLIP POINT" comment block; rewrote the doc to point at `webrtc-upgrade.spec.ts`.
- Relaxed the pre-upgrade poll from `relayed >= 1` to **`relayed >= 1` OR a `webrtc` path present**, so the classification guard stays honest about the relay→direct transition (the relay may already be gone by the time it polls).
- Dropped its local `gotoMessages`/`sendOne` copies in favour of the shared `_helpers.ts` versions.

**`packages/reference-app-web/e2e/distributed/_helpers.ts`**
- Lifted `gotoMessages` and `sendOne` here (exported) so both specs share them (DRY).

## Version decision (review this carefully)

The source ticket asserted `@libp2p/webrtc@^6.0.24`. That is **wrong for this tree**: 6.0.24 depends on `@libp2p/interface@^3.2.3`, but db-p2p (optimystic, linked) and the rest of reference-app-web are pinned to `@libp2p/interface@3.1.0`. Installing 6.0.24 nests a second `@libp2p/interface@3.2.3` whose `Transport` interface carries a different `[transportSymbol]` brand → `tsc` rejects the transports array (`TS2322`, missing `[transportSymbol]`).

I pinned **6.0.14** instead — the latest `@libp2p/webrtc` that declares `@libp2p/interface@^3.1.0`, i.e. the same libp2p generation as `@libp2p/websockets@10.1.3` / `@libp2p/circuit-relay-v2@4.1.3` / `libp2p@3.1.3` already in the tree. The `webRTC(...)` / `webRTCDirect()` API is identical across 6.0.x, so functionality is unchanged. 6.0.14 being the same generation as libp2p 3.1.3 also makes it the runtime-safe choice (Component shapes match).

## Type cast (review this carefully)

Even on 6.0.14, webrtc's *transitive* deps (`@libp2p/interface-internal@3.1.6`, `@libp2p/utils@7.2.2`, `@libp2p/logger@6.2.8`) declare `@libp2p/interface@^3.2.3`, so yarn maximized them to 3.2.x and they drag a 3.2.x `Transport` into webrtc's `Components` type. That reproduces the same nominal `[transportSymbol]` brand mismatch in the factory's parameter position.

I bridged it with a localized, documented cast in `optimystic.ts`:
```ts
type TransportFactory = NonNullable<NodeOptions['transports']>[number];
...
webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
webRTCDirect() as unknown as TransportFactory,
```
**Why this is runtime-safe, not a papered-over bug:** `transportSymbol` is `Symbol.for('@libp2p/transport')` — a *global registry* key, identical across interface versions at runtime — so libp2p's `transport[transportSymbol] === true` registration check passes regardless of which interface copy stamped it. The skew is purely nominal at the type layer.

**Alternatives I rejected** (call out if you disagree): (a) a monorepo-wide `resolutions: { "@libp2p/interface": "3.1.0" }` — forces every workspace down a minor and risks cadre-core / integration-tests and the parallel `build-health-typecheck-all-packages` ticket; (b) pinning all five transitive webrtc packages to 3.1.0-gen versions — fragile, and out-of-range forcing carries its own runtime risk. The cast has the smallest blast radius (one file) and no `any`. A reviewer who wants zero duplicate-interface copies in the bundle could revisit (a)/(b) as a follow-up, but it's not required for correctness.

## Validation performed (all green, this pass)

| Check | Command | Result |
|---|---|---|
| src typecheck | `yarn workspace @serfab/reference-app-web run typecheck` | 0 errors |
| e2e typecheck | `… exec tsc --noEmit -p tsconfig.e2e.json` | 0 errors |
| svelte-check | `… exec svelte-check` | 0 errors / 0 warnings / 548 files |
| build | `… run build` (`tsc --noEmit && vite build`) | success, `✓ built in ~5s` |

- **Browser bundle confirmed**: vite resolved `@libp2p/webrtc`'s browser entry; no Node-only `node-datachannel` polyfill breakage. (`node-datachannel@0.29.0` is fetched as a Node-side transitive dep and is marked "must be built", but it is never imported into the browser bundle — build is clean.)
- Pre-existing vite warnings (NOT introduced here): the dynamic/static dual-import notices for `@libp2p/peer-id` and `p2p-fret` come from optimystic's db-p2p `dist/`, and the ">500 kB chunk" warning is the pre-existing heavy libp2p bundle (now 1.44 MB / 432 kB gzip). Neither is a failure.

## NOT done / gaps the reviewer must treat as a floor

1. **The e2e specs were authored + typechecked but NOT executed.** They are not agent-runnable under tess — they need `yarn build && yarn preview` (or `yarn dev`) serving the app, Chromium, AND the Tier-2 reference-peer fixture (relay + service peers). **A human / CI must run `yarn workspace @serfab/reference-app-web test:e2e` with the fixture up.** Treat the green typecheck as "the assertion compiles", not "the upgrade fires".

2. **Realistic risk the e2e will surface — the upgrade may not fire.** The web app drives libp2p `dialProtocol(peerId)`, which consults the libp2p **peerStore** for the target's addrs. The upgrade only happens if the dialer has the target's `/…/p2p-circuit/webrtc/p2p/<peer>` address in its peerStore. The relayed `/p2p-circuit` addr already propagates today (the Tier-2 specs converge cross-browser), and adding `/webrtc` to `listenAddrs` makes each peer advertise the webrtc *variant* over the same identify/cohort flow — so this is *expected* to be self-sufficient, but it is the single most likely failure mode.
   - **Contingency (per the source ticket, deliberately NOT filed yet):** if the e2e run shows the upgrade does not fire, do **not** expand the transport work — file `tickets/backlog/web-webrtc-signaling-addr-resolution.md` describing the missing glue (wire a db-p2p peerStore address-resolver seam, or have the web app consume the prereq's `resolvePeerAddrs`). I did not file it because I have no evidence of failure; filing it speculatively would be noise. `webrtc-upgrade.spec.ts`'s header documents this contingency inline.

3. **The relaxed `connection-path.spec.ts` poll** (`relayed >= 1 || webrtc present`) is honest but weaker than before — it no longer guarantees a relay was observed. That's intentional (the relay can upgrade away before the poll), but a reviewer may prefer to assert the *transition* (relay-then-webrtc) more strictly if the fixture proves timing is stable.

4. **`@libp2p/webrtc@6.0.14` is an exact pin.** It will not pick up patch fixes automatically. If a reviewer prefers a range, it must be bounded to the `^3.1.0`-interface generation (`>=6.0.8 <6.0.15`); a plain `^6.0.14` resolves back to 6.0.24 and reintroduces the TS2322 break.

## Test use cases / success criteria (for the human/CI e2e pass)

- **Upgrade flip:** two browsers connect via the Tier-2 fixture; within ~60 s `getConnectionPaths()` on ≥1 side reports a `direct` path with `transport === 'webrtc'` and `stuckOnRelay === 0`; the pair's relayed count trends to 0. (`webrtc-upgrade.spec.ts`.)
- **Relay drop survivable:** killing the relay after a browser↔browser connect should not drop the session (data path is direct). (Manual — not yet scripted.)
- **No relay for a public drone:** a browser→public-node connection classifies `webrtc`/`webrtc-direct` or `websocket`, never `circuit-relay`. (Manual / future e2e.)
- **Solo unchanged:** solo mode still boots with `listenAddrs: []`, no reservation, transports present-but-idle. (Covered by existing `solo/*.spec.ts` + typecheck/build — verified green here.)
- **ICE empty path:** with no `VITE_ICE_CONFIG_URL` and no `localStorage['ice-config-url']`, `loadIceConfig()` → `[]` and the node still constructs (`webRTC` with empty `iceServers`), no throw at startup. (Statically verified: `loadIceConfig` never throws; build/boot path constructs the transport unconditionally.)

## Follow-ons (already in backlog, not part of this ticket)

- `tickets/backlog/rn-webrtc-transport.md` — mirror this into `reference-app-rn`.
- `tickets/backlog/turn-credential-issuance-service.md`, `turn-relayed-path-metrics.md` — dormant TURN work referenced by `ice-config.ts`.
