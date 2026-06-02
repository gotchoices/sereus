----
description: The web client uses only webSockets + circuitRelayTransport, so every NAT-to-NAT path runs over a circuit relay for the connection's full lifetime. Add @libp2p/webrtc (webRTC + webRTCDirect) so the relay is used only as a signaling channel and the data path becomes a direct browser↔browser / browser↔node WebRTC connection.
prereq: peer-address-resolution-for-relay-signaling, webrtc-stun-turn-infrastructure
files: packages/reference-app-web/src/lib/optimystic.ts
----

## Problem

`reference-app-web` configures its libp2p node with `transports: [webSockets(), circuitRelayTransport()]` and listens on `['/p2p-circuit']` (`optimystic.ts:168-175`). `circuitRelayTransport()` on its own **never upgrades a relayed connection to a direct one** — the upgrade path in libp2p is WebRTC (for browsers) or DCUtR (for node↔node). Neither is present. The result is that browser↔browser and browser↔NAT'd-peer connections relay *every byte* of every transaction for the lifetime of the connection. The 128 KiB / 2 min per-reservation cap that `@optimystic/db-p2p` documents (`libp2p-node-base.ts:76`) then becomes a problem people are tempted to *remove* (`applyDefaultLimit: false`) — which is the wrong direction.

This is the canonical js-libp2p browser pattern (as used by Helia/IPFS): reserve a relay slot → peer dials in over the circuit → SDP exchanged over the circuit → direct WebRTC connection forms → relay drops out of the data path.

## Requirements / specifications

- Add `@libp2p/webrtc` to the web node's transports:
  - `webRTC({ rtcConfiguration })` for browser↔browser, using the relay reservation purely for signaling.
  - `webRTCDirect()` for browser→public node (e.g. a storage drone with a public address), which needs no relay at all.
  - Keep `webSockets()` (dialing public WS nodes) and `circuitRelayTransport()` (the signaling substrate).
- Listen on `['/p2p-circuit', '/webrtc']` in distributed mode so that, after the relay reservation is made, the node also accepts the WebRTC connections that get upgraded over it. Solo mode stays `[]`.
- ICE servers come from the runtime-discovered STUN/TURN config (`webrtc-stun-turn-infrastructure`), not hard-coded.
- The signaling dial path resolves the target peer's current relay multiaddr from its PeerId via the peer-address resolution layer (`peer-address-resolution-for-relay-signaling`) — without that, browser↔browser has nothing to signal through.
- **Keep the relay reservation limit ON.** Once WebRTC upgrade works, the 128 KiB / 2 min cap is a *feature*: it bounds how much a relay can be abused as a data path and pressures a prompt upgrade. This ticket should explicitly NOT set `applyDefaultLimit: false`; revisit only if signaling itself exceeds the cap.
- The `connectionGater: { denyDialMultiaddr: () => false }` local-testing relaxation (`optimystic.ts:181`) must continue to permit the local reference-peer fixture.

## Expected behavior / success criteria

- For a two-browser Tier-2 scenario, after a short settle window the inter-browser connection is a direct `webrtc` connection, and the relayed-connection count (per `relay-usage-connectivity-observability`) drops to ~0 steady-state.
- Browser→public-drone connections use `webRTCDirect`/`webSockets` and never establish a `/p2p-circuit` connection.
- Existing solo-mode behavior is unchanged.

## Use cases

- Two browser tabs in the same web cadre exchange transactions over a direct WebRTC connection; killing the relay after connect does not drop their session.
- A browser joins a distributed network whose coordinator pick lands on another browser tab and reaches it directly rather than relaying through a service peer.

## References

- `packages/reference-app-web/src/lib/optimystic.ts:46-47,168-186` (current transports, listen addrs, dial-timeout rationale, debug hook)
- `@libp2p/webrtc` exports `webRTC` and `webRTCDirect`; `webRTC` accepts `{ rtcConfiguration: { iceServers } }`.
- `../optimystic` `db-p2p/src/libp2p-node-base.ts:76-85` (relay reservation limit doc — keep it on)
- Prereqs: `tickets/plan/peer-address-resolution-for-relay-signaling.md`, `tickets/plan/webrtc-stun-turn-infrastructure.md`; baseline `tickets/plan/relay-usage-connectivity-observability.md`.
- Follow-on: `tickets/backlog/rn-webrtc-transport.md`.
