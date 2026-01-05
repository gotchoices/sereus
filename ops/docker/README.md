## Ops / Docker

Docker-related operational resources for Sereus.

### Contents
- `bootstrap/`: Docker Compose resources for running a **libp2p bootstrap node** (peer discovery seed).
- `relay/`: Docker Compose resources for running a **libp2p relay (v2) node** (connectivity assist/NAT traversal).
- `bootstrap-relay/`: A **combined bootstrap + relay node** (single process) for smaller deployments.
- `sereus-node/`: A **headless Optimystic node** intended to be added to a user's **cadre** (personal infrastructure cluster).

### Recommended production layout (site directories)
These service folders are **reference implementations**. For production, keep site-specific files (env, scripts, data) outside the git clone:

```text
<sereus-ops>/
  repo/                 # git clone of ser
  relay/                # site instance
  bootstrap/            # site instance
  bootstrap-relay/      # site instance
```

Each site instance folder typically contains:
- `env.local` (copied from the corresponding `env.example`)
- `up.sh` / `down.sh` / `logs.sh` (copied from `site-scripts/`)
- `data/` (bind-mounted into the container; holds keys/state)

### Installer (recommended)
From your ops root (often `~/sereus-ops` or `/srv/sereus-ops`) after cloning the repo into `repo/`:

```bash
./repo/sereus/ops/scripts/install docker relay
./repo/sereus/ops/scripts/install docker bootstrap
./repo/sereus/ops/scripts/install docker bootstrap-relay
```

This scaffolds `./docker-<service>/` instance folders with `env.local`, `up/down/logs`, and `data/`.


