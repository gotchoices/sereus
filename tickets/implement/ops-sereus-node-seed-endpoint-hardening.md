description: Mirror the loopback-binding + CADRE_SEED_TOKEN deployment hardening into the ops/docker/sereus-node template (compose, env.example, README) so it matches the already-hardened packages/cadre-cli/docker template
prereq:
files: ops/docker/sereus-node/docker-compose.yml, ops/docker/sereus-node/env.example, ops/docker/sereus-node/README.md
----

## Problem

`cadre-cli-seed-endpoint-auth` (commit `df2202d`) hardened the
`packages/cadre-cli/docker/` deployment template against the gated `POST /seed`
surface, but the second, near-identical template at `ops/docker/sereus-node/`
(its own `docker-compose.yml`, `env.example`, `README.md`) was never touched. It
still publishes the health (8080) and metrics (9090) ports world-wide by default,
neither passes nor documents `CADRE_SEED_TOKEN`, and its README gives no firewall
guidance and never mentions the authenticated, off-by-default `POST /seed`.

Both templates build/run the same node from the same
`packages/cadre-cli/docker/Dockerfile`, so an operator following
`ops/docker/sereus-node/` gets the pre-hardening (world-published) behavior.

This is a straight mirror — **no application code changes**. The exact target
text below is lifted from the already-landed `packages/cadre-cli/docker/`
template (`docker-compose.yml`, `env.example`) and
`packages/cadre-cli/README.md` (Port Requirements section), adapted to the
slightly different section comments of the `ops/` files.

## Research notes (already done — don't re-discover)

- Reference (hardened) files to copy wording from:
  - `packages/cadre-cli/docker/docker-compose.yml` lines 53-68 (CADRE_SEED_TOKEN
    env + bound `ports:` with comments).
  - `packages/cadre-cli/docker/env.example` lines 56-71 (`HOST_HEALTH_BIND` /
    `HOST_METRICS_BIND` + commented `CADRE_SEED_TOKEN`).
  - `packages/cadre-cli/README.md` lines 155-173 (port table + firewall guidance).
- **No `docker-compose.test.yml` exists** under `ops/docker/sereus-node/` (the
  README's Integration Testing section references one that is not present in the
  repo). There is therefore no test overlay that publishes/overrides 8080/9090,
  so defaulting them to loopback cannot break a test cluster. (The open question
  in the source ticket is thus resolved: nothing to reconcile.)
- The `ops/docker/sereus-node/docker-compose.yml` currently lacks a
  `CADRE_HEALTH_PORT`/`CADRE_METRICS_PORT`-style `HOST_*_BIND` and publishes
  `"${HOST_HEALTH_PORT:-8080}:8080/tcp"` / `"${HOST_METRICS_PORT:-9090}:9090/tcp"`
  unbound (lines 49-50). The 4001 publish (line 48) stays as-is.

## Design

### 1. `ops/docker/sereus-node/docker-compose.yml`

In the `environment:` block, after the `CADRE_METRICS_PORT=9090` line (line 45),
add the seed token plumbing:

```yaml
      # Seed delivery (optional, OFF by default). When CADRE_SEED_TOKEN is set,
      # the node registers an authenticated POST /seed (Authorization: Bearer
      # <token>); leave it unset to keep the health port read-only. See env.example.
      - CADRE_SEED_TOKEN=${CADRE_SEED_TOKEN:-}
```

Replace the health/metrics port publishes (current lines 49-50) so they bind to
loopback by default while leaving the 4001 publish (line 48) untouched:

```yaml
    ports:
      # libp2p network port — the only port that needs to reach the public internet.
      - "${HOST_P2P_PORT:-4001}:4001/tcp"
      # Health/probe endpoint. Bound to loopback by default: serves read-only
      # /health, /ready, /status. POST /seed is NOT served unless CADRE_SEED_TOKEN
      # is set (above), and even then requires Authorization: Bearer <token>.
      # Do NOT expose 8080 to the public internet — set HOST_HEALTH_BIND=0.0.0.0
      # only behind a firewall / trusted management network if you need remote probes.
      - "${HOST_HEALTH_BIND:-127.0.0.1}:${HOST_HEALTH_PORT:-8080}:8080/tcp"
      # Prometheus metrics — likewise loopback by default; keep off the public internet.
      - "${HOST_METRICS_BIND:-127.0.0.1}:${HOST_METRICS_PORT:-9090}:9090/tcp"
```

