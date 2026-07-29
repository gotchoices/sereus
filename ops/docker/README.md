## Ops / Docker

Docker-related operational resources for Sereus.

### Jump links
- Sereus deployment workflow: see **Installer (recommended)** below
- If you don’t have Docker installed: see **Installing Docker (optional)** at the bottom

### Contents
- `bootstrap/`: Docker Compose resources for running a **libp2p bootstrap node** (peer discovery seed).
- `relay/`: Docker Compose resources for running a **libp2p relay (v2) node** (connectivity assist/NAT traversal).
- `bootstrap-relay/`: A **combined bootstrap + relay node** (single process) for smaller deployments.
- `sereus-node/`: **Pointer only** (see `sereus-node/README.md`). A headless cadre node belongs to one user's cadre rather than being shared infrastructure, so unlike the other folders here it has no `env.example`/`docker-compose.yml` and is not installable via `../scripts/install`. Its canonical Docker template ships with `@serfab/cadre-cli` at `../../packages/cadre-cli/docker/`.
- `coturn/`: A **STUN server** (optionally TURN) for WebRTC ICE assistance — lets browser/mobile peers form **direct** connections instead of relaying. Distinct purpose and distinct upstream image (`coturn/coturn`), not the shared `sereus-libp2p-infra:local` image. See `../docs/ice-servers.md`.
- `turn-credential-issuer/`: A tiny HTTP service that serves the **dynamic ICE-config manifest** (`/ice-servers.json`) — STUN-only when TURN is off, or STUN **plus** a freshly-minted short-lived coturn credential when TURN is on. Co-locate with `coturn/` (shares its `TURN_SECRET`). Builds its own local image (`sereus-turn-credential-issuer:local`). See `../docs/ice-servers.md`.

### Recommended production layout (site directories)

```text
<sereus-ops>/
  <repo>/               # git clone of ser (name is up to you)
  relay/                # site instance
  bootstrap/            # site instance
  bootstrap-relay/      # site instance
  coturn/               # site instance (STUN/TURN — ICE assistance)
  turn-credential-issuer/  # site instance (dynamic ICE manifest — co-located with coturn)
```

Each site instance folder typically contains:
- `env.local` (copied from the corresponding `env.example`)
- `svc` (symlink to `site-scripts/svc.sh`)
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
./sereus/ops/scripts/install docker coturn
./sereus/ops/scripts/install docker turn-credential-issuer
```

This scaffolds `./docker-<service>/` instance folders with `env.local`, `svc`, and `data/`.

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

### Getting your Peer ID (and what to put in DNS)
After `./svc up`, run:

```bash
./svc logs
```

You should see output like:
- `relay peerId=<PEER_ID>` (or `bootstrap peerId=...`)

Use that `<PEER_ID>` to publish DNSADDR TXT records (see `../docs/dnsaddr.md`).

`env.local` (operator-facing knobs):
- `HOST_PORT`: host port to expose (container listens on 4001). Defaults:
  - relay: `4001`
  - bootstrap: `4002`
  - bootstrap-relay: `4003`
- `HOST_BIND_IP`: optional bind IP (default `0.0.0.0`)
- `HOST_DATA_DIR`: host directory for keys/state (default `./data`)
- `ANNOUNCE_ADDRS`: advanced; leave empty unless troubleshooting reachability

`coturn` uses a different knob set (`STUN_PUBLIC_HOST`, `LISTENING_PORT=3478`, `TURN_ENABLED`, …) — see `coturn/env.example` and `coturn/README.md`.

### Image/build note
`relay`, `bootstrap`, and `bootstrap-relay` all run the same image (`sereus-libp2p-infra:local`) built from `ops/docker/libp2p-infra/`.

`coturn` is different: it **pulls** the upstream `coturn/coturn` image (no local build context). The installer's `env.example`→`env.local` + `svc` symlink flow is unchanged, but there is nothing to build — `./svc up` just pulls and runs.

`turn-credential-issuer` builds its **own** local image (`sereus-turn-credential-issuer:local`) from `turn-credential-issuer/` — a tiny dependency-free Node service (Node built-ins only). `./svc up` builds and runs it. It listens plain HTTP; front it with a TLS reverse proxy. See `turn-credential-issuer/README.md`.

### Key persistence (Peer ID stability)
- See `../docs/keys.md`.

### DNSADDR (recommended)
- See `../docs/dnsaddr.md`.

### Ops tests
See `../test/README.md`.

### Quickstarts
- `quickstarts/relay.md`: run a **public relay**
- `quickstarts/bootstrap.md`: run a **private bootstrap** peer (discovery seed)
- `quickstarts/bootstrap-relay.md`: run a **combined** bootstrap + relay node
- `quickstarts/coturn.md`: run a **public STUN server** (coturn) for WebRTC ICE assistance
- `quickstarts/turn-credential-issuer.md`: serve the **dynamic ICE manifest** + mint short-lived TURN credentials

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


