----
description: WebRTC needs STUN servers for ICE candidate gathering; there is no rtcConfiguration anywhere today. Provide self-hosted STUN (and a deliberate TURN policy) as deployable infrastructure so browser/mobile peers can discover reflexive addresses and form direct connections.
files: ops/docker/libp2p-infra
----

## Problem

The relay-reduction plan hinges on WebRTC for direct browser-to-browser and browser-to-node connectivity. WebRTC's ICE negotiation requires STUN to discover a peer's server-reflexive (public) address; without it, peers behind NAT cannot offer candidates that the other side can reach, and the connection falls back to a relay — defeating the purpose. There is currently **no `rtcConfiguration` / STUN / TURN configuration anywhere** in the monorepo.

This ticket provides the STUN/TURN infrastructure that `web-webrtc-transport-to-bypass-relay` (and later RN) consumes. It sits alongside `4-relay-bootstrap-infrastructure` in `ops/` — same deployment surface, distinct purpose (ICE assistance vs libp2p circuit relay).

## Requirements / specifications

- **Self-hosted STUN.** Stand up STUN (e.g. `coturn`) in `ops/`, reachable by browser and mobile clients, rather than depending on third-party public STUN (Google et al.) for a privacy-/sovereignty-oriented system. Multi-region is desirable but a single region is an acceptable v1.
- **Discoverable configuration.** Clients must obtain the ICE server list (STUN URLs, and TURN URLs+credentials if enabled) at runtime — consistent with how bootstrap/relay addresses are distributed — not hard-coded per build.
- **Deliberate TURN policy.** TURN is a relay by another name: a TURN-relayed media path consumes server bandwidth for the connection's lifetime, exactly the cost this whole effort is trying to remove. Decide explicitly whether TURN is offered at all; if it is, it must be treated as a true last resort and counted as "relayed" in the connectivity observability metrics (see `1-relay-usage-connectivity-observability`). Default position: STUN-first, TURN off or tightly gated.
- **Abuse controls.** Credential issuance / rate limiting for TURN if enabled, mirroring the relay-abuse concerns in `4-relay-bootstrap-infrastructure`.

## Use cases

- A browser behind a typical home NAT gathers a server-reflexive candidate via the self-hosted STUN and completes a direct WebRTC connection to another browser, with the circuit relay used only momentarily for SDP exchange.
- An operator deploys the STUN service from `ops/` alongside their relay/bootstrap node with a single documented procedure.
- A symmetric-NAT pair that genuinely cannot hole-punch is handled per the decided TURN policy, and the fallback is visible in metrics rather than silent.

## References

- `tickets/backlog/4-relay-bootstrap-infrastructure.md` (`ops/docker/libp2p-infra`, relay/bootstrap deployment, dnsaddr discovery, abuse prevention — same ops surface)
- `tickets/plan/web-webrtc-transport-to-bypass-relay.md` (primary consumer; needs `rtcConfiguration.iceServers`)
- `@libp2p/webrtc` transport accepts `rtcConfiguration` with `iceServers`.
- `ops/` per AGENTS.md is the home for libp2p relay/bootstrap operational tooling.
