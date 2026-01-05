## Docker: Combined Bootstrap + Relay Node

This folder runs a **single libp2p node** that provides both roles:
- **Bootstrap peer**: a stable, well-known peer clients dial first for initial discovery
- **Relay v2 hop**: a relay service peers can reserve and use for connectivity assistance

This is useful for **small deployments** that want one host to provide both functions.

### How to deploy (Ubuntu)
This runbook assumes a production-oriented **site directory** layout so your config/keys live outside the git clone:

```text
<sereus-ops>/
  repo/                 # git clone of ser
  bootstrap-relay/      # site instance (this service)
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
mkdir -p bootstrap-relay
```

Initialize the bootstrap-relay site directory:

```bash
cd ~/sereus-ops/bootstrap-relay
cp ../repo/sereus/ops/docker/bootstrap-relay/env.example ./env.local
cp ../repo/sereus/ops/docker/site-scripts/{up.sh,down.sh,logs.sh} .
chmod +x up.sh down.sh logs.sh
```

Bring it up:

```bash
./up.sh
./logs.sh
```

### Peer ID / key management
- **You do not need to pre-generate keys.** On first start, the node will create a key (if missing) and write it to `KEY_FILE` (default: `/data/libp2p-private.key.pb`).
- The Peer ID is derived from that private key.
- This deployment mounts `./data` (your site directory) into the container as `/data`, so the Peer ID stays stable across restarts/upgrades.

### DNS (optional, recommended)
You can publish either (or both):
- `/dnsaddr/bootstrap.sereus.org` for “bootstrap list”
- `/dnsaddr/relay.sereus.org` for “relay list”

Even if both point at the same machine initially, keep them as **separate DNS names** so you can split roles later without redeploying apps.

TXT record rules:
- Record name: `_dnsaddr.<hostname>`
- Record value: `dnsaddr=<multiaddr>`

Example values (after you know the `<PEER_ID>`):
- `_dnsaddr.bootstrap.sereus.org` → `dnsaddr=/dns4/bootstrap.sereus.org/tcp/4001/p2p/<PEER_ID>`
- `_dnsaddr.relay.sereus.org` → `dnsaddr=/dns4/relay.sereus.org/tcp/4001/p2p/<PEER_ID>`

### Start on reboot
- Compose uses `restart: unless-stopped` and Docker is enabled via `systemctl enable --now docker` (above), so the container comes back on host reboot.

### References
- Circuit Relay overview/spec pointers: `https://docs.libp2p.io/concepts/nat/circuit-relay/`


