----
description: To open a direct WebRTC connection between two NAT'd peers, a dialer needs to learn the listener's current relay (signaling) multiaddr from only its PeerId. FRET routes toward a PeerId's ring coordinate but does NOT resolve PeerId→multiaddrs today. Design a peer-record resolution layer (signed records, FRET- or CadrePeer-backed) so a peer's dialable/relay address can be discovered from its PeerId. Related to (but not blocked by) bootstrap-dht-discovery-and-strand-cohort-wiring; design coherently with it.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts
----

## Problem

WebRTC browser-to-browser (and any NAT-to-NAT direct upgrade) needs a **signaling channel**: the dialer connects to the listener through a relay, exchanges SDP, then the direct connection forms. That requires the dialer to know *which relay multiaddr the listener is currently reachable through*, given only the listener's PeerId. Today there is no mechanism to resolve that.

FRET — confirmed by inspecting `p2p-fret` — provides ring **routing** but is **not an address book**:

- Peers are placed on a 256-bit ring by `hashPeerId()` (`p2p-fret/src/ring/hash.ts:11`); `getNeighbors(coord, dir, k)` (`fret-service.ts:861`) and `iterativeLookup(key, …)` (`fret-service.ts:1233`) route toward the peers responsible for a coordinate.
- But `PeerEntry` stores `{id, coord, relevance, metadata, …}` with **no `multiaddrs` field** (`digitree-store.ts:6`), and `FretPeerDiscovery.scan()` dispatches discovery events with `multiaddrs: []` (`peer-discovery.ts:67`). Addresses are only populated by libp2p `identify` *after* a connection already exists.
- There is no `findPeer(peerId) → multiaddrs`. `listPeers()` / `getNeighbors()` return PeerIds only.

So FRET can route a *message* to (the neighbors of) a target PeerId's coordinate, but turning that into "here is the relay multiaddr to signal through" requires a **signed peer-record layer** on top. The architecture already states that nodes publish their reachable multiaddrs back to the `CadrePeer` table (`docs/architecture.md`), which is the other candidate substrate.

This is distinct from `bootstrap-dht-discovery-and-strand-cohort-wiring` (which seeds a strand's initial bootstrap list from cohort rows): that gets you *connected to a cohort*; this ticket is about *resolving an arbitrary member's current relay/signaling address from its PeerId* so a direct upgrade can be negotiated. They share substrate (`CadrePeer`) and should be designed coherently.

## Design questions to resolve in this pass

- **Where the record lives:** signed peer records published into FRET as a value keyed by the peer's ring coordinate, vs. the `CadrePeer` table (already authority-signed and replicated), vs. both (FRET for liveness/freshness, CadrePeer for durable membership). Trade-offs: FRET gives ring-local freshness without a DB round-trip; `CadrePeer` is already trusted and consistent but may be stale relative to a phone's churning relay reservation.
- **What the record contains:** PeerId, current relay/`/p2p-circuit` multiaddr(s) (from `CadreNode.getRelayAddress`), public direct addrs if reachable, a freshness timestamp, and a signature chained to the peer's control key (so a resolved address is trust-checkable, consistent with `seed-signerkey-trust-policy`).
- **Freshness/expiry:** a phone's relay reservation rotates; records need a TTL and a refresh-on-change path, and resolvers must prefer the freshest signed record.
- **Resolution API:** a `resolvePeerAddrs(peerId) → Multiaddr[]` surface on the node that callers (the WebRTC dial path) use before dialing, returning relay-prefixed signaling addresses.

## Expected behavior

- Given only a target member's PeerId and an existing cohort/control connection, a node can resolve one or more **current, signed, trust-checkable** multiaddrs (including a `/p2p-circuit` signaling address) for that peer, without a manual copy/paste of a relayed dial string (which is the current STATUS.md workaround).
- Records are refreshed when a peer's reachable addresses change and expire when stale; resolvers never hand back a dead relay reservation indefinitely.
- The resolution layer is transport-agnostic — it feeds the WebRTC dial path but does not itself depend on WebRTC.

## Use cases

- Two phones in the same cadre, neither publicly reachable: phone A resolves phone B's current relay multiaddr from B's PeerId, dials through it, and negotiates a direct WebRTC connection (relay drops out).
- Browser↔browser Tier-2: a browser tab resolves the signaling address of the peer it must reach for a `findCluster` pick, instead of stalling.
- Trust: a resolved address whose signing key isn't trusted per the seed/trust policy is rejected before dialing.

## References

- `p2p-fret/src/ring/hash.ts:11`, `src/store/digitree-store.ts:6`, `src/peer-discovery.ts:67`, `src/fret-service.ts:861,1233` (FRET routes but stores no multiaddrs)
- `packages/cadre-core/src/cadre-node.ts:797-805` (`getRelayAddress` — the address that must be published)
- `docs/STATUS.md:49-64` (admitted "bootstrap-only DHT discovery not working"; copy/paste relayed-dial workaround; FRET-vs-Kad-DHT consideration)
- `docs/architecture.md` (nodes publish multiaddrs back to `CadrePeer`; NAT-to-NAT seed includes relay addrs)
- Related: `tickets/plan/bootstrap-dht-discovery-and-strand-cohort-wiring.md`, `tickets/plan/seed-signerkey-trust-policy-self-asserting.md`, `tickets/backlog/4-relay-bootstrap-infrastructure.md`.
