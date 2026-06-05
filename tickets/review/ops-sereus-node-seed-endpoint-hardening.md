description: Review the loopback-binding + CADRE_SEED_TOKEN deployment hardening mirrored into ops/docker/sereus-node (compose, env.example, README) — docs/config only, no application code
prereq:
files: ops/docker/sereus-node/docker-compose.yml, ops/docker/sereus-node/env.example, ops/docker/sereus-node/README.md
----

## What changed

A straight mirror of the already-landed `packages/cadre-cli/docker/` hardening
(commit `df2202d`, ticket `cadre-cli-seed-endpoint-auth`) into the second,
near-identical deployment template at `ops/docker/sereus-node/`. **No application
code changed** — three template/doc files only:

### `ops/docker/sereus-node/docker-compose.yml`
- Added `- CADRE_SEED_TOKEN=${CADRE_SEED_TOKEN:-}` to the `environment:` block
  (with an OFF-by-default explanatory comment).
- Changed the 8080/9090 host publishes from unbound
  (`"${HOST_HEALTH_PORT:-8080}:8080/tcp"`) to loopback-bound
  (`"${HOST_HEALTH_BIND:-127.0.0.1}:${HOST_HEALTH_PORT:-8080}:8080/tcp"` and the
  analogous metrics line). The **4001 publish is intentionally left unbound** —
  it is the only port that should reach the public internet.

### `ops/docker/sereus-node/env.example`
- Added `HOST_HEALTH_BIND=127.0.0.1` / `HOST_METRICS_BIND=127.0.0.1` right after
  the `HOST_*_PORT` lines, with a comment explaining the loopback default.
- Added a new `# === SEED DELIVERY (OPTIONAL) ===` banner section with a
  commented-out `# CADRE_SEED_TOKEN=` and bearer-auth explanation, placed
  between the STRAND FILTER and PROVIDER INTEGRATION sections.

### `ops/docker/sereus-node/README.md`
- Added a `| 8080 | POST /seed | ... |` row to the Endpoints table
  (authenticated, off unless `CADRE_SEED_TOKEN` set).
- Added a blockquote firewall note after the table: only 4001 is public; 8080/9090
  are loopback-bound by default (override via `HOST_HEALTH_BIND` /
  `HOST_METRICS_BIND`); `POST /seed` is additionally bearer-gated and unregistered
  unless `CADRE_SEED_TOKEN` is set.
- Minor Quick Start polish: annotated the `curl …:8080/health` step to note it
  works from the host loopback by default.

## Net behavioral effect for an operator

Following `ops/docker/sereus-node/` now yields the **same hardened posture** as
`packages/cadre-cli/docker/`: health (8080) and metrics (9090) bind to
`127.0.0.1` by default instead of `0.0.0.0`, the (off-by-default, bearer-gated)
`POST /seed` surface is documented, and the README gives explicit firewall
guidance. Both templates build/run the same node from
`packages/cadre-cli/docker/Dockerfile`.

## Validation performed

- `git diff` reviewed — matches the reference template wording, adapted to the
  `ops/` files' section comments. Diff is in this ticket's scope only (the three
  files above).
- **No build/test run**: this is a docs/compose-config-only change with zero
  application code touched, so the test suite is unaffected.

## Validation DEFERRED (reviewer action)

- **`docker compose config` parse check was NOT run** — Docker is not installed
  in the agent environment (`docker: command not found` on both bash and the
  Windows host). A reviewer with Docker should run, from `ops/docker/sereus-node/`
  with a minimal `.env` (`CADRE_PARTY_ID=...`, `CADRE_BOOTSTRAP_NODES=...`):

  ```bash
  docker compose -f docker-compose.yml config
  ```

  and confirm the rendered output shows:
  - `127.0.0.1:8080` / `127.0.0.1:9090` bind addresses on the 8080/9090 mappings,
  - the 4001 mapping still **unbound** (no `127.0.0.1` prefix),
  - `CADRE_SEED_TOKEN` present in the resolved `environment`.

  The compose short-syntax port form used is `[IP:][hostPort:]containerPort/proto`,
  which is valid, but a real `compose config` render is the authoritative check
  and has not been performed here.

## Things to confirm during review

- **Bind syntax correctness**: verify the `${HOST_HEALTH_BIND:-127.0.0.1}:${HOST_HEALTH_PORT:-8080}:8080/tcp`
  triple-segment form parses as expected (it should — interface, host port,
  container port). This is the only change with any parse risk.
- **Wording fidelity**: the comments/sections were adapted (not byte-copied) from
  the cadre-cli template to fit the `ops/` files' existing comment style. Confirm
  nothing drifted semantically from the reference (e.g. the seed endpoint is
  authenticated AND off-by-default — both qualifiers should be present everywhere).
- **No stray application/test claims**: confirm the change really is docs/config
  only and does not imply the node code behaves differently than the cadre-cli
  template already documents.

## Known gaps / non-goals

- The README's "Integration Testing" section still references a
  `docker-compose.test.yml` overlay that **does not exist** in the repo. This
  pre-dates this ticket and was confirmed in the source ticket's research notes
  (there is therefore no test overlay that could re-publish 8080/9090, so the
  loopback default cannot break a test cluster). This ticket intentionally did
  **not** fix that dangling reference — flagging it for the reviewer as a
  potential follow-up, but it is out of scope here.
- **DRY hazard**: two near-duplicate compose templates for the same node remain.
  A backlog ticket `consolidate-duplicate-cadre-node-docker-templates` was filed
  (per the source ticket) to decide on consolidation. Not actioned here.
