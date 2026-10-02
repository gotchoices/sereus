## Ops / Docker

Docker-related operational resources for Sereus.

### Jump links
- Sereus deployment workflow: see **Installer (recommended)** below
- If you don’t have Docker installed: see **Installing Docker (optional)** at the bottom

### Contents
- `relay/`: Docker Compose resources for running a **libp2p relay (v2) node** (connectivity assist/NAT traversal) with a built-in **STUN responder**, so the same relay both carries relayed traffic and helps WebRTC peers upgrade to a direct connection (see `../docs/ice-servers.md`). This is the one shared libp2p infra service worth operating — Sereus has no global DHT to seed, so there is no standalone "bootstrap" node (a former kad-DHT `bootstrap` role was removed once cadre-core replaced kad-DHT with FRET).
- `sereus-node/`: **Pointer only** (see `sereus-node/README.md`). A headless cadre node belongs to one user's cadre rather than being shared infrastructure, so unlike the other folders here it has no `env.example`/`docker-compose.yml` and is not installable via `../scripts/install`. Its canonical Docker template ships with `@serfab/cadre-cli` at `../../packages/cadre-cli/docker/`.

### Recommended production layout (site directories)

```text
<sereus-ops>/
  <repo>/               # git clone of ser (name is up to you)
  relay/                # site instance
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
- `relay peerId=<PEER_ID>`

Use that `<PEER_ID>` to publish DNSADDR TXT records (see `../docs/dnsaddr.md`).

`env.local` (operator-facing knobs):
- `HOST_PORT`: host port for raw TCP (container listens on 4001). Default `4001`.
- `HOST_WS_PORT`: host port for WebSockets (container listens on 4002). Phones have
  no raw-TCP transport and can only reach a node here, so this is published by
  default too. Default `4011`.
- `HOST_STUN_PORT`: host UDP port for the STUN responder (container listens on 3478).
  Default `3478`; apps derive `stun:<relay host>:3478` from their relay address, so
  change it only if your apps are configured with an explicit STUN URL
- `HOST_BIND_IP`: optional bind IP (default `0.0.0.0`)
- `HOST_DATA_DIR`: host directory for keys/state (default `./data`)
- `LISTEN_ADDRS`: advanced; leave empty. Overrides the multiaddrs the container binds
  (default: raw TCP on 4001 plus WebSockets on 4002) — changing the ports here means
  changing `HOST_PORT`/`HOST_WS_PORT` and the compose mappings to match
- `PUBLIC_HOST`: recommended; the DNS name clients reach the relay at. The relay
  advertises its TCP and WebSocket listeners on this host and the `HOST_*` ports, instead
  of container-internal addresses no client can dial. Unset, it warns at startup
- `PUBLIC_TCP_PORT` / `PUBLIC_WS_PORT`: optional; the ports clients dial when something in
  front of the host changes them (e.g. a router forwarding 51234). Default: the `HOST_*` ports
- `ANNOUNCE_ADDRS`: advanced; overrides `PUBLIC_HOST` with an explicit list (e.g. a
  `/tls/ws` address behind a TLS front). If you set it, include the WebSocket address:
  a non-empty announce set replaces the advertised addresses, so announcing only TCP
  hides the WebSocket listener from phones. The container warns at startup when it is
  in that state
- `RELAY_APPLY_DEFAULT_LIMIT`: advanced; leave empty. Setting it to `true` re-applies libp2p's per-reservation cap and **breaks relayed cadre traffic** — see `libp2p-infra/README.md`
- `RELAY_MAX_RESERVATIONS`: advanced; concurrent reservation slots (default `500`)
- `STUN_ENABLED`: set `false` to turn off the STUN responder (default on)

### Image/build note
The `relay` runs the `sereus-libp2p-infra:local` image built from `ops/docker/libp2p-infra/`. That folder's `README.md` documents the image's own environment contract (`LISTEN_ADDRS`, `PUBLIC_*`, `ANNOUNCE_ADDRS`, `DATA_DIR`, the two `RELAY_*` knobs, the `STUN_*` knobs) — the site-level knobs above (`HOST_*`) are compose-level and never reach the container. `DATA_DIR` is the one image-level variable the stacks deliberately do not forward: it must stay at `/data`, which is where `HOST_DATA_DIR` is mounted.

### Key persistence (Peer ID stability)
- See `../docs/keys.md`.

### DNSADDR (recommended)
- See `../docs/dnsaddr.md`.

### Ops tests
See `../test/README.md`.

### Quickstarts
- `quickstarts/relay.md`: run a **public relay** (includes STUN)

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


