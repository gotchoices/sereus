## Quickstart: Run a public relay

Goal: run a **libp2p relay (Circuit Relay v2 hop)** on a public server, publish a stable `/dnsaddr/...` multiaddr, and keep the Peer ID stable across restarts.

### Prereqs
- Docker + Docker Compose v2 installed (see `../README.md` → “Installing Docker (optional)”).
- A DNS name you control (example: `relay.sereus.org`).

### Steps
From your ops root:

```bash
./sereus/ops/scripts/install docker relay
cd docker-relay
vi env.local
./svc up
./svc logs
```

Copy the `peerId=...` value from logs.

### Publish DNSADDR
Follow `../../docs/dnsaddr.md` and publish a TXT record at:
- `_dnsaddr.relay.sereus.org`

### Validate
From the repo root:

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay --dns-mode doh
```

### Key / Peer ID stability
- The Peer ID is derived from the persisted key in your instance `HOST_DATA_DIR` (default `./data`).
- Restarting the container should keep the Peer ID stable:

```bash
./svc down
./svc up
./svc logs
```


