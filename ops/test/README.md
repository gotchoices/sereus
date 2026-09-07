## Ops tests: libp2p infra checks

Small scripts to validate that a remote libp2p node is reachable and behaves like a good neighbor (identify/ping and optionally DHT queries), plus standalone STUN and TURN-credential checks.

These scripts are meant for ops validation of:
- relay nodes
- bootstrap nodes
- combined bootstrap-relay nodes
- STUN servers (coturn) — see "STUN check" below

### Usage

Commands below are written from an **ops root** — the directory holding the git
clone, named `sereus` here (see `../docker/README.md` → "Recommended production
layout"). Running from inside the repo instead, drop the leading `sereus/`.

`check-stun` and `check-turn-creds` use only Node's standard library and run as
they are. `check-node` and the `relay-bootstrap-pair` scripts need libp2p, so
install their dependencies once:

```bash
npm --prefix sereus/ops/test install
```

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

The script dials raw TCP and WebSockets, so it can also check the `/ws` endpoint the
deployed image publishes — the only one a React Native client can reach. Worth checking
separately, since a node can be perfectly healthy on TCP while its WebSocket port is
unpublished or unannounced:

```bash
node sereus/ops/test/check-node.mjs --target /ip4/203.0.113.10/tcp/4011/ws/p2p/12D3KooW...
```

(`4011` is the relay stack's default `HOST_WS_PORT`; see `../docker/README.md`.)

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
node sereus/ops/test/check-stun.mjs --host stun.sereus.org --port 3478
```

> Requires a **deployed, publicly reachable** STUN server — there is no local STUN
> server to bind against, so this is **not** runnable in CI / by agents. Run it
> manually after deploying coturn. A timeout almost always means UDP `3478` isn't
> reachable (firewall / security group) or the server isn't up.

### TURN credential check (turn-credential-issuer)
Validate the TURN credential scheme served by the dynamic ICE manifest
(`ops/docker/turn-credential-issuer/`). Two modes:

**Self-test (agent-runnable, no network)** — pins the credential scheme
(base64-not-base64url, `<expiry>:<id>` username, HMAC-SHA1 digest) against fixed
vectors and drives the TURN gating matrix. Two `<id>` forms are pinned: the plain
`CRED_ID` label and the base58btc **peer id** label used by peer-bound issuance
(which must survive the sanitizer byte-for-byte, or attribution silently breaks):

```bash
node sereus/ops/test/check-turn-creds.mjs --self-test
```

> Signature verification for peer assertions is **not** mirrored here — that needs
> `@libp2p/crypto` and lives in the issuer's own self-test:
> `npm --prefix sereus/ops/docker/turn-credential-issuer run selftest`.

**Live check (requires a deployed issuer)** — fetch a deployed issuer's manifest,
assert a STUN entry is present, and (when a TURN entry is present) parse the
username as `<future-unix>:<id>` and, with `--secret`, re-derive the HMAC and
assert it matches the served credential:

```bash
node sereus/ops/test/check-turn-creds.mjs \
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
node sereus/ops/test/relay-bootstrap-pair/listener.mjs \
  --relay /dnsaddr/relay.sereus.org \
  --bootstrap /dnsaddr/bootstrap.sereus.org

# Dialer machine (after copying printed PEER_ID from listener)
node sereus/ops/test/relay-bootstrap-pair/dialer.mjs \
  --bootstrap /dnsaddr/bootstrap.sereus.org \
  --peer <LISTENER_PEER_ID>
```

#### Layered approach to testing (recommended)
Start simple, then add discovery:

1) **Explicit dial address** (tests the relay path + opening a protocol stream over the relay, no DHT discovery)
- Start the listener and copy the printed “copy/paste dial address (via relay)”
- Dialer:

```bash
node sereus/ops/test/relay-bootstrap-pair/dialer.mjs \
  --bootstrap /dnsaddr/bootstrap.sereus.org \
  --dial-addr "<PASTE_FROM_LISTENER>"
```

2) **Relay synthesis fallback** (still no DHT discovery, but less copy/paste)

```bash
node sereus/ops/test/relay-bootstrap-pair/dialer.mjs \
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
- Add `--bootstrap-check` to the dialer to explicitly validate the bootstrap node is responding to DHT queries (`dht.findPeer(bootstrapPeerId)`).


