description: A new operator-hosted web service mints short-lived TURN passwords on demand and serves browsers/phones a ready-to-use ICE-server list, advertising the TURN relay only when the operator has switched it on.
prereq:
files: ops/docker/turn-credential-issuer/src/main.ts, ops/docker/turn-credential-issuer/Dockerfile, ops/docker/turn-credential-issuer/docker-compose.yml, ops/docker/turn-credential-issuer/env.example, ops/docker/turn-credential-issuer/README.md, ops/docker/turn-credential-issuer/package.json, ops/docker/turn-credential-issuer/tsconfig.json, ops/test/check-turn-creds.mjs, ops/scripts/install, ops/docker/coturn/{README.md,env.example,entrypoint.sh}, ops/docs/ice-servers.md, packages/reference-app-web/src/lib/ice-config.ts
----

## Summary

Shipped a standalone, dependency-free Node HTTP service
(`ops/docker/turn-credential-issuer/`) that serves the dynamic ICE-config
manifest (`GET /ice-servers.json`). When the co-located coturn relay is enabled
each fetch carries a freshly-minted, short-lived TURN credential (coturn
`use-auth-secret` / REST-API scheme); when TURN is off the manifest is STUN-only.
The shared `static-auth-secret` (`TURN_SECRET`) lives only in the issuer. The
manifest is exactly the `IceConfigManifest` consumed by the client helper
`loadIceConfig()`, so client wiring is just pointing
`VITE_ICE_CONFIG_URL` / `EXPO_PUBLIC_ICE_CONFIG_URL` at `/ice-servers.json`.

See the implement commit `367859e` for the full design narrative.

## Review findings

Adversarial pass over the implement diff (`367859e`), read first with fresh eyes
before the handoff. Scrutinized for correctness, SPP/DRY, resource cleanup, error
handling, type safety, security, and doc accuracy.

### MAJOR — Docker build was broken (fixed inline)

The standalone `package.json` was missing `@types/node`, so the multi-stage
`Dockerfile`'s `npm run build` (`tsc`) fails inside the container: I reproduced
the exact Docker build steps in an isolated tmp dir (`npm install` installs only
`typescript`, then `tsc`) and got **11 TS errors** — `Cannot find module
'node:crypto' / 'node:http' / 'node:process' / 'node:url'`, plus `process`,
`Buffer`, and `setInterval(...).unref()` failures. The implementer's local `tsc`
passed *only* because the monorepo root hoists `@types/node` into a parent
`node_modules`; the container has no such parent. This is precisely the "Docker
build DEFERRED (not run)" gap the handoff flagged honestly — the deferral hid a
real, ship-blocking defect.

**Fix:** added `"@types/node": "^22"` (matching the `node:22-alpine` base image)
to `devDependencies`. One-line fix → fixed in this pass rather than filing a
ticket. **Re-verified end to end in isolation:** `npm install && npm run build`
now succeeds and emits `dist/main.js`; the built module's
`buildManifest`/`shouldEmitTurn`/`mintTurnCredential` exports drive correctly and
the pinned HMAC vector reproduces from `dist/`.

### Verified correct (no action)

- **Credential scheme matches coturn `use-auth-secret`:** `username =
  "<expiry>:<id>"`, `credential = base64(HMAC-SHA1(secret, username))`, standard
  base64 (padded, no `-`/`_`). `id` sanitized to `[A-Za-z0-9._-]` so it can never
  inject the `:` separator; empty → `client`. Pinned vector
  `(test-secret-do-not-use, 1735689600, web)` → `zjHGi3Op+GDVwe3+VlIssA1POfs=`
  reproduced from both the `.mjs` mirror and the built service.
- **Gating matrix exactly as specified:** TURN emitted iff `turnEnabled` AND
  `turnSecret` non-empty AND `turnUrls` non-empty AND `turnPolicy ∈ {gated,on}`;
  any false → STUN-only; `policy=off` with a secret → STUN-only (policy wins).
  Confirmed via the 12-check self-test and by driving the built `dist/main.js`.
- **`clientIp` spoof-resistance:** with `TRUST_PROXY=true` it reads the *rightmost*
  XFF hop — correct for a single trusted proxy (a client prepending fake hops
  can't push past the IP the trusted proxy appends); with `false` it ignores XFF.
  Reasoning is sound; multi-proxy chains are documented as needing a hop knob.
- **Auth before rate-limit** (unauth floods can't pollute the bucket Map), generic
  `401` (no token echoed), constant-time `timingSafeEqual` compare.
- **Rate limiter:** in-memory fixed window with an `unref()`'d eviction timer so
  the bucket Map can't grow unbounded under IP churn and never holds the process
  open. Per-process/approximate by design; coturn quotas are the hard backstop.
- **Manifest shape** is structurally compatible with `parseIceServers` /
  `toIceServer` in `ice-config.ts` (array `urls` + optional `username`/`credential`).

### Live verification (ran here)

- `node ops/test/check-turn-creds.mjs --self-test` → 12 checks pass.
- Booted the built `dist/main.js` and curled every surface: `/healthz` 200 (no
  auth), missing/wrong token → 401, valid `?token=` and `Authorization: Bearer`
  → 200 with TURN entry + `Cache-Control: no-store` + CORS, `OPTIONS` → 204,
  `POST` → 405, unknown path → 404, and the per-IP rate limit firing exactly at
  the configured count.
- `eslint` on the changed `ice-config.ts` → clean (`ops/**` is excluded from lint
  by `eslint.config.mjs`, so the new service files are out of lint scope by
  config — not silently skipped).
- `yarn workspace @serfab/reference-app-web run typecheck` → clean. (The
  typecheck failure the implementer flagged in `cadre-web.ts` was already resolved
  by the triage pass in commit `3c3ce8d`, which removed `.pre-existing-error.md`.)

### Minor observations (non-blocking, not actioned)

- `docker-compose.yml` defines no `healthcheck` even though `/healthz` exists —
  optional hardening; left as-is to match the other ops services.
- `build.context: ../turn-credential-issuer` resolves to the service's own
  directory when run in place (the documented `docker compose -f .../docker-compose.yml
  build` command works); it would break only if the compose file were relocated
  away from the repo tree. Acceptable.
- `packages/reference-app-rn/src/ice-config.ts` did not receive the parallel
  doc-comment the web helper got. Functionally irrelevant (the manifest is
  server-side; RN wiring is just `EXPO_PUBLIC_ICE_CONFIG_URL`).
- `tickets/backlog/turn-issuer-peer-bound-auth.md` still points at the now-moved
  `tickets/implement/turn-credential-issuance-service.md` path — harmless stale
  reference; that backlog ticket is re-read at plan time.

### Genuinely deferred (out of agent scope — documented, not findings)

- **End-to-end against a real coturn Allocate** needs a deployed coturn + issuer
  sharing an NTP clock — not runnable here. The HMAC scheme matches coturn's
  documented `use-auth-secret` and is pinned + re-derived by the `--url --secret`
  check; live acceptance remains for a deployment smoke.
- **Full `docker compose build` on a Docker host** — Docker is absent in this
  environment, but the exact build steps were reproduced in isolation and now
  pass after the `@types/node` fix. A human/CI should still run the compose build
  once on a Docker host as the final gate.

No major findings remained open after the inline build fix; no new tickets filed.
Existing follow-ups (`turn-issuer-peer-bound-auth`, `turn-relayed-path-metrics`)
were already on the backlog and are unchanged by this review.
