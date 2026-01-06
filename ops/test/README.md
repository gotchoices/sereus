## Ops tests: libp2p infra checks

Small, dependency-free scripts to validate that a remote libp2p node is reachable and behaves like a good neighbor (identify/ping and optionally DHT queries).

These scripts are meant for ops validation of:
- relay nodes
- bootstrap nodes
- combined bootstrap-relay nodes

### Usage

From the repo root:

```bash
yarn workspace @sereus/ops-test check-node -- --target /dnsaddr/relay.sereus.org --relay
yarn workspace @sereus/ops-test check-node -- --target /dnsaddr/bootstrap.sereus.org --dht
yarn workspace @sereus/ops-test check-node -- --target /dnsaddr/bootstrap.sereus.org --dht --all
```

If your local DNS resolver can’t see the `_dnsaddr` record yet (propagation/caching), force DoH:

```bash
yarn workspace @sereus/ops-test check-node -- --target /dnsaddr/relay.sereus.org --relay --dns-mode doh
```

You can also pass a concrete multiaddr (must include `/p2p/<peerId>`), e.g.:

```bash
yarn workspace @sereus/ops-test check-node -- --target /ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
```

### What it checks
- connect/dial succeeds
- identify succeeds (protocols are learned)
- ping succeeds (RTT reported)
- optionally: DHT query succeeds (`dht.findPeer(<remotePeerId>)`)

### Advanced: NAT-to-NAT test pair (bootstrap + relay)
Goal: validate a real-world scenario where **both devices are behind NAT/firewalls**:

- **Listener**: uses the **relay** to make itself reachable (via a `/p2p-circuit/...` address)
- **Dialer**: uses the **bootstrap node** (DHT) to discover how to reach the listener, knowing only:
  - the listener’s **Peer ID**
  - the **bootstrap address** (and optionally a relay address as a fallback)

Important notes:
- A “bootstrap node” is not a world-wide/global DHT. It’s just a peer that other nodes dial first to join a **specific overlay**.
- This test relies on **peer routing** (`dht.findPeer(peerId)`): the dialer asks the DHT for the listener’s `PeerInfo` (including addresses).
- For this to work behind NAT, the listener must acquire/advertise a **relayed address** that includes `p2p-circuit` via a reachable relay.

Scripts:
- Listener: `sereus/ops/test/relay-bootstrap-pair/listener.mjs`
- Dialer: `sereus/ops/test/relay-bootstrap-pair/dialer.mjs`

Run (on two devices):

```bash
# Listener machine
yarn workspace @sereus/ops-test pair:listen -- \
  --relay /dnsaddr/relay.sereus.org \
  --bootstrap /dnsaddr/bootstrap.sereus.org

# Dialer machine (after copying printed PEER_ID from listener)
yarn workspace @sereus/ops-test pair:dial -- \
  --bootstrap /dnsaddr/bootstrap.sereus.org \
  --peer <LISTENER_PEER_ID>
```

If `dht.findPeer(...)` doesn’t return a `p2p-circuit` address yet, pass `--relay /dnsaddr/relay.sereus.org` to the dialer as a fallback so it can synthesize:
`/dnsaddr/relay.sereus.org/p2p-circuit/p2p/<LISTENER_PEER_ID>`.


