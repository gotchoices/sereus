## Quickstart: Run a combined bootstrap + relay node

Goal: run **one libp2p node** that provides both:
- bootstrap peer (discovery seed)
- relay v2 hop (connectivity assist)

This is intended for smaller deployments that want **one host** initially, but still keep DNS names flexible for future split-role deployments.

### Prereqs
- Docker + Docker Compose v2 installed (see `../README.md` → “Installing Docker (optional)”).
- DNS names you control (recommended): `bootstrap.sereus.org` and `relay.sereus.org`.

### Steps
From your ops root:

```bash
./sereus/ops/scripts/install docker bootstrap-relay
cd docker-bootstrap-relay
vi env.local
./svc up
./svc logs
```

Copy the `peerId=...` value from logs.

### Publish DNSADDR
Follow `../../docs/dnsaddr.md`. You can publish either (or both):
- `_dnsaddr.bootstrap.sereus.org` → points at this node
- `_dnsaddr.relay.sereus.org` → points at this node

Even if both TXT records point to the same node today, keeping two names lets you split roles later without changing clients.

### Validate
From the repo root:

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/bootstrap.sereus.org --dht --dns-mode doh
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay --dns-mode doh
```


