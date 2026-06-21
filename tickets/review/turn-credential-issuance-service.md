description: A new operator-hosted web service mints short-lived TURN passwords on demand and serves browsers/phones a ready-to-use ICE-server list, advertising the TURN relay only when the operator has switched it on.
files: ops/docker/turn-credential-issuer/src/main.ts, ops/docker/turn-credential-issuer/Dockerfile, ops/docker/turn-credential-issuer/docker-compose.yml, ops/docker/turn-credential-issuer/env.example, ops/docker/turn-credential-issuer/README.md, ops/docker/turn-credential-issuer/package.json, ops/docker/turn-credential-issuer/tsconfig.json, ops/test/check-turn-creds.mjs, ops/test/package.json, ops/test/README.md, ops/scripts/install, ops/docker/README.md, ops/docker/quickstarts/turn-credential-issuer.md, ops/docker/coturn/README.md, ops/docker/coturn/env.example, ops/docker/coturn/entrypoint.sh, ops/docker/quickstarts/coturn.md, ops/docs/ice-servers.md, packages/reference-app-web/src/lib/ice-config.ts
difficulty: medium
----

## What was built

A standalone, dependency-free Node HTTP service at
`ops/docker/turn-credential-issuer/` that serves the **dynamic ICE-config
manifest** (`GET /ice-servers.json`). When the co-located coturn TURN relay is
enabled, each fetch carries a freshly-minted, short-lived TURN credential (coturn
`use-auth-secret` / REST-API scheme); when TURN is off, the manifest is STUN-only.
The shared `static-auth-secret` (`TURN_SECRET`) lives only in the issuer.

The manifest shape is exactly the `IceConfigManifest` consumed by the existing
client helper `loadIceConfig()`, so the only client-side wiring is pointing
`VITE_ICE_CONFIG_URL` / `EXPO_PUBLIC_ICE_CONFIG_URL` at `/ice-servers.json`. The
client code is unchanged (doc-comment only) — `username`/`credential` passthrough
already worked.

### Service surfaces
- `GET /ice-servers.json` — dynamic manifest; `Cache-Control: no-store` + CORS.
- `GET /healthz` — liveness, no auth, `200 {"ok":true}`.
- `OPTIONS *` → `204` + CORS (preflight for the `Authorization`-header path).
- non-GET → `405`; unknown path → `404`.

### Key implementation points (where to look)
- `mintTurnCredential(secret, id, ttlSec, nowSec)` — `username = "<expiry>:<id>"`,
  `credential = base64(HMAC-SHA1(secret, username))` (**standard** base64 w/
  padding, NOT base64url; `id` sanitized to `[A-Za-z0-9._-]`, never contains `:`).
- `buildManifest(config, nowSec)` — **pure**; assembles STUN (+ optional TURN).
- `shouldEmitTurn(config)` — the gating matrix (see below).
- `FixedWindowRateLimiter` — in-memory per-IP fixed window + stale-bucket eviction.
- bearer-token gate via `timingSafeEqual`; entry-point guard so the pure exports
  import without booting a listener.

### TURN gating matrix (verify this is exactly right)
TURN entry emitted **only** when ALL: `turnEnabled` AND `turnSecret` non-empty AND
`turnUrls` non-empty AND `turnPolicy ∈ {gated, on}`. Any false → STUN-only.
`turnPolicy=off` with a secret present → STUN-only (policy wins). `turnEnabled` with
empty secret/urls → STUN-only **+ loud boot warning**.

## How it was validated (this is a FLOOR, not a ceiling)

All run with Node 24 locally (Docker was NOT available in the implement env):

1. **`tsc -p tsconfig.json`** on the service — compiles clean (strict mode).
2. **Self-test (agent-runnable, no network):**
   `node ops/test/check-turn-creds.mjs --self-test` → **12 checks pass**: pinned
   HMAC vector (`(test-secret-do-not-use, 1735689600, web)` →
   `zjHGi3Op+GDVwe3+VlIssA1POfs=`), standard-base64 assertion, id-sanitization
   (cannot inject `:`, empty→`client`), and the full gating matrix.
3. **Live HTTP smoke** (ran `node dist/main.js`, curled endpoints, killed): verified
   `/healthz` (200, no auth), `401` without token, `200` + TURN entry +
   `Cache-Control: no-store` + CORS with `?token=` AND `Authorization: Bearer`,
   `OPTIONS`→`204`, `POST`→`405`, unknown→`404`, and per-IP rate limit firing
   after the configured count.
