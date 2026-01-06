## Quickstart: Run a private bootstrap node

Goal: run a **libp2p bootstrap peer** (discovery seed) and publish a stable `/dnsaddr/...` multiaddr.

### Prereqs
- Docker + Docker Compose v2 installed (see `../README.md` → “Installing Docker (optional)”).
- A DNS name you control (example: `bootstrap.sereus.org`).

### Steps
From your ops root:

```bash
./sereus/ops/scripts/install docker bootstrap
cd docker-bootstrap
vi env.local
./svc up
./svc logs
```

Copy the `peerId=...` value from logs.

### Publish DNSADDR
Follow `../../docs/dnsaddr.md` and publish a TXT record at:
- `_dnsaddr.bootstrap.sereus.org`

### Validate
From the repo root:

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/bootstrap.sereus.org --dht --dns-mode doh
```

### Key / Peer ID stability
Restarting the container should keep the Peer ID stable:

```bash
./svc down
./svc up
./svc logs
```


