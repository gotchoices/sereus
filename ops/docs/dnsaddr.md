## DNSADDR (recommended)

Goal: avoid hardcoding IPs and Peer IDs in clients by publishing **stable DNS names** that resolve to one or more concrete libp2p multiaddrs.

In apps/config, you can then refer to:
- `/dnsaddr/relay.sereus.org`

Note: throughout this doc, `relay.sereus.org` is used as the worked example, but the **exact same DNSADDR pattern** applies to any infra hostname you publish.

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

**Publish one TXT record per transport the relay actually listens on.** A client
resolving `/dnsaddr/relay.sereus.org` receives *all* the records and dials the one it can
use: desktop/server peers dial `tcp`, while **React Native phones and browsers cannot dial
raw TCP** — they can only reach the relay over WebSockets (`/ws`, or `/wss` behind TLS).
The relay image listens on **both TCP and WebSockets** by default, so a relay that
publishes only its `tcp` record is unreachable to phones and browsers.

For the default relay, publish **two** records — same **Host/Name**, same **`<PEER_ID>`**,
differing only by transport/port:

| Host/Name | Type | Value |
| --- | --- | --- |
| `_dnsaddr.relay` | `TXT` | `dnsaddr=/dns4/relay.sereus.org/tcp/<HOST_PORT>/p2p/<PEER_ID>` |
| `_dnsaddr.relay` | `TXT` | `dnsaddr=/dns4/relay.sereus.org/tcp/<HOST_WS_PORT>/ws/p2p/<PEER_ID>` |

(Some DNS UIs want the full `_dnsaddr.relay.sereus.org` as the Host/Name.) Clients can now
dial `/dnsaddr/relay.sereus.org`.

> **Publish the HOST port, not the container port.** Each `<port>` above is the port
> reachable from *outside* the container — the `HOST_*` value from `env.local` (defaults:
> `HOST_PORT=4001` for TCP, `HOST_WS_PORT=4011` for WebSockets). The relay maps host `4011`
> → container `4002`, so the WebSocket record uses **4011**, not 4002. Publishing the
> container port is a common, silent mistake — the record resolves but nothing answers.

**Browsers on https / phones over the WAN need `wss`, not plain `ws`.** A browser on an
https page cannot dial insecure `ws` (mixed content). To serve those, front the relay with
your own TLS reverse proxy and publish a third record with the `/tls/ws` shape:
- **Value**: `dnsaddr=/dns4/relay.sereus.org/tcp/<TLS_PORT>/tls/ws/p2p/<PEER_ID>`

Add the `wss` record only once the TLS front is actually running, on whatever port that
front terminates on (it need not be 443 — the relay may co-locate with another web server).

### Multiple nodes behind one DNS name
This is a **separate axis** from the per-transport records above: transports advertise the
*same* node reached different ways, whereas the records below advertise *different* nodes.
They combine — each node publishes one record per transport it serves, all under the same
`_dnsaddr.<hostname>`.

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

If you want to query specific resolvers:

```bash
dig @1.1.1.1 +short _dnsaddr.relay.sereus.org TXT
dig @8.8.8.8 +short _dnsaddr.relay.sereus.org TXT
```


