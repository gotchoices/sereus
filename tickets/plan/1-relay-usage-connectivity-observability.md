----
description: We have no metric for how much traffic transits circuit relays vs direct connections, so relay-reduction work cannot be measured. Add connection-path observability (relayed vs direct, bytes-over-relay) as the baseline for the relay-reduction effort.
files: packages/cadre-core/src/cadre-node.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-rn/src/cadre-phone.ts
----

## Problem

Every NAT-to-NAT path in the web and mobile clients (browser↔browser, phone↔phone, phone↔NAT'd host) currently runs over a libp2p circuit relay for the *full lifetime* of the connection, not just for connection setup. There is no instrumentation that reports whether a given connection is relayed (`/p2p-circuit` in its remote multiaddr) or direct, nor how many bytes transit relays. Without this, the relay-reduction work (WebRTC upgrade, DCUtR, AutoNAT) cannot be validated — the common silent failure mode is "WebRTC negotiation fails and the connection quietly stays on the relay," which looks identical to success from the app's perspective.

This ticket is the measurement baseline for the relay-reduction effort and should land first so the other tickets can show a before/after.

## Expected behavior

- A node can report, at any time, the set of open connections classified as **relayed** (remote multiaddr contains `/p2p-circuit/`) vs **direct**, with the per-connection transport (websocket, webrtc, webrtc-direct, tcp, circuit-relay).
- A counter/gauge surface for: count of relayed vs direct connections, and (where libp2p exposes it) bytes transferred over relayed connections. Relayed connections that fail to upgrade to direct within a window are observable as a distinct condition (so a stuck-on-relay state is visible, not silent).
- The signal is exposed through the existing diagnostics/debug surfaces of each runtime (web debug hook in `optimystic.ts`, the phone node, and `CadreNode` status) so it can be read in dev and asserted in integration tests.
- No behavioral change to connection establishment — this is observation only.

## Use cases

- Before/after: capture the relayed-connection ratio for a two-browser Tier-2 scenario, land the WebRTC transport ticket, and confirm the ratio drops to ~0 steady-state (relay used only momentarily for signaling).
- Regression guard: an integration test asserts that, after a configurable settle window, a NAT-to-NAT pair is on a direct (webrtc) connection, not a relay.
- Field diagnostics: identify cadres/strands that are stuck relaying because direct upgrade is failing (missing STUN, blocked UDP, etc.).

## References

- `packages/reference-app-web/src/lib/optimystic.ts:168-186` (web transports + `/p2p-circuit` listen + debug hook `exposeDebugHook`)
- `packages/reference-app-rn/src/cadre-phone.ts:100-101` (RN transports/listen)
- `packages/cadre-core/src/cadre-node.ts:797-805` (`getRelayAddress`, existing `/p2p-circuit` multiaddr inspection — same predicate this ticket generalizes)
- libp2p `connectionManager.getConnections()` exposes `remoteAddr` (for `/p2p-circuit` detection) and per-connection transport tags.
- Related: `tickets/plan/web-webrtc-transport-to-bypass-relay.md` (consumer of this signal) and the optimystic-repo ticket `enable-dcutr-autonat-in-libp2p-node-base` (node↔node counterpart; lives in `../optimystic` tess).
