## Docker: libp2p Relay Node (v2)

This folder is intended to hold Docker (typically Docker Compose) resources for running a **libp2p relay node** (Relay v2).

### What it is
- A relay helps peers connect when direct dialing is hard (NAT/firewall scenarios).
- Clients reserve relay slots and then use the relay as a rendezvous to establish routed connections.

### What will live here
- `docker-compose.yml` (or multiple compose files for different environments)
- `.env.example` with required configuration knobs
- Optional helper scripts (build/run, log tailing, health checks)


