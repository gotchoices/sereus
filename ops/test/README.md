# Checking a deployed relay

Two scripts that an operator runs from another machine to check a relay from outside: `check-node.mjs` dials the relay over libp2p, and `check-stun.mjs` queries its STUN responder. The [relay runbook](../docker/README.md#5-verify-from-another-machine) uses both as its last step.

## Setup

The commands on this page are written from an ops root, the directory that holds the clone as `sereus/`. From inside the repository, drop the leading `sereus/`.

`check-stun.mjs` uses only Node's standard library and needs no install. `check-node.mjs` needs libp2p; install its dependencies once:

```bash
npm --prefix sereus/ops/test install
```

Both scripts exit with a non-zero status when a check fails.

## `check-node.mjs`

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.example.org --relay --all
```

The script dials the target, waits for libp2p's identify exchange, and pings the peer. It prints the peer ID it connected to, the addresses and protocols the peer reported, and the ping round-trip time. A failed dial fails the check. A failed ping is reported and does not fail it.

| Option | Default | Meaning |
| --- | --- | --- |
| `--target` | required | A multiaddr that ends in `/p2p/<peerId>`, or `/dnsaddr/<hostname>`. |
| `--relay` | off | Also require that the peer lists a circuit-relay protocol. |
| `--all` | off | Test every address a `/dnsaddr/` target resolves to. Without it the script tests only the first. |
| `--timeout-ms` | `15000` | Deadline for the dial, and separately for the ping. |
| `--dns-mode` | `auto` | Resolver for `/dnsaddr/` targets: `system`, `doh` (DNS over HTTPS through Cloudflare and Google), or `auto`, which tries the system resolver and then DNS over HTTPS. |

Use `--all` with a `/dnsaddr/` target. A relay publishes one record per transport, and a relay can be healthy on TCP while its WebSocket port is closed or unpublished. Phones and browsers can reach only the WebSocket address.

To test one address, pass it in full. The script dials raw TCP and WebSocket addresses:

```bash
node sereus/ops/test/check-node.mjs --target /dns4/relay.example.org/tcp/4011/ws/p2p/12D3KooW... --relay
```

Pass `--dns-mode doh` when new TXT records are not yet visible to the local resolver.

## `check-stun.mjs`

```bash
node sereus/ops/test/check-stun.mjs --host relay.example.org --port 3478
```

The script sends one STUN Binding request and prints the address the server saw the request come from:

```text
stun ok: relay.example.org:3478 sees you at 198.51.100.7:53124 (IPv4)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--host` | required | Host name or IP address of the STUN server. |
| `--port` | `3478` | UDP port. |
| `--timeout-ms` | `5000` | How long to wait for the reply. |

Run it from a machine other than the relay host. The printed address must be that machine's public IP address. On the relay host itself the answer is Docker's bridge gateway (`172.x.0.1`), which says nothing about real clients; [`../docs/ice-servers.md`](../docs/ice-servers.md#checking-it) explains why. A timeout usually means that UDP `3478` is blocked by a firewall or that the relay is not running.

## Limits and accepted tradeoffs

- **`--relay` does not relay anything.** It passes when the protocol list from identify contains a circuit-relay protocol. It does not reserve a slot or send data through the relay, so a relay started with `RELAY_APPLY_DEFAULT_LIMIT=true`, which cannot carry cadre traffic, still passes. Confirm that setting from the `relay reservations: applyDefaultLimit=false` line in the relay's log (ticket `debt-relay-check-verifies-reservation-limits`).
- **`check-stun.mjs` is IPv4 only.** It sends over IPv4 and does not decode an IPv6 mapped address. The relay's STUN responder is IPv4 only as well.
