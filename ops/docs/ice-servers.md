# STUN for WebRTC upgrades

Two nodes connected through a relay can replace that connection with a direct WebRTC one. The relay carries the WebRTC signalling. Each node also needs its server-reflexive address, which is its address as seen from outside its NAT, and it learns that by asking a STUN server. This page covers where that STUN server is, how apps find it, how an operator checks it, and why Sereus runs no TURN server.

Related: [relay image reference](../docker/libp2p-infra/README.md) · [check scripts](../test/README.md) · [DNSADDR records](dnsaddr.md)

## Where STUN comes from: the relay

The relay process answers STUN itself, on UDP `3478` by default. There is no separate STUN service to deploy.

- **Binding requests only.** The responder answers a STUN Binding request (RFC 5389) with the requester's source address. The reply carries no optional attributes, so it is barely larger than the request and is of little use for traffic amplification.
- **IPv4 only.**
- **Settings.** `STUN_ENABLED=false` turns the responder off, and `STUN_PORT` changes the port the process binds. The Docker stack publishes the port as `HOST_STUN_PORT`.

## How clients find it

The reference apps derive one STUN server from each relay address they are configured with, using cadre-core's `resolveStunServers` (`packages/cadre-core/src/relay-stun.ts`). Both `/dns4/relay.example.org/tcp/4011/ws/p2p/…` and `/dnsaddr/relay.example.org/p2p/…` give `stun:relay.example.org:3478`.

Two consequences for the operator:

- **The name in the relay address must resolve to a relay.** For a DNSADDR name shared by several relays, give that name an A record that points at one of them.
- **The port is always `3478`.** A relay advertises only its libp2p listeners, so an app cannot discover a different STUN port. A relay that publishes STUN on another port needs each app to be told explicitly:

| App | Setting (comma-separated `stun:` URLs) |
| --- | --- |
| `reference-app-web` | `VITE_STUN_URLS` |
| `reference-app-rn` | `EXPO_PUBLIC_STUN_URLS` |

A node with no relay address and no explicit setting has no STUN server. No public STUN service is used as a fallback, so no third party learns of the node. A WebRTC upgrade can then use only the nodes' own interface addresses, which works between nodes on one local network, and every other connection stays on the relay.

## Checking it

From a machine other than the relay host:

```bash
node sereus/ops/test/check-stun.mjs --host relay.example.org --port 3478
```

The address it prints must be that machine's public IP address. Docker's port mapping keeps the client's source address for traffic that arrives from outside, which is what makes the answer correct. Traffic that starts on the relay host goes through Docker's userland proxy instead, and the responder sees the bridge gateway (`172.x.0.1`). A check run on the relay host therefore proves nothing about real clients.

## Why there is no TURN

A TURN server relays traffic when two peers cannot find a direct path. The circuit relay already does that: when a WebRTC upgrade fails, the connection stays on the relay.

This holds only while the relay runs without libp2p's per-connection limit, which is the default (`RELAY_APPLY_DEFAULT_LIMIT` empty or `false`). With the limit on, the relay resets each relayed connection after 128 KiB or two minutes, so a failed upgrade leaves no path that database traffic can use. See [Relay limits](../docker/libp2p-infra/README.md#relay-limits).