### 2. `ops/docker/sereus-node/env.example`

In the NETWORK SETTINGS block, right after the existing
`HOST_METRICS_PORT=9090` line (line 39), add:

```sh
# Host interface the health (8080) and metrics (9090) ports bind to.
# Default 127.0.0.1 (loopback only) — these surfaces should NOT be reachable
# from the public internet. Set to 0.0.0.0 ONLY behind a firewall / on a trusted
# management network if you need remote health probes or metrics scraping.
HOST_HEALTH_BIND=127.0.0.1
HOST_METRICS_BIND=127.0.0.1
```

Add a new section (place it before or after the STRAND FILTER block — match the
file's `# ===…` banner style):

```sh
# ============================================================================
# SEED DELIVERY (OPTIONAL)
# ============================================================================

# Bearer token gating the HTTP seed endpoint. When UNSET (the default), POST /seed
# is not registered and the health port serves only read-only probes. When set,
# the node registers an authenticated POST /seed that requires
# `Authorization: Bearer <this token>`. Use a long random value (e.g. `openssl rand -hex 32`).
# CADRE_SEED_TOKEN=
```

### 3. `ops/docker/sereus-node/README.md`

Update the Endpoints table (lines 30-38) so the 8080 rows convey read-only +
authenticated off-by-default seed, e.g. add a `/seed` row or annotate the table.
Mirror the cadre-cli README intent — append a `POST /seed` row:

```
| 8080 | POST /seed | Authenticated seed delivery — **off unless `CADRE_SEED_TOKEN` is set** (then requires `Authorization: Bearer <token>`) |
```

After the Endpoints table, add a short firewall note mirroring
`packages/cadre-cli/README.md` lines 161-173:

> Only port **4001** should be reachable from the public internet. Do **not**
> open 8080 (health/seed) or 9090 (metrics) publicly — the compose template binds
> both to `127.0.0.1` by default (override per port with `HOST_HEALTH_BIND` /
> `HOST_METRICS_BIND`, e.g. `0.0.0.0`, only behind a firewall). `POST /seed` is
> additionally bearer-gated and is not registered unless `CADRE_SEED_TOKEN` is
> set, so the health port carries no remotely-mutable surface by default.

Also update the Quick Start `curl http://localhost:8080/health` note if desired
to clarify it now only works from the host loopback by default (optional polish).

## Considerations

- **DRY**: two near-duplicate compose templates for the same node is a standing
  maintenance hazard — this very ticket exists because a hardening change had to
  be applied twice. A separate backlog ticket,
  `consolidate-duplicate-cadre-node-docker-templates`, has been filed to decide
  whether to consolidate `ops/docker/sereus-node/` with
  `packages/cadre-cli/docker/`. Do the straight mirror here regardless.

## Validation

- No application code changes, so no build/test needed.
- If Docker is available: `docker compose -f ops/docker/sereus-node/docker-compose.yml config`
  (with a minimal `.env` setting `CADRE_PARTY_ID` and `CADRE_BOOTSTRAP_NODES`)
  should parse and show the `127.0.0.1:8080:8080/tcp` / `127.0.0.1:9090:9090/tcp`
  binds and the `CADRE_SEED_TOKEN` env. This is a reviewer-with-Docker check; if
  Docker is unavailable in the agent environment, skip and note the deferral.

## TODO

- [ ] Edit `ops/docker/sereus-node/docker-compose.yml`: add `CADRE_SEED_TOKEN`
  to `environment:`; change the 8080 and 9090 publishes to the
  `${HOST_*_BIND:-127.0.0.1}:...` form (leave 4001 unbound). Use the comments above.
- [ ] Edit `ops/docker/sereus-node/env.example`: add `HOST_HEALTH_BIND` /
  `HOST_METRICS_BIND` after `HOST_METRICS_PORT`, and a new SEED DELIVERY section
  with the commented `CADRE_SEED_TOKEN`.
- [ ] Edit `ops/docker/sereus-node/README.md`: add the authenticated/off-by-default
  `POST /seed` to the Endpoints table and a firewall note (only 4001 public;
  8080/9090 loopback by default).
- [ ] (If Docker available) run `docker compose ... config` to confirm the bind
  syntax parses; otherwise note the deferral in the review handoff.
