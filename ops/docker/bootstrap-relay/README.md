## Docker: Combined Bootstrap + Relay Node

This folder runs a **single libp2p node** that provides both roles:
- **Bootstrap peer**: a stable, well-known peer clients dial first for initial discovery
- **Relay v2 hop**: a relay service peers can reserve and use for connectivity assistance

This is useful for **small deployments** that want one host to provide both functions.

### How to deploy (Ubuntu)
Prereqs (one-time):

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

Deploy:

```bash
cd /path/to/ser/sereus/ops/docker/bootstrap-relay
cp env.example env.local
docker compose --env-file env.local up -d --build
docker logs -f sereus_libp2p_bootstrap_relay
```

### Peer ID / key management
- The Peer ID is derived from a private key stored in a Docker volume at `KEY_FILE` (see `env.example`).
- Compose mounts a named volume (`bootstrap_relay_data`) at `/data`, so the Peer ID stays stable across restarts/upgrades.

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


