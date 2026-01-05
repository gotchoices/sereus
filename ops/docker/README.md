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
#### 0) Prereqs (Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

#### 1) Create an ops root and clone the repo

```bash
mkdir -p ~/sereus-ops
cd ~/sereus-ops
git clone <YOUR_SER_REPO_URL> repo
```

#### 2) Scaffold a site instance directory (idempotent)

From your ops root (often `~/sereus-ops` or `/srv/sereus-ops`):

```bash
./repo/sereus/ops/scripts/install docker relay
./repo/sereus/ops/scripts/install docker bootstrap
./repo/sereus/ops/scripts/install docker bootstrap-relay
```

This scaffolds `./docker-<service>/` instance folders with `env.local`, `up/down/logs`, and `data/`.

#### 3) Start/stop/logs

```bash
cd docker-relay
vi env.local
./up
./logs
```

### Key persistence (Peer ID stability)
- You do **not** need to generate keys up front.
- On first start, each service generates a libp2p private key and writes it to `KEY_FILE` (see `env.local`).
- `./data/` is bind-mounted into the container as `/data`, so the key persists across reboots/upgrades.
- If you delete `./data/`, the Peer ID will change.

### DNSADDR (recommended)
To avoid hardcoding IPs/Peer IDs in clients, publish `/dnsaddr/<name>` and manage the backing multiaddrs via DNS TXT records.

Resolver behavior (in this repo):
- lookup name: `_dnsaddr.<hostname>` (e.g. `_dnsaddr.relay.sereus.org`)
- TXT value format: `dnsaddr=<multiaddr>`

Example pattern:
- `A/AAAA`: `relay.sereus.org -> <server ip>`
- `TXT`: `_dnsaddr.relay.sereus.org = dnsaddr=/dns4/relay.sereus.org/tcp/4001/p2p/<PEER_ID>`

Clients can then use:
- `/dnsaddr/relay.sereus.org`

### Ops tests
See `../test/README.md`.


