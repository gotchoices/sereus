## Docker: turn-credential-issuer (dynamic ICE manifest)

This folder runs a tiny, dependency-free Node HTTP service that serves the
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

A stronger libp2p-peer-id-bound issuance is filed as backlog
`turn-issuer-peer-bound-auth`.

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
A self-contained scheme check (no network, agent-runnable):

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
