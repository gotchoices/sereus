## DNSADDR (recommended)

Goal: avoid hardcoding IPs and Peer IDs in clients by publishing **stable DNS names** that resolve to one or more concrete libp2p multiaddrs.

In apps/config, you can then refer to:
- `/dnsaddr/bootstrap.sereus.org`
- `/dnsaddr/relay.sereus.org`

Note: throughout this doc, `relay.sereus.org` is used as the worked example, but the **exact same DNSADDR pattern** applies to any infra hostname (including `bootstrap.sereus.org`).

### How DNS resolution works (in this repo)
libp2p’s DNSADDR resolver queries **TXT** records at:
- `_dnsaddr.<hostname>` (example: `_dnsaddr.relay.sereus.org`)

Each TXT record must contain:
- `dnsaddr=<multiaddr>`

The `<multiaddr>` must include `/p2p/<peerId>` so clients learn the peer identity.

### Example (single relay)
1) Point the hostname at the server (Namecheap-style)

You generally want `relay.sereus.org` to resolve to the server’s public IP:
- If your server has **IPv4**: create an **A** record
- If your server has **IPv6**: create an **AAAA** record
- If you already have another hostname pointing at the same server (e.g. `relay-1.sereus.org`) and you want `relay.sereus.org` to follow it: create a **CNAME** record pointing to that hostname

Examples:
- **A**: `relay.sereus.org -> 203.0.113.10`
- **AAAA**: `relay.sereus.org -> 2001:db8::10`
- **CNAME**: `relay.sereus.org -> relay-1.sereus.org`

Notes:
- A CNAME points to another name; you still need an A/AAAA somewhere in the chain.
- Many operators use A (and optional AAAA) for simplicity/stability.

2) Start the service and read the Peer ID from logs:
- look for `peerId=<PEER_ID>`

3) Publish the DNSADDR TXT record(s)

The libp2p DNSADDR resolver queries TXT records at:
- `_dnsaddr.relay.sereus.org`

For a single relay, publish **one TXT record**:
- **Host/Name**: `_dnsaddr.relay` (some UIs want the full `_dnsaddr.relay.sereus.org`)
- **Type**: `TXT`
- **Value**: `dnsaddr=/dns4/relay.sereus.org/tcp/<HOST_PORT>/p2p/<PEER_ID>`

Clients can now dial:
- `/dnsaddr/relay.sereus.org`

Notes:
- Use the **host port** you configured (`HOST_PORT` in `env.local`), not the container-internal port.

Bootstrap example:
- **Host/Name**: `_dnsaddr.bootstrap`
- **Type**: `TXT`
- **Value**: `dnsaddr=/dns4/bootstrap.sereus.org/tcp/<HOST_PORT>/p2p/<PEER_ID>`

### Multiple nodes behind one DNS name
Add multiple TXT records under the same `_dnsaddr.<hostname>`:
- `_dnsaddr.relay.sereus.org = dnsaddr=/dns4/relay-1.sereus.org/tcp/<HOST_PORT_1>/p2p/<PEER_ID_1>`
- `_dnsaddr.relay.sereus.org = dnsaddr=/dns4/relay-2.sereus.org/tcp/<HOST_PORT_2>/p2p/<PEER_ID_2>`

Practical DNS UI guidance:
- This is **multiple TXT records** with the **same Host/Name** (`_dnsaddr.relay`) but different Values.
- Add one TXT record per relay node you want clients to be able to dial.

This enables:
- adding capacity by adding TXT records
- removing compromised/dead nodes by removing TXT records
- no app redeploy required

### Verify DNS is working (dig)
After you save DNS changes, it may take time to propagate (depending on TTL and Namecheap timing).

Check the host record:

```bash
dig +short relay.sereus.org A
dig +short relay.sereus.org AAAA
```

Check the DNSADDR TXT record(s):

```bash
dig +short _dnsaddr.relay.sereus.org TXT
```

Bootstrap equivalents:

```bash
dig +short bootstrap.sereus.org A
dig +short _dnsaddr.bootstrap.sereus.org TXT
```

If you want to query specific resolvers:

```bash
dig @1.1.1.1 +short _dnsaddr.relay.sereus.org TXT
dig @8.8.8.8 +short _dnsaddr.relay.sereus.org TXT
```

### “One host, multiple hostnames” (common early-stage pattern)
Even if you initially run bootstrap+relay on the same machine:
- keep `bootstrap.sereus.org` and `relay.sereus.org` as separate names

That way you can split roles later without changing clients.


