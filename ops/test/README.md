## Ops tests: libp2p infra checks

Small, dependency-free scripts to validate that a remote libp2p node is reachable and behaves like a good neighbor (identify/ping and optionally DHT queries).

These scripts are meant for ops validation of:
- relay nodes
- bootstrap nodes
- combined bootstrap-relay nodes
- STUN servers (coturn) — see "STUN check" below

### Usage

From the repo root:

```bash
yarn workspace @serfab/ops-test check-node -- --target /dnsaddr/relay.sereus.org --relay
yarn workspace @serfab/ops-test check-node -- --target /dnsaddr/bootstrap.sereus.org --dht
yarn workspace @serfab/ops-test check-node -- --target /dnsaddr/bootstrap.sereus.org --dht --all
```

If your local DNS resolver can’t see the `_dnsaddr` record yet (propagation/caching), force DoH:

```bash
yarn workspace @serfab/ops-test check-node -- --target /dnsaddr/relay.sereus.org --relay --dns-mode doh
```

You can also pass a concrete multiaddr (must include `/p2p/<peerId>`), e.g.:

```bash
yarn workspace @serfab/ops-test check-node -- --target /ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
```

### What it checks
- connect/dial succeeds
- identify succeeds (protocols are learned)
- ping succeeds (RTT reported)
- optionally: DHT query succeeds (`dht.findPeer(<remotePeerId>)`)

### STUN check (coturn)
Validate a deployed **STUN** server (`ops/docker/coturn/`) by sending a STUN
Binding request and printing the mapped (server-reflexive) address it sees you
coming from — the address-discovery step a WebRTC peer uses to attempt a **direct**
connection.

```bash
yarn workspace @serfab/ops-test check-stun -- --host stun.sereus.org --port 3478
```

> Requires a **deployed, publicly reachable** STUN server — there is no local STUN
> server to bind against, so this is **not** runnable in CI / by agents. Run it
> manually after deploying coturn. A timeout almost always means UDP `3478` isn't
> reachable (firewall / security group) or the server isn't up.

### TURN credential check (turn-credential-issuer)
Validate the TURN credential scheme served by the dynamic ICE manifest
(`ops/docker/turn-credential-issuer/`). Two modes:

**Self-test (agent-runnable, no network)** — pins the credential scheme
(base64-not-base64url, `<expiry>:<id>` username, HMAC-SHA1 digest) against a fixed
vector and drives the TURN gating matrix:

```bash
yarn workspace @serfab/ops-test check-turn-creds -- --self-test
```

**Live check (requires a deployed issuer)** — fetch a deployed issuer's manifest,
assert a STUN entry is present, and (when a TURN entry is present) parse the
username as `<future-unix>:<id>` and, with `--secret`, re-derive the HMAC and
assert it matches the served credential:

```bash
yarn workspace @serfab/ops-test check-turn-creds -- \
  --url https://turn-issuer.sereus.org/ice-servers.json --secret <TURN_SECRET>
```

> The `--url` mode requires a **deployed, reachable** issuer — like the STUN check
> above, it is **not** runnable in CI / by agents. Run it manually after deploy. The
> `--self-test` mode needs neither network nor a build and is the in-CI floor that
> keeps the issuer and clients in sync.

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
yarn workspace @serfab/ops-test pair:listen -- \
  --relay /dnsaddr/relay.sereus.org \
  --bootstrap /dnsaddr/bootstrap.sereus.org

# Dialer machine (after copying printed PEER_ID from listener)
yarn workspace @serfab/ops-test pair:dial -- \
  --bootstrap /dnsaddr/bootstrap.sereus.org \
  --peer <LISTENER_PEER_ID>
```

#### Layered approach to testing (recommended)
Start simple, then add discovery:

1) **Explicit dial address** (tests the relay path + opening a protocol stream over the relay, no DHT discovery)
- Start the listener and copy the printed “copy/paste dial address (via relay)”
- Dialer:

```bash
yarn workspace @serfab/ops-test pair:dial -- \
  --bootstrap /dnsaddr/bootstrap.sereus.org \
  --dial-addr "<PASTE_FROM_LISTENER>"
```

2) **Relay synthesis fallback** (still no DHT discovery, but less copy/paste)

```bash
yarn workspace @serfab/ops-test pair:dial -- \
  --bootstrap /dnsaddr/bootstrap.sereus.org \
  --peer <LISTENER_PEER_ID> \
  --relay /dnsaddr/relay.sereus.org
```

3) **Bootstrap-only discovery** (goal state): dialer uses `dht.findPeer(<peerId>)` to discover a `p2p-circuit` address without `--relay`.
   - Note: peer routing can take a short time to “soak” on small overlays. If it fails immediately, retry after ~30–60 seconds while the listener remains running and connected to the bootstrap.

Troubleshooting:
- Add `--verbose` to listener/dialer to print resolved DNSADDR targets and other helpful info.
- If the dialer fails with `NO_RESERVATION`, it means the listener has not successfully reserved a slot on the relay yet.
- If you see “limited connection”: that is expected for relayed connections. This test pair explicitly:
  - opens the dialer stream with `runOnLimitedConnection: true`
  - registers the listener handler with `runOnLimitedConnection: true`
  because relay links are intentionally marked limited by libp2p.
- If you see `StreamResetError: stream reset` during the dialer write, it often means the listener rejected the inbound stream (e.g. handler not allowed on limited connections) or the relay could not open a STOP stream back to the listener (e.g. no active reservation/relay connection).
- A reservation is only valid while the listener maintains an active connection to the relay; the listener keeps this alive (best-effort) by periodically pinging the relay.

Optional checks:
- Add `--bootstrap-check` to `pair:dial` to explicitly validate the bootstrap node is responding to DHT queries (`dht.findPeer(bootstrapPeerId)`).


