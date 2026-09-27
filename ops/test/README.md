## Ops tests: libp2p infra checks

Small scripts to validate that a remote libp2p node is reachable and behaves like a good neighbor (identify/ping), plus standalone STUN and TURN-credential checks.

These scripts are meant for ops validation of:
- relay nodes
- STUN servers (coturn) — see "STUN check" below

### Usage

Commands below are written from an **ops root** — the directory holding the git
clone, named `sereus` here (see `../docker/README.md` → "Recommended production
layout"). Running from inside the repo instead, drop the leading `sereus/`.

`check-stun` and `check-turn-creds` use only Node's standard library and run as
they are. `check-node` needs libp2p, so install its dependencies once:

```bash
npm --prefix sereus/ops/test install
```

```bash
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.sereus.org --relay
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
- with `--relay`: the remote advertises the circuit-relay hop protocol (heuristic)

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

### Relayed reachability (NAT-to-NAT)

Two firewalled nodes reach each other through a **relay**: each reserves a slot and dials
the other's `/p2p-circuit/...` address. There is no separate discovery step to test — Sereus
has no global DHT; a joiner is handed a reachable node's multiaddr (direct or relay-routed)
out of band, or dials a known public node in the target strand. Validate the relay itself
with `check-node.mjs --relay` (above); the cadre/strand relay path is exercised by the
integration tests under `packages/integration-tests/` (e.g. `blind-relay-phone-to-phone-e2e`).


