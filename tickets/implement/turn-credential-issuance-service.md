----
description: When an operator turns on the self-hosted TURN relay, browsers and phones need short-lived TURN passwords they can't be handed in advance. Build a small server that mints those time-limited credentials on request and hands clients a ready-to-use ICE-server list, advertising TURN only when it's actually switched on.
prereq: turn-ssrf-peer-deny-hardening
files: ops/docker/coturn/turnserver.conf, ops/docker/coturn/entrypoint.sh, ops/docker/coturn/env.example, ops/docker/coturn/README.md, ops/docker/coturn/ice-servers.example.json, ops/docs/ice-servers.md, ops/docker/README.md, ops/scripts/install, ops/test/check-stun.mjs, ops/test/package.json, packages/reference-app-web/src/lib/ice-config.ts
difficulty: medium
----

## Summary

Build a tiny operator-hosted HTTP service — `ops/docker/turn-credential-issuer/` —
that serves a **dynamic ICE-config manifest**. When the operator has enabled the
coturn TURN relay, each manifest fetch carries a freshly-minted, short-lived TURN
credential (coturn `use-auth-secret` / REST-API scheme); when TURN is off, the
manifest is STUN-only. The shared `static-auth-secret` lives only in the issuer
(co-located with coturn), never in a client bundle.

The key insight that keeps this small: the existing browser/RN client helper
(`loadIceConfig()` in `packages/reference-app-web/src/lib/ice-config.ts`, mirrored
in `packages/reference-app-rn/src/ice-config.ts`) already (a) fetches a manifest
URL at startup, (b) passes through `username`/`credential` on each entry, and (c)
uses whatever `iceServers` are present. So pointing `VITE_ICE_CONFIG_URL` /
`EXPO_PUBLIC_ICE_CONFIG_URL` at the issuer's `/ice-servers.json` is the **only**
client-side wiring needed — **no functional change to `ice-config.ts`** (only a
doc-comment update; see TODO). The issuer simply replaces the static
`ice-servers.json` file with a per-request-signed equivalent.

## Why an ops Node service (design resolution)

