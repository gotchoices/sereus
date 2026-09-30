description: In a browser tab, the check for whether a WebRTC connection went through a TURN relay can pick up the answer for a different connection opened around the same time by another network in the same tab, so the Diagnostics page could label a direct connection as relayed or the reverse. It has no effect while TURN is switched off.
files: packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts, packages/cadre-core/src/cadre-node.ts
repro: static
severity: cosmetic
likelihood: unusual
tradeoffs: TURN is off by default and the only consumer is a diagnostics count, so a wrong label costs nothing today; a maintainer could reasonably leave this until TURN is enabled in a deployment.
----

## What is wrong

`TurnRelayTracker` (`packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts`) wraps `globalThis.RTCPeerConnection` and pushes one relayed/not-relayed verdict onto a single queue for **every** WebRTC session in the JavaScript realm. `CadreNode` reads that queue only from its **control** node's `connection:open` handler (`handleTurnConnectionOpen` in `packages/cadre-core/src/cadre-node.ts`), taking the newest verdict from the last second.

A browser tab runs several libp2p nodes built from the same transport list: the control node plus one node per strand (`packages/reference-app-web/src/lib/cadre-web.ts` passes one `network.transports` array, including `webRTC({ rtcConfiguration: { iceServers } })`, which cadre-core hands to both). All of them create `RTCPeerConnection`s through the same wrapped constructor. So:

- A strand node's WebRTC session that settles within one second of a control-node `/webrtc` open can have its verdict consumed by the control connection. If the strand session was TURN-relayed and the control session was not, the control connection is reported `relayed`/`webrtc-turn`. The tracker's header says the timing match "never produces a false `relayed`"; with more than one node in the realm that does not hold.
- The reverse also happens: the control connection's own verdict is left in the queue and pruned, so a relayed control connection is reported `direct`.
- Strand-node `connection:open` events never consume anything, so strand verdicts are always either stolen or discarded. Sessions from the `webRTCDirect` transport also go through the wrapped constructor and are queued the same way, though the control handler correctly refuses to consume on a `/webrtc-direct` open.

Two tabs forming a strand open a control connection and a strand connection to the same peer close together, so the timing overlap is the ordinary case once TURN is on, not a rare one. That claim is from reading the code; it has not been measured.

## Why this is dormant

With TURN off (the default; see `ops/docs/ice-servers.md`) no ICE session can select a relay candidate, every verdict is "not relayed", and a mismatched verdict changes nothing.

## What would confirm it

A tab with TURN enabled and ICE forced to relay for strand sessions only (or a unit test that installs the tracker, settles two fake `RTCPeerConnection`s with different verdicts, and drains from one "node"), showing the control connection tagged with the strand session's verdict.

## Expected behaviour

A connection's relayed/direct label reflects the ICE outcome of that connection's own WebRTC session, regardless of how many libp2p nodes share the realm. Where the match cannot be made with confidence, the label stays at the multiaddr-only result (`direct`/`webrtc`) rather than taking another session's verdict.

The fix belongs in how a verdict is tied to a connection — an identifier both sides can see (for example the session's ICE username fragment or remote certificate fingerprint, if `@libp2p/webrtc` exposes either on the connection or its multiaddr), or a tracker scoped per node rather than per realm — not in narrowing the time window.
