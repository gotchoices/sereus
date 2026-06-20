## Docker: coturn (STUN / TURN)

This folder runs **coturn** as a **STUN** server (and, optionally, TURN). STUN lets
browser/mobile WebRTC peers discover their own public (server-reflexive) address so
they can form **direct** peer-to-peer connections instead of relaying every byte
through the libp2p circuit relay.

### What it is (and what it is not)
- **STUN** (default, always on): a tiny reflection service — a peer asks "what
  public IP/port do you see me coming from?" and uses the answer to negotiate a
  direct connection. Cheap; no media flows through it.
- **TURN** (off by default): a media **relay**. When two peers genuinely can't
  reach each other directly, TURN forwards their traffic — burning server
  bandwidth for the life of the connection. That is the exact cost the WebRTC
  effort removes, so TURN stays **off** until deliberately enabled. See the policy
  note in `../../docs/ice-servers.md`.
- This is **not** a libp2p relay. It pulls the upstream `coturn/coturn` image, not
  the `sereus-libp2p-infra:local` image the `relay`/`bootstrap` services build.

### How to deploy (Ubuntu)
Use the common installer-driven workflow documented in `../README.md` (Ops/Docker).

Minimal coturn-specific steps (from your ops root):

```bash
./sereus/ops/scripts/install docker coturn
cd docker-coturn
vi env.local            # set STUN_PUBLIC_HOST (and EXTERNAL_IP if behind 1:1 NAT)
./svc up
./svc logs
```

### Config model
`env.local` knobs feed `entrypoint.sh`, which renders `turnserver.conf` (the
template) into `/data/turnserver.active.conf` and starts coturn against it. The
entrypoint conditionally appends an `external-ip` line, the TURN block, and the
TLS block — see the comments in `turnserver.conf` and `entrypoint.sh`.

To eyeball the effective config without starting coturn:

```bash
COTURN_RENDER_ONLY=1 LISTENING_PORT=3478 HOST_BIND_IP=0.0.0.0 \
  COTURN_TEMPLATE=./turnserver.conf COTURN_ACTIVE_CONF=/tmp/active.conf \
  bash ./entrypoint.sh
```

### DNS: publish `stun.sereus.org`
STUN clients dial a plain hostname (not a DNSADDR multiaddr — coturn is not a
libp2p node). Publish an **A/AAAA** record:
- `stun.sereus.org -> <server public IP>`
- (when TURN is enabled) `turn.sereus.org -> <server public IP>`

Then advertise it to clients via the ICE manifest (`../../docs/ice-servers.md`),
**not** via the `_dnsaddr` TXT records used for libp2p infra.

### Enabling TURN (deliberate)
TURN is off for a reason. Before enabling it you need:
1. `TURN_ENABLED=true` + a strong `TURN_SECRET` (`openssl rand -hex 32`) + `TURN_REALM`.
2. The TURN relay port range published — uncomment the relay-range mapping in
   `docker-compose.yml`, or (recommended for production) switch that file to
   `network_mode: host`.
3. A credential-issuing endpoint to hand browsers time-limited credentials —
   **not built yet** (backlog: `turn-credential-issuance-service`). Until it
   exists, the manifest advertises STUN only.

The entrypoint refuses to start with `TURN_ENABLED=true` and an empty
`TURN_SECRET` (an auth-less TURN server is an open relay).

### Validate
A live STUN check needs a deployed, publicly reachable server:

```bash
node sereus/ops/test/check-stun.mjs --host stun.sereus.org --port 3478
```

It sends a STUN Binding request and prints your mapped (reflexive) address. See
`../../test/README.md`.

### Config parse check (requires Docker / a coturn binary)

Render the active config locally, then run coturn briefly against it:

```bash
# 1. Render
COTURN_RENDER_ONLY=1 LISTENING_PORT=3478 HOST_BIND_IP=0.0.0.0 \
  REALM=sereus TURN_ENABLED=true TURN_SECRET=fake-secret-for-validation \
  COTURN_TEMPLATE=./turnserver.conf COTURN_ACTIVE_CONF=/tmp/active.conf \
  bash ./entrypoint.sh

# 2. Binary check (Docker; kill after a second — we only need the parse output)
timeout 3 docker run --rm \
  -v /tmp/active.conf:/etc/coturn/turnserver.conf \
  coturn/coturn turnserver -c /etc/coturn/turnserver.conf 2>&1 | \
  grep -Ei '(error|warning|fatal|denied.peer|unknown|cannot)' || true
```

A clean parse shows only startup/bind lines; any `Unknown config option` or
`ERROR` line indicates a rejected directive (fix before enabling TURN).

### References
- coturn: `https://github.com/coturn/coturn`
- STUN: RFC 5389 / 8489 — TURN: RFC 5766 / 8656
- ICE manifest + STUN-first policy: `../../docs/ice-servers.md`
