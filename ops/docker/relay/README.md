## Docker: libp2p Relay Node (v2)

This folder runs a **libp2p Circuit Relay v2 “hop” node**. It helps peers connect when direct dialing is hard (NAT/firewall/mobile).

### What it is
- A relay helps peers connect when direct dialing is hard (NAT/firewall scenarios).
- Clients reserve relay slots and then use the relay as a rendezvous to establish routed connections.

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
cd /path/to/ser/sereus/ops/docker/relay
cp env.example env.local
docker compose --env-file env.local up -d --build
docker logs -f sereus_libp2p_relay
```

### Peer ID / key management
- The Peer ID is derived from a private key stored in a Docker volume at `KEY_FILE` (see `env.example`).
- Compose mounts a named volume (`relay_data`) at `/data`, so the Peer ID stays stable across restarts/upgrades.

Backup/restore (optional):
- Backup: stop the container and copy the key file out of the volume data dir.
- Restore: put the same key back at `KEY_FILE` before starting; the Peer ID will match.

### DNS (optional, recommended): publish `/dnsaddr/relay.sereus.org`
This repo’s libp2p DNSADDR resolver looks up TXT records at:
- `_dnsaddr.<hostname>` (e.g. `_dnsaddr.relay.sereus.org`)
- each TXT record must look like `dnsaddr=<multiaddr>`

Practical pattern:
- Create `A/AAAA` record: `relay.sereus.org -> <server ip>`
- After the node starts, read the Peer ID from logs and publish TXT:
  - **Name**: `_dnsaddr.relay.sereus.org`
  - **Value**: `dnsaddr=/dns4/relay.sereus.org/tcp/4001/p2p/<PEER_ID>`

Clients can then refer to the relay by domain:
- `/dnsaddr/relay.sereus.org`

To add capacity later, add more TXT records for additional relay nodes; no app redeploy needed.

### Start on reboot
- Compose uses `restart: unless-stopped` and Docker is enabled via `systemctl enable --now docker` (above), so the container comes back on host reboot.

### References
- Circuit Relay overview/spec pointers: `https://docs.libp2p.io/concepts/nat/circuit-relay/`


