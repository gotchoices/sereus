## Docker: turn-credential-issuer (dynamic ICE manifest)

This folder runs a tiny Node HTTP service that serves the
**dynamic ICE-config manifest** (`/ice-servers.json`) Sereus WebRTC clients fetch
at startup. It is the missing piece that lets you turn on the self-hosted coturn
**TURN** relay: browsers and phones can't be handed long-lived TURN passwords, so
this service mints **short-lived, per-request** TURN credentials on demand.

### What it is (and what it is not)
- It serves the same JSON shape (`IceConfigManifest`) the static
  `../coturn/ice-servers.example.json` documents — but **per request**:
  - **TURN off** → STUN-only manifest (identical to the static example).
  - **TURN on** → STUN **plus** a TURN entry carrying a fresh
    `username`/`credential` pair valid for a few minutes (coturn `use-auth-secret`
    / REST-API scheme).
- The coturn `static-auth-secret` (`TURN_SECRET`) lives **only here**, co-located
  with coturn — never in a client bundle. The issuer signs; coturn verifies.
- It is **not** a TLS terminator and **not** a libp2p node. It listens plain HTTP;
  you front it with your existing reverse proxy (nginx/caddy), exactly like the
  relay/bootstrap nodes and the static manifest.
- It has **one runtime dependency**, `@libp2p/crypto` — the same library the
  clients sign with, used to verify peer assertions (below). Everything else is
  Node built-ins.

### Client wiring (the only client-side change)
The existing client helper `loadIceConfig()`
(`packages/reference-app-web/src/lib/ice-config.ts`, mirrored in
`packages/reference-app-rn/src/ice-config.ts`) already fetches a manifest URL and
passes through `username`/`credential`. So the **only** wiring needed is to point
the build-time env var at this service:
- web: `VITE_ICE_CONFIG_URL=https://turn-issuer.example.org/ice-servers.json`
- React Native: `EXPO_PUBLIC_ICE_CONFIG_URL=https://turn-issuer.example.org/ice-servers.json`

If you set `ISSUER_AUTH_TOKEN`, you can gate with **zero client change** by baking
the token into that URL: `…/ice-servers.json?token=<token>`.

### How to deploy (Ubuntu)
Use the common installer-driven workflow documented in `../README.md` (Ops/Docker).

```bash
./sereus/ops/scripts/install docker turn-credential-issuer
cd docker-turn-credential-issuer
vi env.local            # set STUN_URLS; if enabling TURN, set TURN_* (secret MUST match coturn)
./svc up
./svc logs
```

Then put a TLS reverse proxy in front (terminate HTTPS, forward to
`http://127.0.0.1:${ISSUER_PORT}`).

### Served surfaces
- `GET /ice-servers.json` — the dynamic manifest. Sends `Cache-Control: no-store`
  (a cached manifest would serve already-expired credentials) and CORS
  (`Access-Control-Allow-Origin`).
