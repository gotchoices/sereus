## Ops tests: libp2p infra checks

Small scripts to validate that a remote libp2p node is reachable and behaves like a good neighbor (identify/ping), plus a standalone STUN check.

These scripts are meant for ops validation of:
- relay nodes
- the relay's STUN responder — see "STUN check" below

### Usage

Commands below are written from an **ops root** — the directory holding the git
clone, named `sereus` here (see `../docker/README.md` → "Recommended production
layout"). Running from inside the repo instead, drop the leading `sereus/`.

`check-stun` uses only Node's standard library and runs as it is. `check-node` needs libp2p, so install its dependencies once:

```bash
npm --prefix sereus/ops/test install
```

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay
```

If your local DNS resolver can’t see the `_dnsaddr` record yet (propagation/caching), force DoH:

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay --dns-mode doh
```

You can also pass a concrete multiaddr (must include `/p2p/<peerId>`), e.g.:

```bash
node sereus/ops/test/check-node.mjs --target /ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
```

The script dials raw TCP and WebSockets, so it can also check the `/ws` endpoint the
deployed image publishes — the only one a React Native client can reach. Worth checking
separately, since a node can be perfectly healthy on TCP while its WebSocket port is
unpublished or unannounced:

```bash
node sereus/ops/test/check-node.mjs --target /ip4/203.0.113.10/tcp/4011/ws/p2p/12D3KooW...
```

(`4011` is the relay stack's default `HOST_WS_PORT`; see `../docker/README.md`.)

### What it checks
- connect/dial succeeds
- identify succeeds (protocols are learned)
- ping succeeds (RTT reported)
- with `--relay`: the remote advertises the circuit-relay hop protocol (heuristic)

### STUN check
Validate the relay's **STUN** responder (or any STUN server) by sending a STUN
Binding request and printing the mapped (server-reflexive) address it sees you
coming from — the address-discovery step a WebRTC peer uses to attempt a **direct**
connection.

```bash
node sereus/ops/test/check-stun.mjs --host relay.sereus.org --port 3478
```

> **Run it from a machine other than the relay host.** The mapped address should be
> that machine's public IP. Run on the relay host itself, Docker answers through its
> userland proxy and you see the bridge gateway (`172.x.0.1`) instead — that is
> expected and says nothing about real clients. A timeout almost always means UDP
> `3478` isn't reachable (firewall / security group) or the relay isn't up.

### Relayed reachability (NAT-to-NAT)

Two firewalled nodes reach each other through a **relay**: each reserves a slot and dials
the other's `/p2p-circuit/...` address. There is no separate discovery step to test — Sereus
has no global DHT; a joiner is handed a reachable node's multiaddr (direct or relay-routed)
out of band, or dials a known public node in the target strand. Validate the relay itself
with `check-node.mjs --relay` (above); the cadre/strand relay path is exercised by the
integration tests under `packages/integration-tests/` (e.g. `blind-relay-phone-to-phone-e2e`).


