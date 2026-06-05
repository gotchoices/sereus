description: Mirror of loopback-binding + CADRE_SEED_TOKEN deployment hardening into ops/docker/sereus-node (compose, env.example, README). Docs/config only — no application code. Reviewed and accepted.
prereq:
files: ops/docker/sereus-node/docker-compose.yml, ops/docker/sereus-node/env.example, ops/docker/sereus-node/README.md
----

## Summary

Mirrored the already-landed `packages/cadre-cli/docker/` hardening (commit
`df2202d`, ticket `cadre-cli-seed-endpoint-auth`) into the second, near-identical
deployment template at `ops/docker/sereus-node/`. Three template/doc files only;
zero application code touched.

- **docker-compose.yml** — added `- CADRE_SEED_TOKEN=${CADRE_SEED_TOKEN:-}` to
  `environment:`; changed the 8080/9090 host publishes to loopback-bound
  (`${HOST_HEALTH_BIND:-127.0.0.1}:...` / `${HOST_METRICS_BIND:-127.0.0.1}:...`);
  the 4001 publish remains intentionally unbound (the only public-internet port).
- **env.example** — added active `HOST_HEALTH_BIND=127.0.0.1` /
  `HOST_METRICS_BIND=127.0.0.1` and a new commented `# SEED DELIVERY (OPTIONAL)`
  section with `# CADRE_SEED_TOKEN=`.
- **README.md** — added the authenticated/off-by-default `POST /seed` endpoint
  row, a firewall blockquote (only 4001 public; 8080/9090 loopback by default),
  and a Quick Start annotation on the `curl …:8080/health` step.

Net effect: an operator following `ops/docker/sereus-node/` now gets the same
hardened posture as `packages/cadre-cli/docker/`.

## Review findings

### Checked: diff fidelity vs. reference template — PASS
Compared `c6b7d99` against the reference `df2202d` (`packages/cadre-cli/docker/`
+ `packages/cadre-cli/README.md`). The compose `environment:` line, the
loopback-bound `ports:` forms, the env.example `HOST_*_BIND` lines and SEED
section, and the README firewall note are all faithful adaptations. The seed
endpoint is described as **authenticated AND off-by-default** in every location
(compose comment, env.example comment, README table row, README blockquote) —
no qualifier drifted.

### Checked: docs match actual application behavior — PASS
The documented behavior was cross-checked against real code rather than assumed:
- `packages/cadre-cli/src/server/health.ts:284` — `POST /seed` is only routed
  when `this.options.seedToken.length > 0`; otherwise it falls through to 404.
  Confirms "not registered unless `CADRE_SEED_TOKEN` is set."
- `health.ts:312` (`handleSeedRequest`) — calls `checkBearer(req, seedToken)`
  and returns 401 on failure. Confirms "requires `Authorization: Bearer <token>`."
- `packages/cadre-cli/src/commands/start.ts:168-177` — reads
  `process.env.CADRE_SEED_TOKEN`, passes it to `HealthServer`, and logs the
  enabled/disabled state. Confirms the env var name and gating.
The compose/README claims therefore describe the node as it actually behaves;
no stray "code behaves differently" implication.

### Checked: loopback-binding claim correctness — PASS (notable nuance verified)
The health/metrics servers listen on `0.0.0.0` *inside the container*
(`health.ts:300`, `:387`). The hardening operates at the Docker host-publish
layer: `127.0.0.1:8080:8080` restricts host exposure to loopback regardless of
the container's internal bind. The README/compose wording ("the compose template
binds both to 127.0.0.1 by default") is accurate for the host surface, which is
what an operator's firewall posture depends on.

### Checked: compose bind syntax parses — PASS
Parsed `docker-compose.yml` with a YAML loader: the document is well-formed and
the three port entries render as expected, with 4001 unbound and 8080/9090
loopback-bound. The short-syntax `IP:hostPort:containerPort/proto` form used is
valid Docker Compose. No new env-var-substitution conflict: setting
`CADRE_SEED_TOKEN` in `.env` injects consistently via both Compose substitution
(`${CADRE_SEED_TOKEN:-}`) and `env_file:` — same value, no clash (matches the
reference template).

### DEFERRED: `docker compose config` authoritative render — NOT RUN (environment limitation)
Docker is genuinely absent in the agent environment (`docker: command not found`
on both bash and the Windows host — re-confirmed this run). The YAML parse +
syntax check above is a strong proxy, but the authoritative `compose config`
render was not performed. A reviewer/operator with Docker can run, from
`ops/docker/sereus-node/` with a minimal `.env`:
`docker compose -f docker-compose.yml config` and confirm `127.0.0.1:8080` /
`127.0.0.1:9090` binds, an unbound 4001, and `CADRE_SEED_TOKEN` in the resolved
environment. This is low-risk: the same port form already ships and works in the
reference `packages/cadre-cli/docker/docker-compose.yml`.

### Lint / tests — N/A with reason
These files (`.yml`, `.example`, `.md`) are operational templates under `ops/`
and are outside every package's build/lint/test scope — ESLint's flat config
targets source files, and no package test references them. There is no code path
to exercise, so running the monorepo test suite would validate nothing related
to this change. Validation performed instead: YAML parse + behavioral
cross-check against `cadre-cli` source (both above).

### Finding (minor, NOT fixed — pre-existing & out of scope): dangling test-overlay reference
`README.md` "Integration Testing" still references a `docker-compose.test.yml`
overlay that does not exist in `ops/docker/sereus-node/` (confirmed via glob —
only the three files are present). This pre-dates this ticket and is unrelated to
the seed/binding hardening. It was left untouched deliberately: "fixing" it is a
design decision (add the overlay vs. remove the section) that belongs to whoever
owns the test-cluster story, not this docs-mirror pass. Because no overlay exists,
there is no way for a test config to re-publish 8080/9090, so the loopback default
cannot break a (currently non-existent) test cluster. Recommend a follow-up doc
fix when the integration-test story is settled; not blocking.

### Finding (informational): two duplicate node compose templates remain
The standing DRY hazard (this ticket exists because hardening had to be applied
twice) is already tracked by `tickets/backlog/consolidate-duplicate-cadre-node-docker-templates.md`
(verified present). No action needed here.

## Disposition

Accepted as-is. No inline fixes were required — the mirror is accurate and the
documented behavior matches the live code. No new tickets filed (the two standing
items are already tracked / out of scope). The only un-run validation is the
Docker-dependent `compose config` render, deferred due to environment limitation
and de-risked by the successful YAML parse and the identical, working reference
template.
