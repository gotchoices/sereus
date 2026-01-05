## Docker: libp2p Bootstrap Node

This folder runs a **libp2p bootstrap peer**: a stable, well-known peer that other nodes dial first for initial discovery.

### What it is
- A bootstrap node is a **stable, well-known peer** that other peers can dial first to discover additional peers.
- It is **not** a Sereus “strand bootstrap” protocol implementation; it’s network bootstrapping / peer discovery.

### How to deploy (Ubuntu)
Use the common installer-driven workflow documented in `../README.md` (Ops/Docker).

Minimal bootstrap-specific steps (from your ops root):

```bash
./sereus/ops/scripts/install docker bootstrap
cd docker-bootstrap
vi env.local
./svc up
./svc logs
```

### Peer ID / key management
See “Key persistence (Peer ID stability)” in `../README.md`.

### DNS (optional, recommended): publish `/dnsaddr/bootstrap.sereus.org`
See “DNSADDR (recommended)” in `../README.md`.

### Start on reboot
Handled by the common workflow in `../README.md` (Docker enabled + `restart: unless-stopped`).


