## ICE servers (STUN) for WebRTC

A relayed connection can upgrade to a direct WebRTC connection. The relay carries the
WebRTC signaling; what each peer also needs is its **server-reflexive address** — its
address as seen from outside its NAT — which it learns by asking a **STUN** server.

### Where STUN comes from: the relay
The relay image (`../docker/libp2p-infra/`) runs a STUN responder alongside the circuit
relay, on **UDP 3478** by default. There is no separate STUN service to deploy.

- Answers STUN Binding requests only (RFC 5389), with the requester's source address.
  Replies carry no optional attributes, so a reply is barely larger than the request and
  makes a poor traffic reflector.
- IPv4 only.
- `STUN_ENABLED=false` turns it off; `STUN_PORT` moves it inside the container or process.
  The docker stack publishes it as `HOST_STUN_PORT` (default `3478`).

### How clients find it
The reference apps derive one STUN server per configured relay: a relay address
`/dns4/relay.example.org/tcp/4011/ws/p2p/…` gives `stun:relay.example.org:3478`. The port
is always 3478, so a relay whose STUN is published on another port needs the apps to be
told explicitly:

| App | Override (comma-separated `stun:` URLs) |
| --- | --- |
| `reference-app-web` | `VITE_STUN_URLS` |
| `reference-app-rn` | `EXPO_PUBLIC_STUN_URLS` |

With no relay and no override, a node has no STUN server. That is degraded but safe: WebRTC
upgrades can then succeed only on host (LAN) candidates, and other connections stay on
the relay.

### Checking it
From a machine **other than** the relay host:

```bash
node sereus/ops/test/check-stun.mjs --host relay.example.org --port 3478
```

The mapped address it prints should be that machine's public IP. Docker's port mapping
(iptables DNAT) keeps the client's source address, which is what makes the answer
correct. Traffic that starts on the relay host itself goes through Docker's userland
proxy instead and shows the bridge gateway (`172.x.0.1`), so a check run there proves
nothing about real clients.

### Why there is no TURN
TURN relays media when a direct path cannot be found. Sereus already has a relay for that:
when a WebRTC upgrade fails, the connection simply stays on the circuit relay.

**That holds only while the relay is uncapped** (`RELAY_APPLY_DEFAULT_LIMIT` empty or
`false`, the default). A capped relay marks the connections it carries as *limited*, and
optimystic's database protocols refuse to run over limited connections — so on a capped
relay a failed upgrade leaves no data path at all. See
`../docker/libp2p-infra/README.md` → `RELAY_APPLY_DEFAULT_LIMIT`.
