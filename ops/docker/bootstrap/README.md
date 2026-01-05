## Docker: libp2p Bootstrap Node

This folder is intended to hold Docker (typically Docker Compose) resources for running a **libp2p bootstrap node**.

### What it is
- A bootstrap node is a **stable, well-known peer** that other peers can dial first to discover additional peers.
- It is **not** a Sereus “strand bootstrap” protocol implementation; it’s network bootstrapping / peer discovery.

### What will live here
- `docker-compose.yml` (or multiple compose files for different environments)
- `env.example` with required configuration knobs
- Optional helper scripts (build/run, log tailing, health checks)


