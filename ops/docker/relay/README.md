## Docker: libp2p Relay Node (v2)

This folder runs a **libp2p Circuit Relay v2 “hop” node**. It helps peers connect when direct dialing is hard (NAT/firewall/mobile).

### What it is
- A relay helps peers connect when direct dialing is hard (NAT/firewall scenarios).
- Clients reserve relay slots and then use the relay as a rendezvous to establish routed connections.

### How to deploy (Ubuntu)
Use the common installer-driven workflow documented in `../README.md` (Ops/Docker).

Minimal relay-specific steps (from your ops root):

```bash
./sereus/ops/scripts/install docker relay
cd docker-relay
vi env.local
./svc up
./svc logs
```

### Peer ID / key management
See “Key persistence (Peer ID stability)” in `../README.md`.

### DNS (optional, recommended): publish `/dnsaddr/relay.sereus.org`
See “DNSADDR (recommended)” in `../README.md`.

### Start on reboot
Handled by the common workflow in `../README.md` (Docker enabled + `restart: unless-stopped`).

### References
- Circuit Relay overview/spec pointers: `https://docs.libp2p.io/concepts/nat/circuit-relay/`


