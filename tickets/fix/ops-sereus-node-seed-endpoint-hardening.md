description: Apply the same loopback-binding + CADRE_SEED_TOKEN deployment hardening to the ops/docker/sereus-node template that cadre-cli/docker already received
prereq:
files: ops/docker/sereus-node/docker-compose.yml, ops/docker/sereus-node/env.example, ops/docker/sereus-node/README.md
----

## Problem

`cadre-cli-seed-endpoint-auth` hardened the **`packages/cadre-cli/docker/`**
deployment template against the gated `POST /seed` surface: it bound the health
(8080) and metrics (9090) host ports to `127.0.0.1` by default (overridable via
`HOST_HEALTH_BIND` / `HOST_METRICS_BIND`), added `CADRE_SEED_TOKEN` plumbing +
docs, and updated the README firewall guidance to say only 4001 should face the
public internet.

There is a **second, effectively identical deployment template** at
`ops/docker/sereus-node/` (its own `docker-compose.yml`, `env.example`, and
`README.md`) that builds and runs the *same* cadre node from the *same*
`packages/cadre-cli/docker/Dockerfile`. It was **not** touched and still:

- publishes the health port world-wide by default —
  `ops/docker/sereus-node/docker-compose.yml:49` →
  `"${HOST_HEALTH_PORT:-8080}:8080/tcp"` (and the same for 9090 on line 50);
- does not pass or document `CADRE_SEED_TOKEN` (no entry in `environment:` block,
  none in `env.example`);
- README "Endpoints" table (lines 30-38) and Quick Start (`curl http://localhost:8080/health`)
  give no firewall guidance and don't mention that `POST /seed` exists, is
  authenticated, and is off-by-default.

Result: the two templates are inconsistent — one is hardened, the other leaves
the same surface open. An operator who follows `ops/docker/sereus-node/` gets the
pre-hardening (world-published health/metrics) behavior.

This was found during review of `cadre-cli-seed-endpoint-auth`; it is a **major**
finding (out of that ticket's declared scope, which was strictly
`packages/cadre-cli/docker/` + that package's README), hence this separate ticket
rather than an inline fix.

## Design

Mirror the changes already landed in `packages/cadre-cli/docker/` (see commit
`ticket(implement): cadre-cli-seed-endpoint-auth`, df2202d) into the
`ops/docker/sereus-node/` template:

- **`docker-compose.yml`**: change the 8080 and 9090 port publishes to
  `"${HOST_HEALTH_BIND:-127.0.0.1}:${HOST_HEALTH_PORT:-8080}:8080/tcp"` and
  `"${HOST_METRICS_BIND:-127.0.0.1}:${HOST_METRICS_PORT:-9090}:9090/tcp"`; add
  `CADRE_SEED_TOKEN=${CADRE_SEED_TOKEN:-}` to the `environment:` block with the
  "OFF by default" comment.
- **`env.example`**: add `HOST_HEALTH_BIND=127.0.0.1` / `HOST_METRICS_BIND=127.0.0.1`
  and a commented `# CADRE_SEED_TOKEN=` with the same one-line note (suggest
  `openssl rand -hex 32`).
- **`README.md`**: add the `POST /seed` (authenticated, off-by-default) note to
  the Endpoints table, and a short firewall note that only 4001 should be public
  and 8080/9090 default to loopback.

## Considerations / open question for the implementer

- **DRY**: two near-duplicate compose templates for the same node is itself a
  maintenance hazard — every hardening/feature change must be applied twice (as
  this finding demonstrates). Worth deciding whether `ops/docker/sereus-node/`
  should be consolidated with `packages/cadre-cli/docker/` (or one made to
  reference the other) rather than perpetually kept in sync by hand. If
  consolidation is large/contentious, do the straight mirror here and file a
  separate backlog ticket for the dedup.
- Confirm whether `ops/docker/sereus-node/docker-compose.test.yml` (referenced by
  that README's integration-testing section) overrides the port publishes; if so,
  ensure the loopback default doesn't break the test cluster's cross-container or
  host access expectations.

## Validation

- No code changes expected. If the Dockerfile/test overlay is touched, run
  `yarn workspace @serfab/cadre-cli build` + `test`.
- A reviewer with Docker should `docker compose config` the edited template to
  confirm the `IFACE:HOST:CONTAINER/proto` bind syntax parses.