The plan ticket left the home open ("could live in `ops/`, or be folded into an
existing operator surface"). Resolved: a **standalone Node service under
`ops/docker/turn-credential-issuer/`**, mirroring `ops/docker/libp2p-infra/`
(node:22-alpine multi-stage `Dockerfile`, `tsc` build, `docker-compose.yml`,
`env.example`, `README.md`, `svc`/`install` integration).

Rationale:
- The `static-auth-secret` (coturn `TURN_SECRET`) is **operator infrastructure**,
  not application config. It must sit next to the coturn deployment, not be
  threaded into `packages/reference-app-*`. Folding issuance into `cadre-host`
  (the self-hosted manager) would couple a security-sensitive relay secret into an
  app package with a different audience and lifecycle.
- The manifest is already documented as "operator-hosted, plain HTTPS, alongside
  the relay/ops infra" (`ops/docs/ice-servers.md` → "Where to host it"). A dynamic
  manifest server is the natural evolution of that static file.
- Co-location with coturn means one `env.local` can carry both `TURN_SECRET` and
  the issuer config; the operator enables TURN in exactly one place.

## Authorization model (design resolution)

The plan required "no anonymous unbounded issuance" + per-client rate-limiting +
short TTL, mirroring the relay-abuse posture of `4-relay-bootstrap-infrastructure`.
There is **no existing authenticated-session identity** for web/RN clients against
an operator endpoint in this repo (cadre nodes have libp2p peer keys, but the web
app's relationship to an ops endpoint is unauthenticated). Resolved with a
layered, defensible default — issuance is **never unbounded**, even with no token:

1. **Per-IP rate limit — ALWAYS on.** Fixed-window (default 30 issuances / IP /
   minute, configurable). This alone makes issuance bounded.
2. **Short TTL — ALWAYS.** Default 300 s (5 min), max enforced (e.g. ≤ 3600 s). A
   leaked credential self-expires quickly.
3. **Optional bearer token — recommended for production.** When
   `ISSUER_AUTH_TOKEN` is set, the issuer requires it (via `Authorization: Bearer
   <token>` **or** `?token=` query param — the latter lets operators gate with zero
   client change by baking the token into the configured manifest URL). When unset,
   the endpoint is rate-limited-but-open (fine for a closed/trusted deployment).
4. **coturn server-side quotas — the hard backstop.** `total-quota` / `user-quota`
   / `max-bps` (already wired in `turnserver.conf`) cap bandwidth/allocations
   regardless of how many credentials are minted, so even a flood of valid
   credentials cannot exceed the operator's bandwidth ceiling.

A stronger **libp2p-peer-id-bound** issuance (client signs a challenge with its
node key so credentials are tied to a known peer) is genuinely better but crosses
into app packages and a challenge protocol — out of scope here, filed as backlog
`turn-issuer-peer-bound-auth`.

## Credential scheme (coturn REST API / `use-auth-secret`)

coturn validates ephemeral credentials as:
- `username = "<unixExpiryEpochSeconds>:<id>"` — `<id>` is an opaque label (e.g.
  `web`); sanitize it so it can never contain `:`.
- `credential = base64( HMAC_SHA1( static_auth_secret, username ) )` — **standard**
  base64 (with padding), **not** base64url. coturn rejects a mismatch.
- coturn accepts the allocation while `unixExpiry >= now` (server clock). So the
  issuer and coturn MUST share a clock (NTP) — document it; choose TTL with margin.

Node implementation (single function, unit-testable):

```ts
import { createHmac } from 'node:crypto'

interface TurnCredential { username: string; credential: string; ttl: number }

function mintTurnCredential(secret: string, id: string, ttlSeconds: number, nowSec: number): TurnCredential {
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, '') || 'client'
  const expiry = nowSec + ttlSeconds
  const username = `${expiry}:${safeId}`
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential, ttl: ttlSeconds }
}
```

## Served surfaces

- `GET /ice-servers.json` — the dynamic manifest (primary; what `loadIceConfig()`
  consumes). Shape is exactly `IceConfigManifest` from `ice-config.ts`:

  ```jsonc
  {
    "iceServers": [
      { "urls": ["stun:stun.sereus.org:3478"] },
      // present ONLY when TURN enabled + turnPolicy gated|on + secret set:
      { "urls": ["turn:turn.sereus.org:3478?transport=udp",
                 "turn:turn.sereus.org:3478?transport=tcp"],
        "username": "1735689600:web",
        "credential": "base64(HMAC-SHA1(secret, username))" }
    ],
    "turnPolicy": "gated",          // off | gated | on  (operator intent)
    "generatedAt": "2026-06-20T00:00:00Z"
  }
  ```
  Must send `Cache-Control: no-store` (or `max-age` < TTL) — a cached manifest
  would serve already-expired credentials. Must send CORS
  (`Access-Control-Allow-Origin`) so cross-origin browsers can fetch it.

- `GET /healthz` — liveness, **no auth**, no credential, `200 {"ok":true}`.

The issuer NEVER emits a TURN entry unless: `TURN_ENABLED=true` **and**
`TURN_SECRET` is non-empty **and** `TURN_POLICY` ∈ {`gated`,`on`}. Any of those
false → STUN-only manifest (TURN stays last-resort / off by default).

## TLS / deployment

The issuer listens **plain HTTP** on `ISSUER_PORT` (default e.g. 8080); the
operator fronts it with their existing TLS reverse proxy (nginx/caddy), exactly as
`ops/docs/ice-servers.md` already describes for the static manifest ("plain HTTPS —
host it wherever"). No TLS termination inside the service (mirrors the relay/
bootstrap nodes). Document the proxy + `TRUST_PROXY` interaction (below).

## Service interfaces / types

```ts
// ops/docker/turn-credential-issuer/src/main.ts (TS, built via tsc like libp2p-infra)

interface IssuerConfig {
  port: number              // ISSUER_PORT
  stunUrls: string[]        // STUN_URLS (comma-sep) e.g. ["stun:stun.sereus.org:3478"]
  turnEnabled: boolean      // TURN_ENABLED
  turnPolicy: 'off' | 'gated' | 'on'   // TURN_POLICY
  turnSecret: string        // TURN_SECRET (static-auth-secret) — required iff turn on
  turnUrls: string[]        // TURN_URLS (comma-sep) e.g. ["turn:turn.sereus.org:3478?transport=udp", ...]
  credTtlSeconds: number    // CRED_TTL_SECONDS (default 300, clamp to [60, 3600])
  credId: string            // CRED_ID label (default "web")
  authToken: string         // ISSUER_AUTH_TOKEN ('' = open + rate-limited)
  rateLimitPerMin: number   // RATE_LIMIT_PER_MIN (default 30; 0 = disabled, discouraged)
  trustProxy: boolean       // TRUST_PROXY — read client IP from X-Forwarded-For
  corsAllowOrigin: string   // CORS_ALLOW_ORIGIN (default '*')
}
```

Use only Node built-ins (`node:http`, `node:crypto`) — no Express/framework, keep
the image tiny and dependency-free like `libp2p-infra` (which uses raw libp2p, no
web framework). A trivial in-memory fixed-window rate limiter (Map<ip, {count,
windowStart}>) with periodic eviction of stale buckets is sufficient.

## Edge cases & interactions

- **TURN gating matrix:** emit TURN entry ONLY when `turnEnabled && turnSecret &&
  turnPolicy∈{gated,on}`. `turnPolicy=off` with a secret present → STUN-only
  (policy wins). `turnEnabled=true` but empty secret → STUN-only AND log a loud
  warning (parallels coturn entrypoint's open-relay refusal). Never emit a TURN
  entry with an empty/garbage credential.
- **Clock skew:** expiry is absolute unix seconds; issuer clock ahead → near-expiry
  creds; behind → over-long TTL. coturn checks `expiry >= now`. Require NTP; pick a
  TTL margin. Add a test vector pinning a known `(secret, username) → credential`.
- **base64 vs base64url:** credential MUST be standard base64 with padding; a
  base64url slip silently breaks coturn auth. Pin in the unit test.
- **id sanitization:** `<id>` must never contain `:` (would corrupt the
  `expiry:id` parse). Strip to `[A-Za-z0-9._-]`, fall back to `client` if empty.
- **Rate-limit boundaries:** burst at window edges (fixed-window is intentionally
  approximate — document it); bucket Map must be evicted so it can't grow unbounded
  under IP churn (DoS-via-memory). Window reset must be monotonic-ish without
  `Date.now()` pitfalls — `Date.now()` is fine in the *service* (it's not a tess
  workflow script); only this ticket's planning tools forbid it.
- **Proxy / client IP:** behind a reverse proxy, the socket IP is the proxy's. With
  `TRUST_PROXY=true`, read the **last** (or first, document which) hop of
  `X-Forwarded-For`; with it false, ignore XFF (else any client spoofs its IP to
  evade the limit). Wrong default collapses all clients to one bucket OR lets
  everyone bypass — call this out in the README.
- **Auth failures:** missing/invalid token when `ISSUER_AUTH_TOKEN` set → `401`,
  generic body, **never** echo the expected token or mint a credential. Constant-
  time token compare (`crypto.timingSafeEqual`) to avoid a timing oracle.
- **Method/path:** non-GET → `405`; unknown path → `404`; `/healthz` bypasses auth
  and rate limit.
- **CORS:** `loadIceConfig()` sends a simple GET (`accept: application/json` is
  CORS-safelisted) so no preflight is expected — but still set
  `Access-Control-Allow-Origin`. If a future client sends `Authorization` (token
  via header), that triggers a preflight `OPTIONS`; handle `OPTIONS` →
  `204` + CORS headers so the header path doesn't break. With a token, do NOT pair
  `Allow-Origin: *` with credentials cookies (we use none — header token only — so
  `*` is acceptable; document).
- **Caching:** `Cache-Control: no-store` so an intermediary/CDN can't serve a stale
  (expired-credential) manifest. The static example file stays cacheable; the
  dynamic endpoint must not be.
- **Restart / multi-instance:** in-memory rate-limit state is per-process and lost
  on restart; two issuer replicas have independent buckets. Acceptable — coturn
  quotas are the global backstop. Document the limitation; don't build shared state.
- **Secret rotation:** out of scope to automate. Document the operator procedure
  (coturn supports overlapping `static-auth-secret` lines for a rotation window).
- **STUN-only fallback parity:** when the issuer is unreachable, `loadIceConfig()`
  already returns `[]` (degraded-but-safe). The static `ice-servers.example.json`
  remains the STUN-only reference/example and is unchanged in shape.
- **Interaction — `turn-relayed-path-metrics`:** once TURN can actually be issued,
  a TURN-relayed WebRTC path becomes possible; that path is misclassified as
  `direct` until `turn-relayed-path-metrics` (plan/) lands. No code dependency here
  — just keep the cross-reference in `ice-config.ts` / `ops/docs/ice-servers.md`.

## Tests (TDD anchors)

- **Unit / self-test (agent-runnable, no network):** add
  `ops/test/check-turn-creds.mjs --self-test` that recomputes
  `base64(HMAC-SHA1(secret, "<expiry>:<id>"))` for a pinned `(secret, expiry, id)`
  vector and asserts equality — pins the scheme (base64-not-base64url, separator,
  digest) so the service and any client stay in sync. Keep the 4-line HMAC in sync
  with `mintTurnCredential` (RFC-standard, stable). Register an `ops/test`
  `package.json` script (`check-turn-creds`).
- **Live check (NOT agent-runnable — needs a deployed issuer + coturn):** same
  script, `--url https://turn-issuer.example/ice-servers.json [--secret <s>]`:
  fetch the manifest, assert STUN entry present; when a TURN entry is present,
  re-derive the HMAC from `--secret` and assert it matches the served `credential`,
  and assert `username` parses as `<future-unix>:<id>`. Mirror `check-stun.mjs`'s
  "requires a deployed server" caveat in `ops/test/README.md`.
- **Config-render smoke (agent-runnable):** confirm the gating matrix above by
  running `main.ts`'s manifest-assembly function across the {turnEnabled,
  turnPolicy, secret} cases and asserting TURN entry presence/absence (can be a
  tiny exported `buildManifest(config, nowSec)` pure fn driven by the self-test
  script, avoiding a live socket).
- coturn config itself is already validated (`turn-ssrf-peer-deny-hardening`);
  no coturn changes needed here beyond docs.

## TODO

### Phase 1 — the issuer service
- Scaffold `ops/docker/turn-credential-issuer/`: `package.json` (private, type
  module, `build: tsc`, no runtime deps), `tsconfig.json` (copy libp2p-infra's),
  multi-stage `Dockerfile` (node:22-alpine, `CMD ["node","dist/main.js"]`,
  `EXPOSE` the issuer port).
- `src/main.ts`: read `IssuerConfig` from env (with the documented defaults +
  clamps); pure `mintTurnCredential()` and `buildManifest(config, nowSec)`; a
  `node:http` server with `/ice-servers.json`, `/healthz`, `OPTIONS`, and the
  404/405 paths; in-memory fixed-window rate limiter with stale-bucket eviction;
  bearer-token gate with `timingSafeEqual`; CORS + `Cache-Control: no-store`
  headers. Log effective config on boot (mask the secret).
- `docker-compose.yml` mirroring `relay/`/`coturn`: build context, container name,
  env passthrough, `ISSUER_PORT` mapping, `restart: unless-stopped`. Note the
  reverse-proxy-for-TLS expectation in a header comment.
- `env.example`: every knob from `IssuerConfig` with guidance; cross-reference the
  coturn `TURN_SECRET` (must match coturn's), STUN/TURN URLs, the token/rate-limit/
  TTL/TRUST_PROXY notes, and the NTP requirement.
- `README.md`: what it is, deploy via `install`/`svc`, the auth/rate-limit posture,
  TLS-proxy note, the gating matrix, and how to point clients at it
  (`VITE_ICE_CONFIG_URL` / `EXPO_PUBLIC_ICE_CONFIG_URL`, optional `?token=`).

### Phase 2 — ops integration & tests
- `ops/scripts/install`: add a `turn-credential-issuer` arm to the `case` (and the
  usage `<service>` list) so `install docker turn-credential-issuer` scaffolds it.
- `ops/test/check-turn-creds.mjs` + `ops/test/package.json` script + a short
  `ops/test/README.md` section (self-test runnable; live check deferred like
  check-stun).
- `ops/docker/README.md`: list the new service alongside relay/bootstrap/coturn.
- `ops/docker/quickstarts/`: optional short `turn-credential-issuer.md` quickstart
  (only if it matches the existing quickstart pattern; otherwise fold into README).

### Phase 3 — docs & client pointer (no functional client change)
- `ops/docs/ice-servers.md`: replace the "(not-yet-built) credential service"
  language with the now-existing issuer; document the dynamic-manifest model, the
  gating matrix, `turnPolicy` transition off→gated, and the `Cache-Control`/CORS
  requirements. Keep STUN-first/TURN-last-resort framing.
- `ops/docker/coturn/README.md` + `env.example`: change the "Enabling TURN"
  checklist item 3 from "a credential-issuing endpoint — not built yet (backlog…)"
  to "stand up `ops/docker/turn-credential-issuer/` (this repo) and point clients
  at its `/ice-servers.json`."
- `ops/docker/coturn/ice-servers.example.json`: leave STUN-only (it's the static
  fallback/example), but ensure the doc cross-references make clear the dynamic
  manifest supersedes it when TURN is on.
- `packages/reference-app-web/src/lib/ice-config.ts`: update ONLY the header
  doc-comment "TURN forward-pointers" block (lines ~26–32) — the issuer now exists;
  TURN entries are minted by `ops/docker/turn-credential-issuer/`. No code change
  (username/credential passthrough already works). Mirror the same comment fix in
  `packages/reference-app-rn/src/ice-config.ts` if it carries the same pointer.

### Phase 4 — validate
- `yarn workspace @serfab/reference-app-web run typecheck` (+ `svelte-check`) to
  confirm the doc-comment edit didn't break the web package; RN typecheck if the RN
  comment was touched.
- Run `node ops/test/check-turn-creds.mjs --self-test` (agent-runnable) and confirm
  the HMAC vector passes; document the live `--url` check as deferred-to-deploy.
- Build the issuer image locally if Docker is available
  (`docker compose -f ops/docker/turn-credential-issuer/docker-compose.yml build`);
  if Docker is absent (as in prior coturn tickets), `tsc` the service standalone to
  confirm it compiles, and document the image build as deferred to a Docker host.
