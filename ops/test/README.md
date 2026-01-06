## Ops tests: libp2p infra checks

Small, dependency-free scripts to validate that a remote libp2p node is reachable and behaves like a good neighbor (identify/ping and optionally DHT queries).

These scripts are meant for ops validation of:
- relay nodes
- bootstrap nodes
- combined bootstrap-relay nodes

### Usage

From the repo root:

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay
node sereus/ops/test/check-node.mjs --target /dnsaddr/bootstrap.sereus.org --dht
node sereus/ops/test/check-node.mjs --target /dnsaddr/bootstrap.sereus.org --dht --all
```

If your local DNS resolver can’t see the `_dnsaddr` record yet (propagation/caching), force DoH:

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay --dns-mode doh
```

You can also pass a concrete multiaddr (must include `/p2p/<peerId>`), e.g.:

```bash
node sereus/ops/test/check-node.mjs --target /ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
```

### What it checks
- connect/dial succeeds
- identify succeeds (protocols are learned)
- ping succeeds (RTT reported)
- optionally: DHT query succeeds (`dht.findPeer(<remotePeerId>)`)


