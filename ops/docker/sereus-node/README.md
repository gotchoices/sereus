## Docker: Sereus Node (Headless Optimystic Cadre Member)

This folder is intended to hold Docker (typically Docker Compose) resources for running a **headless Optimystic node** that can be added to a user's **cadre** (their personal infrastructure cluster that helps manage/store data).

### What it is
- A long-running node process providing storage/replication capacity and p2p connectivity on behalf of a user.
- Intended to be deployable on a server/NAS/always-on machine and “join” a cadre.

### What will live here
- `docker-compose.yml` (or multiple compose files for different environments)
- `.env.example` with required configuration knobs
- Optional helper scripts (build/run, log tailing, health checks)

### Notes
- The exact container image/entrypoint will depend on how Optimystic is packaged (and how cadre enrollment keys/identities are provisioned).