- `GET /healthz` — liveness, **no auth**, no credential, `200 {"ok":true}`.
- `OPTIONS *` — CORS preflight → `204` (so a future `Authorization`-header client
  doesn't break).
- Non-GET → `405`; unknown path → `404`.

### TURN gating matrix
A TURN entry is emitted **only** when **all** of these hold; otherwise the manifest
is STUN-only:

| Condition                         | Result                                  |
|-----------------------------------|-----------------------------------------|
| `TURN_ENABLED=false`              | STUN-only                               |
| `TURN_SECRET` empty               | STUN-only **+ loud warning** at boot    |
| `TURN_URLS` empty                 | STUN-only **+ loud warning** at boot    |
| `TURN_POLICY=off` (secret set)    | STUN-only (policy wins)                 |
| enabled + secret + URLs + `gated`/`on` | STUN **+ TURN** entry              |

`turnPolicy` is echoed in the manifest for operator/telemetry use; clients use
whatever `iceServers` entries are present.

### Authorization & abuse posture
Issuance is **never unbounded**, layered defense:
1. **Per-IP rate limit — always on** (`RATE_LIMIT_PER_MIN`, default 30/min,
   in-memory fixed-window). Approximate at window edges; state is per-process and
   lost on restart (two replicas have independent buckets) — acceptable because…
2. **Short TTL — always** (`CRED_TTL_SECONDS`, default 300, clamped `[60, 3600]`).
   A leaked credential self-expires fast.
3. **Optional bearer token** (`ISSUER_AUTH_TOKEN`) — recommended for production.
   Supplied via `Authorization: Bearer <token>` or `?token=<token>`; compared in
   constant time; a miss returns a generic `401` (never echoes the token).
4. **coturn quotas — the hard backstop.** `total-quota` / `user-quota` / `max-bps`
   (set in `../coturn/`) cap bandwidth/allocations regardless of how many
   credentials are minted.

For **per-node** attribution and allow/deny, see "Peer-bound issuance" below.

### Peer-bound issuance (`PEER_AUTH_MODE`)
The layers above bound abuse but bind a credential to **nobody**: a shared token
shipped in a browser bundle is effectively public, and per-IP limits are coarse
(carrier NAT, proxies). Peer-bound issuance closes that: a Sereus node signs a
short statement with the libp2p Ed25519 **identity key it already has**, the issuer
verifies it and derives the peer id, and that peer id becomes the credential's
`<id>` label — so the peer id in coturn's logs matches the one in relay logs.

The issuer **never trusts a client-supplied peer id**; it derives the id from the
presented public key and rebuilds the signed message with the derived value, so a
mismatch simply fails verification.

#### Wire format
Five request headers on `GET /ice-servers.json`. All values are ASCII and
header-safe by construction:

| Header | Value |
|---|---|
| `X-Sereus-Peer-Key`   | base64url of the libp2p **protobuf-encoded** Ed25519 public key (48 chars) |
| `X-Sereus-Peer-Aud`   | the audience string the client signed |
| `X-Sereus-Peer-Ts`    | issued-at, unix **seconds**, decimal digits |
| `X-Sereus-Peer-Nonce` | exactly 32 lowercase hex chars (16 random bytes) |
| `X-Sereus-Peer-Sig`   | base64url Ed25519 signature over the signed message |

The **signed message** is the UTF-8 bytes of exactly five LF-separated lines, no
trailing newline:

```
sereus.turn-issuer.v1
<audience>
<peerId>
<issuedAtUnixSeconds>
<nonce>
```

`<audience>` is the manifest URL the client fetched with **query and fragment
stripped** (e.g. `https://turn-issuer.example.org/ice-servers.json`); it binds the
assertion to one issuer so a harvested signature cannot be replayed elsewhere. Set
`PEER_AUTH_AUDIENCE` to that exact string. Line 1 is the domain tag — it is bumped
if any line's meaning changes.

**No challenge round trip.** The client picks the timestamp and nonce itself; the
issuer accepts `|now − issuedAt| ≤ PEER_AUTH_SKEW_SECONDS` and refuses a repeated
`(peerId, nonce)` inside that window. That is the same replay property a
server-minted challenge would buy, without shared state across replicas or an extra
round trip on every node start. The tradeoff: a device with a badly wrong clock is
rejected and falls back to the unauthenticated path.

#### Admission order
Gates run in this order; the first one that fires wins:

1. Shared bearer token (`ISSUER_AUTH_TOKEN`, when set) — miss → `401 unauthorized`.
2. Per-IP rate limit — over → `429 rate_limited` + `Retry-After: 60`. This runs
   **before** signature verification, so an unauthenticated flood cannot burn
   Ed25519 verification CPU.
3. `PEER_AUTH_MODE=off` → peer headers ignored; manifest carries `peerAuth: "off"`.
4. All five headers absent → unverified (see the table below).
5. Headers partially present, malformed, or over the length caps →
   `400 invalid_peer_assertion`.
6. Verification (key decodes, type is Ed25519, timestamp within skew,
   `(peerId, nonce)` unseen, audience matches when configured, signature verifies).
   Any failure → `401 invalid_peer_assertion`.
7. Deny list hit → `403 peer_denied`, before the per-peer bucket is touched.
8. Allow list non-empty and peer absent from it → `200` STUN-only,
   `peerAuth: "verified"`, no TURN entry. Verified-but-not-vetted is not an error.
9. Per-peer rate limit — over → `429 rate_limited` + `Retry-After: 60`.
10. Mint with `<id>` = peer id; manifest carries `peerAuth: "verified"` + `peerId`.

| `PEER_AUTH_MODE` | no assertion | valid assertion | invalid assertion |
|---|---|---|---|
| `off` | token + IP limit (as before) | headers ignored | headers ignored |
| `optional` | token + IP limit (as before) | peer-labelled TURN | 400 / 401 |
| `required` | `200` STUN-only | peer-labelled TURN | 400 / 401 |

`required` deliberately serves a STUN-only `200` rather than a `401` to an
assertion-less client: `loadIceConfig()` turns a non-OK response into `[]`, which
would strip STUN too and leave the node worse off than it needs to be.

The **TURN gating matrix above still wins over all of this**: if TURN is disabled,
the secret or URLs are empty, or `TURN_POLICY=off`, the manifest is STUN-only no
matter how good the assertion was.

#### Manifest additions
`peerAuth` (`"off"` | `"none"` | `"verified"`) and, when verified, `peerId`. Both
are purely informational — the client's `parseIceServers` reads only `iceServers`,
so older clients are unaffected.

#### Per-process state (the caveat that matters)
The replay cache and **both** rate limiters live in process memory, exactly like the
existing per-IP limiter. With two replicas behind a load balancer, each admits a
given replayed assertion once and each keeps its own per-peer counters. That is
bounded by the per-peer limit and by coturn's quotas, and is a deliberate trade
against needing shared state (Redis) in an ops service this small. `REPLAY_CACHE_MAX`
caps the cache; at the cap the issuer returns `503` rather than accept an unrecorded
nonce — it will **not** silently disable replay protection under load.

#### `<id>` semantics in coturn
Per-peer usernames change what appears in coturn's logs — nothing else. In
`use-auth-secret` mode the username already varies per mint (the expiry ticks), so
`user-quota` semantics are unchanged by peer labelling; `total-quota` / `max-bps`
remain the hard backstop.

#### Trying it by hand
Signing needs the node's Ed25519 identity key, so this is a sketch of the shape
rather than a copy-paste one-liner — the client signers do it for real:

```bash
curl -sS https://turn-issuer.example.org/ice-servers.json \
  -H "X-Sereus-Peer-Key:   $PEER_KEY_B64URL" \
  -H "X-Sereus-Peer-Aud:   https://turn-issuer.example.org/ice-servers.json" \
  -H "X-Sereus-Peer-Ts:    $(date +%s)" \
  -H "X-Sereus-Peer-Nonce: $(openssl rand -hex 16)" \
  -H "X-Sereus-Peer-Sig:   $SIG_B64URL"
```

The five headers are listed in `Access-Control-Allow-Headers`, so the browser
preflight (`OPTIONS` → `204`) passes. There is **no** `?query=` fallback for the
assertion fields: signatures in URLs land in proxy access logs.

### Reverse proxy & client IP (`TRUST_PROXY`)
Behind a proxy, the socket IP the service sees is the **proxy's**, which would
collapse every client into one rate-limit bucket. Set `TRUST_PROXY=true` and the
service reads the **last (rightmost)** hop of `X-Forwarded-For` — the IP your
immediate trusted proxy observed. This assumes **exactly one** trusted proxy hop.
- `TRUST_PROXY=true` with **no** real proxy → clients can spoof XFF to evade the
  limit.
- `TRUST_PROXY=false` **behind** a proxy → all clients share one bucket.

Pick the value that matches your topology.

### Clock requirement (NTP)
coturn accepts an allocation while `expiry >= now` measured on **coturn's** clock.
The issuer stamps `expiry = now + TTL` on **its** clock. Run **NTP on both** hosts
(usually the same host) so the two clocks agree; otherwise credentials expire early
(issuer ahead) or live too long (issuer behind). Choose a TTL with margin.

### Secret rotation
Out of scope to automate. coturn supports multiple overlapping `static-auth-secret`
lines; to rotate, add the new secret to coturn (keeping the old), switch the
issuer's `TURN_SECRET` to the new value, then remove the old coturn line after the
old TTL window has drained.

### Validate
The issuer's own self-test — pins the peer-assertion wire format against a fixed
vector and drives every row of the admission table (no network, no socket):

```bash
npm --prefix sereus/ops/docker/turn-credential-issuer install
npm --prefix sereus/ops/docker/turn-credential-issuer run selftest
```

A self-contained credential-scheme check (no network, agent-runnable), mirroring
the scheme from the operator-tooling side:

```bash
node sereus/ops/test/check-turn-creds.mjs --self-test
```

A live check against a deployed issuer:

```bash
node sereus/ops/test/check-turn-creds.mjs \
  --url https://turn-issuer.example.org/ice-servers.json --secret <TURN_SECRET>
```

See `../../test/README.md`.

### References
- ICE manifest + STUN-first policy: `../../docs/ice-servers.md`
- coturn (the relay this issues for): `../coturn/README.md`
- coturn REST API / `use-auth-secret`: `https://github.com/coturn/coturn`
