## Ops / Docker

Docker-related operational resources for Sereus.

### Jump links
- Sereus deployment workflow: see **Installer (recommended)** below
- If you don’t have Docker installed: see **Installing Docker (optional)** at the bottom

### Contents
- `bootstrap/`: Docker Compose resources for running a **libp2p bootstrap node** (peer discovery seed).
- `relay/`: Docker Compose resources for running a **libp2p relay (v2) node** (connectivity assist/NAT traversal).
- `bootstrap-relay/`: A **combined bootstrap + relay node** (single process) for smaller deployments.
- `sereus-node/`: A **headless Optimystic node** intended to be added to a user's **cadre** (personal infrastructure cluster).

### Recommended production layout (site directories)

```text
<sereus-ops>/
  <repo>/               # git clone of ser (name is up to you)
  relay/                # site instance
  bootstrap/            # site instance
  bootstrap-relay/      # site instance
```

Each site instance folder typically contains:
- `env.local` (copied from the corresponding `env.example`)
- `svc` (symlink to `site-scripts/svc.sh`)
- `up` / `down` / `logs` (optional convenience symlinks to `svc`)
- `data/` (bind-mounted into the container; holds keys/state)

### Installer (recommended)
#### 0) Create an ops root and clone the repo

```bash
mkdir -p ~/sereus-ops
cd ~/sereus-ops
git clone <YOUR_SER_REPO_URL> sereus
```

#### 1) Scaffold a site instance directory (idempotent)

From your ops root (often `~/sereus-ops` or `/srv/sereus-ops`):

```bash
./sereus/ops/scripts/install docker relay
./sereus/ops/scripts/install docker bootstrap
./sereus/ops/scripts/install docker bootstrap-relay
```

This scaffolds `./docker-<service>/` instance folders with `env.local`, `up/down/logs`, and `data/`.

Notes:
- The clone directory does **not** have to be `sereus` — just run:
  - `./<your-clone-dir>/ops/scripts/install docker <service>`

#### 2) Start/stop/logs

```bash
cd docker-relay
vi env.local
./svc up
./svc logs
```

`env.local` (operator-facing knobs):
- `HOST_PORT`: host port to expose (container listens on 4001)
- `HOST_BIND_IP`: optional bind IP (default `0.0.0.0`)
- `HOST_DATA_DIR`: host directory for keys/state (default `./data`)
- `ANNOUNCE_ADDRS`: advanced; leave empty unless troubleshooting reachability

### Key persistence (Peer ID stability)
- See `../docs/keys.md`.

### DNSADDR (recommended)
- See `../docs/dnsaddr.md`.

### Ops tests
See `../test/README.md`.

### Installing Docker (optional)
If you already have Docker + Compose installed and working, you can skip this section.

#### Recommended: Docker Engine from Docker’s apt repo (Compose v2 plugin)
This avoids “Unable to locate package docker-compose-plugin” on some Ubuntu/Debian versions.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo ${VERSION_CODENAME}) stable" \
| sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker

docker --version
docker compose version
```

#### Alternative: Ubuntu packages only (Compose v1)
If you prefer distro packages and are okay using `docker-compose` (hyphen):

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo systemctl enable --now docker

docker --version
docker-compose --version
```