4. **Live `--url` check** against a temp server: passes with the correct
   `--secret`, fails (exit 1) with a wrong secret — confirms the HMAC re-derivation.
5. **`bash -n`** on the edited `ops/scripts/install` and `coturn/entrypoint.sh`.

### Suggested review use cases / probes
- Re-run the self-test; then drive `buildManifest`/`shouldEmitTurn` (import the
  built `dist/main.js`) across the gating matrix yourself.
- Hammer the rate limiter across a window boundary (fixed-window is intentionally
  approximate — confirm the burst-at-edge behavior is acceptable, and that the
  bucket Map is evicted so it can't grow unbounded under IP churn).
- Token path: empty token (open + rate-limited), wrong token (`401`, generic body,
  no credential echoed), `?token=` vs header, constant-time compare.
- `TRUST_PROXY` true/false × with/without `X-Forwarded-For` — confirm the
  last-hop read and the spoof-resistance reasoning.
- Confirm the manifest validates through `parseIceServers()` in `ice-config.ts`
  (it does structurally — same shape — but worth an explicit check).

## Known gaps / things to scrutinize (honest handoff)

- **Docker build DEFERRED (not run).** Docker was absent in the implement env. The
  multi-stage `Dockerfile` copies only `dist/` + `package.json` (no `node_modules`,
  since the service uses Node built-ins only) — **verify it builds and
  `node dist/main.js` runs in `node:22-alpine`** on a Docker host
  (`docker compose -f ops/docker/turn-credential-issuer/docker-compose.yml build`).
- **End-to-end against real coturn DEFERRED.** The HMAC scheme is pinned and the
  `--url` check re-derives it, but no live coturn Allocate was exercised — that
  needs a deployed coturn + issuer sharing a clock (NTP). The scheme matches
  coturn's `use-auth-secret` per docs, but real acceptance is unverified.
- **Rate limiter is per-process, in-memory.** Lost on restart; two replicas have
  independent buckets. By design — coturn quotas (`total-quota`/`user-quota`/
  `max-bps`) are the hard backstop. No shared store was built (out of scope).
- **`TRUST_PROXY` assumes exactly one trusted proxy hop** (reads the rightmost XFF
  entry). Multi-proxy chains would need a hop-count knob — not built; documented.
- **Default auth is rate-limited-but-open** (no token). Stronger libp2p-peer-id-
  bound issuance is backlog `turn-issuer-peer-bound-auth` (already filed).
- **`timingSafeEqual` length short-circuit** leaks token length (documented in
  code). Acceptable for a bearer token; flag if you disagree.
- **CORS default `*`** — acceptable because no cookies/credentials are used (header/
  query token only); documented. Tighten to an origin if preferred.
- **No test-runner unit test.** Validation is the self-contained `.mjs` self-test
  (matches repo convention — `libp2p-infra`/`coturn` ops services carry no
  vitest/jest harness). The self-test re-implements the 4-line HMAC + gating to
  stay build-free; the pinned vector is the anti-drift lock. If the service's
  `mintTurnCredential`/`shouldEmitTurn` change, the `.mjs` mirror must change too —
  worth a reviewer eye on that coupling.

## Pre-existing failure flagged (NOT mine)
`yarn workspace @serfab/reference-app-web run typecheck` fails with 2 errors in
`src/lib/cadre-web.ts` (libp2p `PrivateKey`/`Uint8ArrayList` type skew between the
linked optimystic `db-p2p-storage-web` and sereus `@libp2p/interface`). My only web
change is a **comment** in `ice-config.ts`; `cadre-web.ts` is untouched, so it
reproduces at HEAD. Recorded in `tickets/.pre-existing-error.md` for the triage pass.

## Docs touched (for cross-reference review)
`ops/docs/ice-servers.md` (dynamic-manifest model, gating matrix, `off→gated`
transition, `Cache-Control`/CORS, forward pointers), `ops/docker/README.md`,
`ops/docker/coturn/{README.md,env.example,entrypoint.sh}` and
`quickstarts/coturn.md` (replaced "not built yet" with the now-existing issuer),
new `quickstarts/turn-credential-issuer.md`, `ops/test/README.md`. Confirm no stale
"`turn-credential-issuance-service` (backlog)" / "not built yet" pointers remain in
non-archived files (archived `tickets/complete/*` were intentionally left as-is).

## Prereq
`turn-ssrf-peer-deny-hardening` — complete (coturn config already validated; no
coturn config changes were needed here beyond doc updates).
