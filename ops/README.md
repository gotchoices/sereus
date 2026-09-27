## Ops

This folder contains **operational tooling** for running Sereus-related services and nodes (locally, on a server, or in CI).

It is intentionally **runtime-focused** (bring-up, configuration, scripts, and runbooks), and is separate from:
- `../packages/` (published libraries and code)
- `../docs/` (design/protocol documentation)

### Contents
- `docker/`: Docker-focused resources (Compose stacks, helper scripts, image notes).
- `docs/`: Shared operational docs (DNSADDR, key management, backups).
- `systemd/`: Bare-server (non-Docker) scaffolds (early; pattern capture).
- `test/`: Ops tests for validating infra nodes (reachability, identify/ping).

### On discovery and "bootstrap"

Sereus has no global DHT, directory, or community board. Each strand is its own FRET ring.
To connect a firewalled node you either (a) go through a **relay**, or (b) dial a **known
public node already participating in the target strand**. There is no standalone "bootstrap"
node to run — a "bootstrap" is simply a reachable participating node's multiaddr that you
hand a joiner. (A former kad-DHT `bootstrap` role in `docker/` was removed once cadre-core
replaced kad-DHT with FRET.) So the one libp2p infra service worth operating is the **relay**.


