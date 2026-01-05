## Docker: Combined Bootstrap + Relay Node

This folder runs a **single libp2p node** that provides both roles:
- **Bootstrap peer**: a stable, well-known peer clients dial first for initial discovery
- **Relay v2 hop**: a relay service peers can reserve and use for connectivity assistance

This is useful for **small deployments** that want one host to provide both functions.

### How to deploy (Ubuntu)
Use the common installer-driven workflow documented in `../README.md` (Ops/Docker).

Minimal bootstrap-relay-specific steps (from your ops root):

```bash
./sereus/ops/scripts/install docker bootstrap-relay
cd docker-bootstrap-relay
vi env.local
./svc up
./svc logs
```

### Peer ID / key management
See “Key persistence (Peer ID stability)” in `../README.md`.

### DNS (optional, recommended)
You can publish either (or both):
- `/dnsaddr/bootstrap.sereus.org` for “bootstrap list”
- `/dnsaddr/relay.sereus.org` for “relay list”

Even if both point at the same machine initially, keep them as **separate DNS names** so you can split roles later without redeploying apps.

See “DNSADDR (recommended)” in `../README.md`.

### Start on reboot
Handled by the common workflow in `../README.md` (Docker enabled + `restart: unless-stopped`).

### References
- Circuit Relay overview/spec pointers: `https://docs.libp2p.io/concepts/nat/circuit-relay/`


