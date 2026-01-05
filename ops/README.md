## Ops

This folder contains **operational tooling** for running Sereus-related services and nodes (locally, on a server, or in CI).

It is intentionally **runtime-focused** (bring-up, configuration, scripts, and runbooks), and is separate from:
- `../packages/` (published libraries and code)
- `../docs/` (design/protocol documentation)

### Contents
- `docker/`: Docker-focused resources (Compose stacks, helper scripts, image notes).
- `systemd/`: Bare-server (non-Docker) scaffolds (early; pattern capture).
- `test/`: Ops tests for validating infra nodes (reachability, identify/ping, optional DHT).


