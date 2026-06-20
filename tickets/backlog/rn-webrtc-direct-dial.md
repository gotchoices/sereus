----
description: Once the phone can form direct WebRTC connections, explore letting it dial straight to an always-on drone over WebRTC with no relay middleman at all — saving even the signaling hop. Uncertain whether the React Native WebRTC engine supports this dial mode, so it's parked for a focused spike.
prereq: rn-webrtc-transport
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/cadre-web.ts
----

## Why this is parked (not part of `rn-webrtc-transport`)

The `rn-webrtc-transport` ticket deliberately ships `webRTC()` only — the relay-as-signaling
upgrade that is **proven on web** and gives the phone its main win (NAT-to-NAT direct upgrade). It
does **not** add `webRTCDirect()`.

`webRTCDirect` is a different mechanism: it lets a node **dial** a peer that advertises a
`/webrtc-direct` multiaddr (a publicly reachable peer, e.g. an always-on storage drone) **without a
relay at all** — no circuit reservation, no SDP-over-relay signaling hop. For a phone paired with a
public drone, that is a meaningful connectivity simplification.

The reason it is deferred rather than included:

- **Phones still can't listen**, so only the **dial** direction is relevant (a phone can never be
  the `/webrtc-direct` listener). The web app added `webRTCDirect()` too, but its value there is
  also primarily dial-side for solo tabs.
- **Native viability is genuinely uncertain.** `webRTCDirect` dial requires the WebRTC stack to
  verify a remote peer's certhash carried in the multiaddr and drive a noise handshake over the
  data channel against a peer that did **not** signal over a relay. Whether
  `react-native-webrtc`'s certificate/SDP handling interoperates with `@libp2p/webrtc-direct`'s
  dial path is unproven and cannot be validated by an agent (needs an EAS device build against a
  drone advertising `/webrtc-direct`). Bundling this uncertainty into the main transport ticket
  would risk blocking the proven `webRTC()` win.

## Scope when promoted

- Confirm a drone/host actually advertises a dialable `/webrtc-direct` multiaddr the phone can
  resolve (peer-address resolution — see completed prereq context in the source plan).
- Add `webRTCDirect()` to the phone's `network.transports` (dial-only; `listenAddrs` stays `[]`).
- Validate on-device that a phone dials a public `/webrtc-direct` peer and the connection
  classifies as `direct` / `webrtc-direct` (`connection-path.ts` already maps it), with **no**
  relay reservation involved.
- If react-native-webrtc cannot drive the `webRTCDirect` dial handshake, document the blocker and
  close — `webRTC()`-over-relay remains the connectivity path.

## References

- `packages/reference-app-web/src/lib/cadre-web.ts:52,294-300` — web adds both `webRTC` and
  `webRTCDirect`.
- `packages/cadre-core/src/diagnostics/connection-path.ts:104-112` — classifier already handles
  `/webrtc-direct` (direct).
- Completed: `web-webrtc-transport-to-bypass-relay`, `webrtc-stun-turn-infrastructure`.
