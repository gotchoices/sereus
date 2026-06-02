description: Deployment-surface hardening for the gated POST /seed in the standalone cadre-cli docker template + operator docs (loopback host-port binding, CADRE_SEED_TOKEN docs)
prereq:
files: packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/cadre-cli/README.md
----

## Summary

Hardened the standalone **cadre-cli** docker-compose template and operator docs
for the now-gated `POST /seed`. No code changes — the bearer gate
(`src/server/health.ts`), `CADRE_SEED_TOKEN` wiring (`src/commands/start.ts:168`),
the `checkBearer` helper (`src/server/bearer.ts`), and `test/health-server.spec.ts`
all landed earlier in `seed-network-path-authn` and were untouched.

What landed (implement commit `df2202d`):

- **`docker-compose.yml`** — health (8080) and metrics (9090) host ports now bind
  `127.0.0.1` by default via `${HOST_HEALTH_BIND:-127.0.0.1}` /
  `${HOST_METRICS_BIND:-127.0.0.1}`; added `CADRE_SEED_TOKEN=${CADRE_SEED_TOKEN:-}`
  (off by default) with explanatory comments.
- **`env.example`** — `HOST_HEALTH_BIND` / `HOST_METRICS_BIND` (default
  `127.0.0.1`) and a commented `CADRE_SEED_TOKEN` under a new "Seed Delivery"
  section.
- **`README.md`** — `CADRE_SEED_TOKEN` env-var row; port-table notes that 8080 is
  read-only + `/seed` is authenticated/off-by-default; firewall section stating
  only 4001 should face the public internet.

The implementer's notable extension beyond the literal ticket (applying the
loopback default to **9090** as well as 8080) was reviewed and **accepted** — it
is the correct defense-in-depth default and keeps the compose template consistent
with the README firewall guidance.

## Review findings

### Verified (code-side claims the docs depend on)
Confirmed by inspection that the docs accurately describe the shipped behavior:
- `CADRE_SEED_TOKEN` is read at `src/commands/start.ts:168` (`process.env.CADRE_SEED_TOKEN ?? ''`)
  and passed to `HealthServer`.
- `POST /seed` is registered **only** when `seedToken.length > 0`
  (`src/server/health.ts:284`); otherwise it falls through to 404. → docs'
  "off-by-default / 404" claim holds.
- Auth: 401 on missing/invalid bearer (`health.ts:312`, constant-time
  `checkBearer` in `bearer.ts`), 413 on bodies over `MAX_SEED_BODY_BYTES`
  (256 KiB, `health.ts:331`).
- Both the health and metrics servers bind `0.0.0.0` **inside the container**
  (`health.ts:300`, `health.ts:387`). This validates the handoff's healthcheck
  reasoning: the in-container `wget http://localhost:8080/health` is unaffected by
  the *host* loopback port binding. **Confirmed by inspection.**
- `test/health-server.spec.ts` covers 404-unregistered, 401 (missing + wrong
  bearer), 413 oversize, 400 malformed/missing-field, 200 valid bearer, and
  non-POST-method 404. Full suite: **50 tests passed (5 files)**.

### Docs consistency (checked)
- Var names in `env.example` exactly match `docker-compose.yml`
  (`HOST_HEALTH_BIND`, `HOST_METRICS_BIND`, `CADRE_SEED_TOKEN`). ✓
- Closed-by-default flow traced end to end: commented `CADRE_SEED_TOKEN` →
  `${CADRE_SEED_TOKEN:-}` → empty → `seedToken.length === 0` → route unregistered. ✓
- Compose `IFACE:HOST:CONTAINER/proto` bind syntax is standard; not validated
  against a live Docker daemon (none in this env) — same caveat the implementer
  flagged.

### Fixed inline (minor)
- README port table: the **9090** row still read bare "Prometheus metrics
  (`/metrics`)" while 8080 had been annotated and the compose 9090 publish had
  been hardened to loopback. Added "— read-only; keep off the public internet" to
  the 9090 row for table-level consistency with the firewall guidance.

### Filed as new ticket (major)
- **`fix/ops-sereus-node-seed-endpoint-hardening`** — discovered a second,
  effectively identical deployment template at `ops/docker/sereus-node/` (its own
  `docker-compose.yml`, `env.example`, `README.md`) that runs the same node from
  the same Dockerfile but was **not** hardened: it still world-publishes 8080/9090
  and neither passes nor documents `CADRE_SEED_TOKEN`. Out of this ticket's
  declared scope (`packages/cadre-cli/docker/` only), so filed as a fix ticket
  that mirrors these changes and raises the DRY question of two duplicate
  templates.

### Observations (not actioned)
- The health/metrics servers hardcode a `0.0.0.0` listen interface; there is no
  env to make the *app itself* bind loopback. So the README's "keep them on
  loopback" is achievable only via the Docker host-port binding — for bare
  systemd/npm deployments the firewall (the documented `ufw` rule) is the actual
  control. The README is accurate (it attributes the loopback default
  specifically to "The Docker Compose template"), so left as-is; noted for
  awareness.

### Not re-reviewed (out of scope)
- The seed-auth code logic itself (owned by completed `seed-network-path-authn`).
- The provider counterpart (`cadre-provider-seed-endpoint-auth`).
- The seed *trust-policy* gap (`seed-trust-policy-and-authority-identity`,
  already landed) — orthogonal; a valid bearer authenticates the delivery path,
  not seed contents.

## Validation

- `yarn workspace @serfab/cadre-cli test` → **50 passed (5 files)**, including the
  seed-auth/401/413/404 suite.
- `yarn lint` (monorepo) surfaces a large **pre-existing** failure unrelated to
  this docs-only diff (generated NativeScript Android bundles being linted, etc.);
  `cadre-cli` lints clean and was not in the error set. Flagged in
  `tickets/.pre-existing-error.md` for the triage pass.
