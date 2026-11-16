# Publishing relay addresses with DNSADDR

A DNSADDR record lets a node be configured with a name, `/dnsaddr/relay.example.org/p2p/<PEER_ID>`, instead of a host, a port and a transport. The operator can then change a port, add a transport or move the relay to another IP address by editing DNS, without touching any node's configuration. This page is for the relay operator who creates the records.

Publishing DNSADDR records is optional. A node can also be configured with a full address such as `/dns4/relay.example.org/tcp/4011/ws/p2p/<PEER_ID>`.

Related: [relay runbook](../docker/README.md) · [identity key and peer ID](keys.md) · [STUN](ice-servers.md)

## How DNSADDR resolution works

To dial `/dnsaddr/<hostname>`, libp2p queries the TXT records at `_dnsaddr.<hostname>`. Each record holds `dnsaddr=<multiaddr>`, and the multiaddr must end in `/p2p/<peerId>`, so that the dialler learns which peer it should find there.

The dialler receives every record and uses the ones it has a transport for. When the dialled address itself ends in `/p2p/<PEER_ID>`, as a cadre node's relay address always does, libp2p keeps only the records for that peer ID.

## Records for one relay

### 1. Point the host name at the server

Create an A record for the relay's host name, and an AAAA record if the server has IPv6. A CNAME to another name that has those records also works.

| Name | Type | Value |
| --- | --- | --- |
| `relay.example.org` | `A` | `203.0.113.10` |
| `relay.example.org` | `AAAA` | `2001:db8::10` |

### 2. Get the peer ID

Start the relay and read the `relay peerId=<PEER_ID>` line from its log. The peer ID stays the same for as long as the relay keeps its key; see [`keys.md`](keys.md).

### 3. Publish one TXT record per transport

With the Docker stack, `./svc dns` prints the exact records. They are:

| Name | Type | Value |
| --- | --- | --- |
| `_dnsaddr.relay.example.org` | `TXT` | `dnsaddr=/dns4/relay.example.org/tcp/<HOST_PORT>/p2p/<PEER_ID>` |
| `_dnsaddr.relay.example.org` | `TXT` | `dnsaddr=/dns4/relay.example.org/tcp/<HOST_WS_PORT>/ws/p2p/<PEER_ID>` |

Both records have the same name and the same peer ID. Some DNS providers want only the part of the name inside the zone, here `_dnsaddr.relay`.

Publish both. Servers and desktop machines dial the TCP record. Phones and browsers have no raw-TCP transport and can use only the WebSocket record, so a relay that publishes only its TCP record cannot be reached by them.

### Publish the host port, not the container port

Each port in a record is the port reachable from outside: the `HOST_PORT` and `HOST_WS_PORT` values from the stack's `env.local` (defaults `4001` and `4011`), or the `PUBLIC_TCP_PORT` and `PUBLIC_WS_PORT` values when a router forwards different ports. The stack maps host port `4011` to container port `4002`, so the WebSocket record carries `4011`. A record that names `4002` resolves and nothing answers on it.

## Serving browsers over https

A browser page served over https cannot open a plain `ws` connection. To serve such pages:

1. Run a TLS reverse proxy in front of the relay's WebSocket port. It can listen on any port.
2. Publish a third TXT record under the same name: `dnsaddr=/dns4/relay.example.org/tcp/<TLS_PORT>/tls/ws/p2p/<PEER_ID>`. Add it only once the proxy is running.
3. Set `ANNOUNCE_ADDRS` on the relay so that it advertises the proxied address as well. `ANNOUNCE_ADDRS` replaces the whole advertised set, so list every address:

```bash
ANNOUNCE_ADDRS=/dns4/relay.example.org/tcp/4001,/dns4/relay.example.org/tcp/4011/ws,/dns4/relay.example.org/tcp/443/tls/ws
```

[`libp2p-infra/README.md`](../docker/libp2p-infra/README.md#advertised-addresses) explains how the relay chooses what it advertises.

## Several relays under one name

Several relays can publish under one `_dnsaddr.<hostname>`. Each relay contributes one record per transport, with its own host name and its own peer ID:

| Name | Type | Value |
| --- | --- | --- |
| `_dnsaddr.relay.example.org` | `TXT` | `dnsaddr=/dns4/relay-1.example.org/tcp/4011/ws/p2p/<PEER_ID_1>` |
| `_dnsaddr.relay.example.org` | `TXT` | `dnsaddr=/dns4/relay-2.example.org/tcp/4011/ws/p2p/<PEER_ID_2>` |

A cadre node's relay address names one relay's peer ID, so a node that should use both relays lists two addresses: `/dnsaddr/relay.example.org/p2p/<PEER_ID_1>` and `/dnsaddr/relay.example.org/p2p/<PEER_ID_2>`. DNS then decides how each relay is reached. It does not add a relay to a node that was not configured with that relay's peer ID.

Apps derive the STUN server from the name in the relay address, so the shared name (`relay.example.org`) also needs an A record that points at one of the relays; see [`ice-servers.md`](ice-servers.md#how-clients-find-it).

## Verifying the records

DNS changes take time to propagate, depending on the record's TTL. Check the host record and the TXT records:

```bash
dig +short relay.example.org A
dig +short relay.example.org AAAA
dig +short _dnsaddr.relay.example.org TXT
```

To ask a specific public resolver:

```bash
dig @1.1.1.1 +short _dnsaddr.relay.example.org TXT
```

Then dial every published record with `check-node.mjs --target /dnsaddr/relay.example.org --relay --all`; see [`../test/README.md`](../test/README.md).
