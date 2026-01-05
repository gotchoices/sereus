## Docker: libp2p Bootstrap Node

This folder runs a **libp2p bootstrap peer**: a stable, well-known peer that other nodes dial first for initial discovery.

### What it is
- A bootstrap node is a **stable, well-known peer** that other peers can dial first to discover additional peers.
- It is **not** a Sereus “strand bootstrap” protocol implementation; it’s network bootstrapping / peer discovery.

### How to deploy (Ubuntu)
Prereqs (one-time):

- Install Docker + Compose plugin:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

- (Optional) allow your user to run docker without sudo:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

Deploy:

- On the server, copy this folder (or clone the repo) and run:

```bash
cd /path/to/ser/sereus/ops/docker/bootstrap
cp env.example env.local
docker compose --env-file env.local up -d --build
docker logs -f sereus_libp2p_bootstrap
```

### Peer ID / key management
- The Peer ID is derived from a private key stored in a Docker volume at `KEY_FILE` (see `env.example`).
- Compose mounts a named volume (`bootstrap_data`) at `/data`, so the Peer ID stays stable across restarts/upgrades.

### DNS (optional, recommended): publish `/dnsaddr/bootstrap.sereus.org`
TXT records are looked up at `_dnsaddr.<hostname>` and must look like `dnsaddr=<multiaddr>`.

Practical pattern:
- Create `A/AAAA` record: `bootstrap.sereus.org -> <server ip>`
- After the node starts, read the Peer ID from logs and publish TXT:
  - **Name**: `_dnsaddr.bootstrap.sereus.org`
  - **Value**: `dnsaddr=/dns4/bootstrap.sereus.org/tcp/4001/p2p/<PEER_ID>`

Clients can then refer to the bootstrap peer by domain:
- `/dnsaddr/bootstrap.sereus.org`

To add more bootstrap peers later, add more TXT records (and/or more hostnames).

### Start on reboot
- Compose uses `restart: unless-stopped` and Docker is enabled via `systemctl enable --now docker` (above), so the container comes back on host reboot.


