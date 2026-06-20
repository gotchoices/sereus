----
description: A TURN-relayed WebRTC media path consumes server bandwidth like a circuit relay, but the connection-path classifier sees only a /webrtc multiaddr and reports it as "direct". When TURN is enabled, count TURN-relayed paths as relayed in connectivity observability so the fallback is visible, not silent.
prereq: turn-ssrf-peer-deny-hardening
files: packages/cadre-core/src/diagnostics/connection-path.ts, packages/reference-app-web/src/lib/connection-path.ts
difficulty: easy
----

## Problem

`relay-usage-connectivity-observability` (ticket 1) classifies an established WebRTC connection by its libp2p multiaddr: `…/webrtc/…` → `direct`/`webrtc`. But WebRTC's own ICE layer may have selected a **relayed** candidate pair (a TURN server in the path) — in which case the bytes flow through the operator's TURN server for the connection's lifetime, exactly the relay cost this effort tries to remove. The libp2p multiaddr does not encode the selected ICE candidate type, so today such a path would be silently mis-reported as `direct`.

This gap is dormant while TURN is OFF (the default established by `webrtc-stun-turn-infrastructure`), but becomes a correctness/observability hole the moment TURN is enabled.

## Requirements / specifications

- Detect, for a `/webrtc` connection, whether the selected ICE candidate pair is `relay` type (TURN). Source is the underlying `RTCPeerConnection.getStats()` (`candidate-pair` → local/remote `candidate` with `candidateType === 'relay'`), which `@libp2p/webrtc` does not currently surface — investigate what it exposes / whether a hook is needed.
- A TURN-relayed `/webrtc` path must count as **relayed** (and ideally a distinct transport tag, e.g. `webrtc-turn`) in `getConnectionPaths()` and its mirrored web duplicate, feeding the existing relayed/direct counts + `stuckOnRelay` condition and the CLI Prometheus gauges.
- Keep the read pure / never-throw, consistent with ticket 1's classifier design; account for the two mirrored copies (cadre-core canonical + web duplicate) staying in sync.

## Use cases

- An operator with TURN enabled sees TURN-relayed sessions reflected in the relayed-connection metric and the stuck-on-relay signal, rather than a falsely-reassuring all-direct dashboard.

## References

- `tickets/complete/1-relay-usage-connectivity-observability.md` (classifier design, mirrored copies, `stuckOnRelay`, gauges).
- `tickets/implement/2-webrtc-stun-turn-infrastructure.md` (TURN policy: last-resort, must be counted as relayed).
- `@libp2p/webrtc` connection internals / `RTCPeerConnection.getStats()` candidate-pair stats.
