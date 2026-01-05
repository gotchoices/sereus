## DNSADDR (recommended)

Goal: avoid hardcoding IPs and Peer IDs in clients by publishing **stable DNS names** that resolve to one or more concrete libp2p multiaddrs.

In apps/config, you can then refer to:
- `/dnsaddr/bootstrap.sereus.org`
- `/dnsaddr/relay.sereus.org`

### How DNS resolution works (in this repo)
libp2p’s DNSADDR resolver queries **TXT** records at:
- `_dnsaddr.<hostname>` (example: `_dnsaddr.relay.sereus.org`)

Each TXT record must contain:
- `dnsaddr=<multiaddr>`

The `<multiaddr>` must include `/p2p/<peerId>` so clients learn the peer identity.

### Example (single relay)
1) Point the hostname at the server:
- `A/AAAA`: `relay.sereus.org -> <server ip>`

2) Start the service and read the Peer ID from logs:
- look for `peerId=<PEER_ID>`

3) Publish TXT:
- **Name**: `_dnsaddr.relay.sereus.org`
- **Value**: `dnsaddr=/dns4/relay.sereus.org/tcp/<HOST_PORT>/p2p/<PEER_ID>`

Clients can now dial:
- `/dnsaddr/relay.sereus.org`

### Multiple nodes behind one DNS name
Add multiple TXT records under the same `_dnsaddr.<hostname>`:
- `_dnsaddr.relay.sereus.org = dnsaddr=/dns4/relay-1.sereus.org/tcp/<HOST_PORT_1>/p2p/<PEER_ID_1>`
- `_dnsaddr.relay.sereus.org = dnsaddr=/dns4/relay-2.sereus.org/tcp/<HOST_PORT_2>/p2p/<PEER_ID_2>`

This enables:
- adding capacity by adding TXT records
- removing compromised/dead nodes by removing TXT records
- no app redeploy required

### “One host, multiple hostnames” (common early-stage pattern)
Even if you initially run bootstrap+relay on the same machine:
- keep `bootstrap.sereus.org` and `relay.sereus.org` as separate names

That way you can split roles later without changing clients.


