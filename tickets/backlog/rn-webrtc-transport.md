----
description: Extend the relay-bypass WebRTC path to React Native so phones form direct connections instead of relaying every byte. Harder than web — @libp2p/webrtc targets browser WebRTC APIs and RN needs react-native-webrtc shimmed in. Parked until the web WebRTC path is proven.
prereq: web-webrtc-transport-to-bypass-relay
files: packages/reference-app-rn/src/cadre-phone.ts
difficulty: hard
----

## Why backlog, not active

`reference-app-rn` uses `transports: [webSockets(), circuitRelayTransport()]` with `listenAddrs: []` (`cadre-phone.ts:100-101`), so a phone relays every byte of every NAT-to-NAT connection. The fix is the same WebRTC-upgrade pattern as the web ticket — but RN is materially harder:

- `@libp2p/webrtc` is written against the **browser** WebRTC API surface. React Native has no native `RTCPeerConnection`; it requires `react-native-webrtc`, and wiring that into `@libp2p/webrtc` is not a drop-in (API shims, native module build for iOS/Android, Hermes/JSI considerations).
- Phones cannot listen for inbound connections, so the browser↔browser symmetry doesn't hold; the realistic win is phone→peer direct upgrade once a relayed signaling path exists.

Because of this, the phone-to-public-drone pairing remains the pragmatic connectivity guarantee in the interim — which is exactly why the architecture always pairs a phone with an always-on storage drone. This ticket should be promoted only after `web-webrtc-transport-to-bypass-relay` has proven the signaling + STUN + peer-resolution stack end-to-end, so RN inherits a working design rather than debugging the whole chain on the hardest platform.

## Scope when promoted

- Evaluate `react-native-webrtc` integration with `@libp2p/webrtc` (or a maintained RN-compatible fork/shim); confirm native build viability on both iOS and Android.
- Add `webRTC` (and `webRTCDirect` where applicable) to the phone transports, consuming the same runtime-discovered ICE config and peer-address resolution layer as web.
- Validate that a phone↔phone (same cadre) or phone↔NAT'd-host pair upgrades from relayed to direct, measured against the relay-usage observability signal.

## References

- `packages/reference-app-rn/src/cadre-phone.ts:19-20,100-101` (current transports/listen)
- `tickets/plan/web-webrtc-transport-to-bypass-relay.md` (the proven-first prereq), `tickets/plan/webrtc-stun-turn-infrastructure.md`, `tickets/plan/peer-address-resolution-for-relay-signaling.md`
- `react-native-webrtc` (native WebRTC for RN) — integration spike required.
