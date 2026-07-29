description: Removed the duplicate copy of the headless cadre-node Docker deployment files so future hardening/feature changes only need to be made once
prereq:
files: ops/docker/sereus-node/README.md, ops/docker/README.md, docs/STATUS.md, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/cadre-cli/README.md
difficulty: easy
----

## What changed

`ops/docker/sereus-node/` and `packages/cadre-cli/docker/` were two
near-identical copies of the same Docker Compose deployment for the headless
cadre node — same `Dockerfile` reference, same env vars, drifting comments.
Consolidated to a single source of truth (Option A from the ticket):

- **Canonical, unchanged:** `packages/cadre-cli/docker/` (`Dockerfile`,
  `docker-compose.yml`, `env.example`, `entrypoint.sh`) — already referenced by
  `packages/cadre-cli/README.md` → **Docker Deployment**. No behavior change.
- **Removed:** `ops/docker/sereus-node/docker-compose.yml` and
  `ops/docker/sereus-node/env.example` (the duplicates).
- **Rewritten:** `ops/docker/sereus-node/README.md` is now a short pointer
  explaining the removal, linking to the canonical template, and explaining
  why `sereus-node/` isn't a peer of `relay/`/`bootstrap/`/etc (it's
  per-user cadre infra, not shared ops infra — confirmed it was never wired
  into `ops/scripts/install`'s service list, and had no `quickstarts/` entry).
- **Updated:** `ops/docker/README.md`'s Contents section, so the `sereus-node/`
  bullet no longer implies a deployable folder with its own
  `env.example`/`docker-compose.yml`.
- **Updated:** `docs/STATUS.md` — the "`sereus-node` (deferred) – make it
  real" section had several stale bullets claiming the compose file was still
  a placeholder needing "image/entrypoint" (it already builds from the real
  `packages/cadre-cli/docker/Dockerfile` and has for a while). Added a dated
  "Superseded" note, struck the now-moot sub-bullets (moving to the
  `./svc`/`env.local` ops pattern was never appropriate here — a
  `sereus-node` belongs to one user's cadre, not shared ops infra), and fixed
  two other stale mentions in the same file.

## Investigation that ruled out other options

- `ops/scripts/install`'s `case "$service"` only accepts
  `relay|bootstrap|bootstrap-relay|coturn|turn-credential-issuer` —
  `sereus-node` was never wired into the ops installer/site-instance flow.
- `ops/docker/sereus-node/README.md`'s "Integration Testing" section
  referenced `docker-compose.test.yml`, which does not exist anywhere in the
  repo (confirmed via repo-wide search) — a stale reference, now gone since
  that README was rewritten.
- Repo-wide grep for `sereus-node` and `packages/cadre-cli/docker` turned up
  no other scripts/CI/docs hard-coding the old duplicated paths.
  `tickets/backlog/cadre-docker-build-reproducibility.md` already references
  only the canonical `packages/cadre-cli/docker/` path — no update needed
  there.

## Scope honored

No application or Dockerfile behavior change — `packages/cadre-cli/docker/`
(the file the two templates both ultimately build from) is untouched byte for
byte. This is purely doc/template/ops restructuring, as the ticket specified.

## For the reviewer

- **Not independently tested at runtime**: I did not `docker compose up`
  either before or after — the change is a deletion of a byte-for-byte
  duplicate plus doc rewrites, not a change to the file that actually builds
  the image. Worth a sanity check that `packages/cadre-cli/docker/` alone
  still `docker compose config`-validates if you want stronger confidence,
  but nothing in this diff touches that file.
  `ops/` is excluded from `eslint.config.mjs` (confirmed), so there's no lint
  gate over the changed ops files; the markdown edits were reviewed by eye for
  broken relative links.
  - Verify: `docker compose -f packages/cadre-cli/docker/docker-compose.yml config` (needs `.env` with `CADRE_PARTY_ID`/`CADRE_BOOTSTRAP_NODES` set or it'll fail on the `:?required` interpolation — that's expected/unchanged behavior, not a regression).
- **`docs/STATUS.md` edits are broader than the minimum** — I also fixed two
  other stale "sereus-node needs a real image/entrypoint" mentions in the same
  file (line ~23 checklist item, and the quickstarts bullet) since they'd
  otherwise directly contradict the new "Superseded" note a few lines below.
  If that's considered out of the ticket's stated scope, it's easy to revert
  those two lines independently — they're cosmetic doc fixes, not required
  for the consolidation to be correct.
- No tripwires identified — this was a strict duplicate-removal with no
  conditional/future concerns to flag.
