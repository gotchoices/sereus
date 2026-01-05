## Docker: libp2p Bootstrap Node

This folder runs a **libp2p bootstrap peer**: a stable, well-known peer that other nodes dial first for initial discovery.

### What it is
- A bootstrap node is a **stable, well-known peer** that other peers can dial first to discover additional peers.
- It is **not** a Sereus “strand bootstrap” protocol implementation; it’s network bootstrapping / peer discovery.

### How to deploy (Ubuntu)
This runbook assumes a production-oriented **site directory** layout so your config/keys live outside the git clone:

```text
<sereus-ops>/
  repo/                 # git clone of ser
  bootstrap/            # site instance (this service)
    env.local
    up.sh / down.sh / logs.sh
    data/               # keys + state live here (bind-mounted into container)
```

Prereqs (one-time):

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

Create the ops layout:

```bash
mkdir -p ~/sereus-ops
cd ~/sereus-ops
git clone <YOUR_SER_REPO_URL> repo
mkdir -p bootstrap
```

Initialize the bootstrap site directory:

```bash
cd ~/sereus-ops/bootstrap
cp ../repo/sereus/ops/docker/bootstrap/env.example ./env.local
cp ../repo/sereus/ops/docker/site-scripts/{up.sh,down.sh,logs.sh} .
chmod +x up.sh down.sh logs.sh
```

Bring it up:

```bash
./up.sh
./logs.sh
```

### Peer ID / key management
- **You do not need to pre-generate keys.** On first start, the bootstrap node will create a key (if missing) and write it to `KEY_FILE` (default: `/data/libp2p-private.key.pb`).
- The Peer ID is derived from that private key.
- This deployment mounts `./data` (your site directory) into the container as `/data`, so the Peer ID stays stable across restarts/upgrades.

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


