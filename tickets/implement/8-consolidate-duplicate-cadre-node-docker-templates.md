----
description: Eliminate the duplicate cadre-node Docker deployment templates (ops/docker/sereus-node vs packages/cadre-cli/docker) so hardening/feature changes need only be applied once
prereq:
files: ops/docker/sereus-node/docker-compose.yml, ops/docker/sereus-node/env.example, ops/docker/sereus-node/README.md, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/README.md
difficulty: easy
----

## Problem / motivation

There are two near-identical Docker deployment templates that build and run the
**same** headless cadre node from the **same**
`packages/cadre-cli/docker/Dockerfile`:

- `packages/cadre-cli/docker/` (`docker-compose.yml`, `env.example`)
- `ops/docker/sereus-node/` (`docker-compose.yml`, `env.example`, `README.md`)

Their `docker-compose.yml`, `env.example`, and endpoint docs differ only in
minor comment wording and which knobs they expose. Because they are maintained by
hand, they drift: the `cadre-cli-seed-endpoint-auth` hardening (loopback binding
of 8080/9090 + `CADRE_SEED_TOKEN` plumbing) landed only in
`packages/cadre-cli/docker/` and had to be re-applied to `ops/docker/sereus-node/`
in a follow-up (`ops-sereus-node-seed-endpoint-hardening`). Every future
hardening/feature change risks the same one-sided drift.

This is a future-facing maintainability concern, not an active bug — hence
backlog. It should be promoted once someone decides the direction.

## What to decide / specify

The human (or a plan-stage agent) needs to pick a consolidation strategy and
confirm there is no consumer that depends on both paths existing independently:

- **Option A — single source of truth, one references the other.** Keep one
  canonical template (likely `packages/cadre-cli/docker/`, since it owns the
  Dockerfile) and have `ops/docker/sereus-node/` either be removed or reduced to
  a thin pointer/symlink/README that says "use packages/cadre-cli/docker".
- **Option B — shared base + overlay.** Factor common config into a base compose
  file and express each deployment as an overlay (`-f base.yml -f ops.yml`),
  removing the copy-paste.
- **Option C — generate one from the other** at build/release time.

Open questions to resolve before implementing:

- Who actually consumes `ops/docker/sereus-node/`? The `ops/` tree is described
  in AGENTS.md as "operational tooling (Docker stacks, systemd scaffolds…) for
  libp2p relay/bootstrap nodes" — confirm whether the relay/bootstrap ops flows
  reference this specific template or whether it is redundant with the package
  template.
- The `ops/docker/sereus-node/README.md` references a `docker-compose.test.yml`
  integration overlay that **does not currently exist** in the repo. Consolidation
  should either restore/define that overlay or drop the stale reference.
- Cross-platform: any docs / scripts that hard-code one path or the other must be
  updated.

## Scope

Documentation/template/ops restructuring only — no application or Dockerfile
behavior change is intended. If consolidation reveals a needed Dockerfile change,
split that out.
