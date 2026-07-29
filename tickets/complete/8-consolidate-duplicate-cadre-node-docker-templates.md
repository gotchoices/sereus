description: Removed the duplicate copy of the headless cadre-node Docker deployment files so future hardening/feature changes only need to be made once
prereq:
files: ops/docker/sereus-node/README.md, ops/docker/README.md, docs/STATUS.md, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/cadre-cli/README.md
difficulty: easy
----

## What changed

`ops/docker/sereus-node/` and `packages/cadre-cli/docker/` were two
near-identical copies of the same Docker Compose deployment for the headless
cadre node — same `Dockerfile` reference, same env vars, drifting comments.
Consolidated to a single source of truth:

- **Canonical, unchanged behavior:** `packages/cadre-cli/docker/` (`Dockerfile`,
  `docker-compose.yml`, `env.example`, `entrypoint.sh`) — referenced by
  `packages/cadre-cli/README.md` → **Docker Deployment**.
- **Removed:** `ops/docker/sereus-node/docker-compose.yml` and
  `ops/docker/sereus-node/env.example` (the duplicates).
- **Rewritten:** `ops/docker/sereus-node/README.md` → short pointer at the
  canonical template, plus why this folder isn't a peer of
  `relay/`/`bootstrap/`/`coturn/` (a cadre node belongs to one user's cadre,
  not to shared ops infrastructure; it was never wired into
  `ops/scripts/install`, and has no `quickstarts/` entry).
- **Updated:** `ops/docker/README.md` contents bullet; `docs/STATUS.md` — the
  "`sereus-node` (deferred) – make it real" section carried stale bullets
  claiming the compose file was a placeholder needing an image/entrypoint (it
  builds from the real `packages/cadre-cli/docker/Dockerfile`). Added a dated
  "Superseded" note, struck the moot sub-bullets, fixed two other stale
  mentions in the same file.

## Review findings

### Checked

- **Nothing lost in the deletion.** Diffed both deleted files against the
  canonical ones (`git show cd9290f^:ops/docker/sereus-node/<file>` vs
  `packages/cadre-cli/docker/<file>`). Canonical `docker-compose.yml` is a
  strict superset: it carries every env var and all the security hardening the
  ops copy had (loopback default for `HOST_HEALTH_BIND`/`HOST_METRICS_BIND`,
  `CADRE_SEED_TOKEN` gating, `CADRE_OWNER_KEYS` pinning) and additionally has
  memory limits, an optional key-file mount hint, and an explicit bridge
  network. The deletion therefore removed no deployable capability.
- **Dangling references.** Repo-wide grep for `sereus-node`: only `docs/STATUS.md`,
  `ops/docker/README.md`, and the pointer README remain — no script, CI, or
  compose file referenced the deleted paths.
- **Ops installer.** `ops/scripts/install` resolves services from an explicit
  allowlist (`relay|bootstrap|bootstrap-relay|coturn|turn-credential-issuer`)
  and does not enumerate `ops/docker/*` looking for `env.example`, so removing
  those two files cannot break the installer's `env.example`→`env.local` flow.
- **Relative links.** `../../../packages/cadre-cli/docker/` from
  `ops/docker/sereus-node/` and `../../packages/cadre-cli/docker/` from
  `ops/docker/` both resolve to the repo root correctly. The `STATUS.md`
  "Superseded" note links to `tickets/complete/8-consolidate-duplicate-cadre-node-docker-templates.md`
  — this file, filed under that exact name, so the link resolves.
- **Docs the change *should* have touched.** Verified `packages/cadre-cli/README.md`
  already documents the ports table, the health/metrics exposure warning, and
  the Docker data locations that the deleted ops README duplicated — so those
  weren't orphaned. Two things were only in the deleted README (below).
- **Runtime.** `docker` is not installed in this environment, so
  `docker compose config` could not be run. Not a gap the diff introduces: the
  canonical compose file is untouched by this ticket, byte for byte.

### Found and fixed inline (minor)

- **`CADRE_ENABLE_RELAY` lost its only documentation.** The canonical
  `docker-compose.yml` passes `CADRE_ENABLE_RELAY` through, but the canonical
  `env.example` never mentioned it — the deleted ops `env.example` was the only
  place it was documented. Re-added to `packages/cadre-cli/docker/env.example`,
  with the default confirmed against
  `packages/cadre-core/src/cadre-node.ts:722` (`enableRelay ?? profile === 'storage'`).
- **Docker peer-key backup guidance lost.** The deleted ops README was the only
  doc explaining how to get the peer identity out of the Docker volume. Added a
  two-line note to `packages/cadre-cli/README.md` → **Docker Deployment** (the
  canonical home for it).
- **`ops/docker/README.md` bullet inaccurate and overlong.** It said the folder
  is "not a shared ops service like the ones below" while `sereus-node/` sits
  mid-list, and pointed at `./sereus/ops/scripts/install` (a path only valid
  from outside the repo). Reworded and corrected to `../scripts/install`.

### Found — major (new tickets)

None. The diff is a documentation/template consolidation with no code or
Dockerfile change; nothing found warranted its own ticket.

### Tripwires

None filed separately. The one conditional concern — whether a `sereus-node`
should eventually adopt the shared `./svc` + `env.local` ops pattern used by
`relay`/`bootstrap` — is already stated with its rationale in
`ops/docker/sereus-node/README.md` ("Why this isn't a peer of …") and in the
`docs/STATUS.md` Superseded note, which is exactly where a future reader hits
the question.

### Validation

- `yarn lint` — exit 0. (`ops/` is excluded from `eslint.config.mjs`, so the
  ops markdown has no lint gate; links reviewed by eye.)
- `yarn test` — `cadre-core`, `cadre-cli`, `quereus-plugin-sereus`, and
  `cadre-host` workspaces all green (8/55/54/15 files). `integration-tests`:
  17 failures, every one already listed in `tickets/.pre-existing-known.md`
  against the blocked slug `control-db-convergence-optimystic-p2p`. No new
  failures; nothing skipped or loosened; not re-reported per the workflow rules.
