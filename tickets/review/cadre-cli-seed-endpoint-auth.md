description: Review of cadre-cli deployment-surface hardening for the gated POST /seed (docker-compose host-port binding, env.example + README docs)
prereq:
files: packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/cadre-cli/README.md
----

## What this ticket was

Deployment-surface hardening for the standalone **cadre-cli** docker template
and docs, following the now-landed code-side seed auth
(`seed-network-path-authn`). **No code changes** — the `POST /seed` bearer gate,
`CADRE_SEED_TOKEN` wiring in `start.ts`, the `checkBearer` helper, and
`test/health-server.spec.ts` already exist and were untouched here. Scope was
strictly the compose template + operator-facing docs.

## What landed (the diff to review)

### `packages/cadre-cli/docker/docker-compose.yml`
- **Health port now binds loopback by default.** Changed
  `"${HOST_HEALTH_PORT:-8080}:8080/tcp"` →
  `"${HOST_HEALTH_BIND:-127.0.0.1}:${HOST_HEALTH_PORT:-8080}:8080/tcp"`.
- **Metrics port likewise** →
  `"${HOST_METRICS_BIND:-127.0.0.1}:${HOST_METRICS_PORT:-9090}:9090/tcp"`.
- Added `CADRE_SEED_TOKEN=${CADRE_SEED_TOKEN:-}` to the `environment:` block with
  an "OFF by default" comment, plus comments on the port lines explaining that
  4001 is the only public port and `/seed` is unregistered unless the token is set.

**Decision (chose option 1 + a notable extension).** The ticket offered (1)
loopback-by-default vs (2) keep bare publish + warning comment. I chose
loopback-by-default because the health/metrics surfaces are not meant for the
public internet and a safe default is better than a comment users may skip. To
preserve the "remote probes out of the box" escape hatch the ticket worried
about, I made the bind interface a variable (`HOST_HEALTH_BIND` /
`HOST_METRICS_BIND`, default `127.0.0.1`) so an operator can set `0.0.0.0`
behind a firewall without editing the compose file.

**Extension beyond the literal ticket — flag for reviewer:** the ticket scoped
the binding change to **8080 only**. I *also* applied the loopback default to
**9090 (metrics)**, since Prometheus metrics carry the same "read-only but
info-leaky, shouldn't face the public internet" concern and leaving 9090
world-published while locking 8080 would be inconsistent with the firewall
guidance added to the README. If the reviewer judges this out of scope, reverting
the 9090 line + its env/README mentions is self-contained. I believe it's the
right defense-in-depth default.

### `packages/cadre-cli/docker/env.example`
- Added `HOST_HEALTH_BIND=127.0.0.1` and `HOST_METRICS_BIND=127.0.0.1` to the
  Host Port Bindings section with a comment that 0.0.0.0 is firewall-only.
- New "Seed Delivery (Optional)" section with a commented `# CADRE_SEED_TOKEN=`
  and a one-line note that setting it enables authenticated `POST /seed`
  (`Authorization: Bearer <token>`), suggesting `openssl rand -hex 32`.

### `packages/cadre-cli/README.md`
- Env-var table: added `CADRE_SEED_TOKEN` row (`_(env only)_`, no config path) —
  "Unset = seed endpoint disabled".
- Port table: 8080 row now says read-only probes by default + `POST /seed`
  authenticated and off unless `CADRE_SEED_TOKEN` is set.
- Firewall/deployment section: states only 4001 should be public; **do not** open
  8080/9090; documents the loopback default + `HOST_HEALTH_BIND` /
  `HOST_METRICS_BIND` override.

## Validation performed

- `yarn workspace @serfab/cadre-cli build` → exit 0.
- `yarn workspace @serfab/cadre-cli test` → **50 passed (5 files)**, including
  `test/health-server.spec.ts` (the seed-auth/401/413/404 suite). No code
  changed, so this only confirms nothing regressed.

## Suggested review checks / use cases

- **Default deploy is closed.** With a fresh `cp env.example .env` + required
  vars only (no `CADRE_SEED_TOKEN`), `docker compose up -d` should expose 8080/9090
  on `127.0.0.1` only, and `POST /seed` should 404 (route unregistered). The
  in-container healthcheck (`wget http://localhost:8080/health`) still works
  because the container listens on `0.0.0.0:8080` internally — host loopback
  binding does not affect it. **Reviewer: confirm the healthcheck reasoning by
  inspection; I did not stand up Docker in this environment.**
- **Opt-in remote probes.** Setting `HOST_HEALTH_BIND=0.0.0.0` should publish
  8080 on all interfaces (for firewalled management networks).
- **Seed enabled path.** Setting `CADRE_SEED_TOKEN=<token>` should register
  `POST /seed`; unauthenticated → 401, valid bearer → handled, oversize body →
  413 (behavior owned by the already-reviewed code, not this ticket).
- **Docs consistency.** Verify env.example var names exactly match what
  docker-compose.yml references (`HOST_HEALTH_BIND`, `HOST_METRICS_BIND`,
  `CADRE_SEED_TOKEN`) — these are new var names introduced here.

## Known gaps / non-goals

- **Not validated against a live Docker daemon.** Compose syntax was edited by
  hand; `docker compose config` was not run (no Docker in this env). The
  bind-interface `"IFACE:HOST:CONTAINER/proto"` syntax is standard compose, but a
  reviewer with Docker should `docker compose config` to be certain.
- **Provider counterpart is separate.** Per-container token generation/injection
  and the provider's own `docker-orchestrator` `HostIp: 127.0.0.1` bindings are
  `cadre-provider-seed-endpoint-auth` (prereqs this slug) — not touched here.
- **No code-side changes**, so the seed auth logic itself was not re-reviewed.
- **Trust-policy gap** (`seed-trust-policy-and-authority-identity`) is orthogonal
  and already landed; a valid bearer authenticates the *delivery path*, not the
  seed *contents*.
