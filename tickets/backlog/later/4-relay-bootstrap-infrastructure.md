----
description: Design relay network and bootstrap node deployment for NAT traversal
prereq:
files: ops/docker/libp2p-infra, packages/cadre-core/src/types.ts (network config), @libp2p/circuit-relay-v2
difficulty: hard
----
NAT'd nodes (phones) need relay servers to be reachable. The cadre system also needs stable bootstrap nodes as initial entry points for control networks.

### Relay network
- Deploy relay nodes in multiple regions for low-latency NAT traversal
- Rate limiting and abuse prevention to prevent relay abuse
- dnsaddr records for discovery (e.g., `_dnsaddr.relay.sereus.io`)
- The `ops/docker/libp2p-infra` directory contains container infrastructure for relay/bootstrap nodes

### Bootstrap nodes
- At minimum, one stable bootstrap node per deployment
- Can be a user's own server or provider-hosted
- Bootstrap nodes serve as initial peer discovery for new control networks
