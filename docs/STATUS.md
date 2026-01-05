# Sereus – STATUS (Checklists)

This file is intentionally a **living checklist** of what’s done, what’s next, and what’s being debated.

Conventions:
- `[x]` done
- `[ ]` todo / planned
- `[~]` in progress / partially done

## Repo Structure / Scaffolding (Ops + Packages)

### Ops scaffold (Docker-first)
- [x] Create `sereus/ops/` and `sereus/ops/README.md`
- [x] Create `sereus/ops/docker/` and `sereus/ops/docker/README.md`
- [x] Create `sereus/ops/docker/bootstrap/README.md`
- [x] Create `sereus/ops/docker/relay/README.md`
- [x] Create `sereus/ops/docker/sereus-node/README.md`

### Fill in ops/docker with runnable artifacts
- [ ] Add initial Compose files (or placeholders) for:
  - [x] `sereus/ops/docker/bootstrap/docker-compose.yml`
  - [x] `sereus/ops/docker/relay/docker-compose.yml`
  - [~] `sereus/ops/docker/sereus-node/docker-compose.yml` (template; needs image/entrypoint)
  - [x] `sereus/ops/docker/bootstrap-relay/docker-compose.yml` (combined node)
- [~] Add env example files for each folder with the minimum required knobs
  - Note: dotfiles like `.env.example` are blocked in this workspace; using `env.example`.
- [ ] Decide image strategy:
  - [ ] Use prebuilt images (document source + tags)
  - [ ] Or build locally (add `Dockerfile` and scripts)
- [ ] Add helper scripts (if helpful):
  - [ ] `up.sh` / `down.sh` wrappers
  - [ ] log tailing / healthcheck scripts
- [ ] Document quickstart flows:
  - [ ] “Run a public relay”
  - [ ] “Run a private bootstrap node”
  - [ ] “Add a headless sereus-node to a cadre”

### `sereus-node` (deferred) – make it real
- [ ] Identify the runnable artifact:
  - [ ] Optimystic headless node image name(s) and tags
  - [ ] Entrypoint + required args/env
- [ ] Cadre enrollment:
  - [ ] Define how a node joins a cadre (token/QR/config, rotation, revoke)
  - [ ] Decide what secrets/state must persist on disk
- [ ] Docker wiring:
  - [ ] Map required ports (tcp/ws/quic/etc) and document firewall rules
  - [ ] Add healthcheck and minimal logging guidance
  - [ ] Add volume layout (keys, state, logs) and backup guidance
  - [ ] Add “start on reboot” instructions (systemd/docker enablement)

### Packages scaffold
- [x] Create `sereus/packages/` and `sereus/packages/README.md`
- [x] Move `sereus/bootstrap/` → `sereus/packages/bootstrap/` (keep npm name `@sereus/bootstrap`)
- [x] Update docs that referenced the old path (`sereus/docs/bootstrap.md`, manual test README)

## libp2p Strand Bootstrap Library (`@sereus/bootstrap`)

- [x] Keep protocol id default `'/sereus/bootstrap/1.0.0'` with override options
- [ ] Add diagrams to `sereus/docs/bootstrap.md`
  - [ ] 2-message flow (`responderCreates`)
  - [ ] 3-message flow (`initiatorCreates`, new stream)
  - [ ] rejection + timeout paths
- [ ] Decide whether to add an aggregator package/entrypoint (defer until ≥2 stable packages)

## Cadre Management (Specification + Schema)

Goal: define and implement how a user manages a **cadre** (their personal cluster of nodes/devices) including membership, provisioning, enrollment, and trust boundaries.

- [ ] Create a Cadre management spec doc (suggested: `sereus/docs/cadre.md`)
  - [ ] Definitions: cadre vs node vs device identity
  - [ ] Enrollment lifecycle (invite/join/rotate/revoke)
  - [ ] Key material / identity assumptions (where keys live, recovery, rotation)
  - [ ] Transport expectations (direct vs relay, addressing, reachability)
  - [ ] Operational requirements (headless node, backups, monitoring)
- [ ] Create an initial Cadre schema doc (suggested: `sereus/docs/cadre-schema.md`)
  - [ ] Tables: `cadres`, `cadre_nodes`, `node_keys`, `node_capabilities`, `node_status`
  - [ ] RBAC / permissions model (who can add/remove nodes)
  - [ ] Audit trail requirements
- [ ] Decide where the schema lives long-term:
  - [ ] As Quereus declarative schema blocks in docs
  - [ ] As `.sql` artifacts under a dedicated schema folder (TBD)

## Cohort Management (Specification + Schema)

Goal: define and implement how a **cohort** (all nodes belonging to a strand) is tracked, managed, and evolved. This likely becomes the conceptual replacement for the current “projects/bootstrap” direction.

- [ ] Create a Cohort management spec doc (suggested: `sereus/docs/cohort.md`)
  - [ ] Definitions: strand vs cohort vs cadre; relationship model
  - [ ] Cohort membership lifecycle (join/leave/ban/rehabilitate)
  - [ ] Discovery and reachability (bootstrap nodes vs relays vs “known peers”)
  - [ ] Security boundaries (cadre disclosure timing, trust levels, roles)
  - [ ] Multi-party bootstrap roadmap alignment
- [ ] Create an initial Cohort schema doc (suggested: `sereus/docs/cohort-schema.md`)
  - [ ] Tables: `strands`, `strand_members`, `member_nodes`, `roles`, `invitations`
  - [ ] Token/invitation encoding strategy (application-defined vs standardized)
  - [ ] Auditing and key rotation impacts

## Testing / CI

- [ ] Wire `@sereus/bootstrap` tests into workspace CI
- [ ] Add root-level scripts for running package tests consistently (Yarn workspace)


