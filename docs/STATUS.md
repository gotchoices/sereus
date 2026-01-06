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
- [x] Add env example files for each folder with the minimum required knobs
  - Note: dotfiles like `.env.example` are blocked in this workspace; using `env.example`.
- [ ] Decide image strategy:
  - [ ] (Deferred) Use prebuilt images (document source + tags)
  - [x] Build locally from the repo
  - [x] Consolidate `relay`/`bootstrap`/`bootstrap-relay` into a single image + ROLE dispatch (compose remains per-role)
    - Implemented: `sereus/ops/docker/libp2p-infra` image
    - Per-role compose sets `SEREUS_ROLE=...`; operator `env.local` stays host-facing only
- [ ] Add helper scripts (if helpful):
  - [x] `svc` (single entry point for `up`/`down`/`logs`)
- [x] Document quickstart flows:
  - [x] “Run a public relay” (`sereus/ops/docker/quickstarts/relay.md`)
  - [x] “Run a private bootstrap node” (`sereus/ops/docker/quickstarts/bootstrap.md`)
  - [ ] “Add a headless sereus-node to a cadre” (deferred; needs real image/entrypoint)

### Ops validation status (as-tested on `sereus.org`)
- [x] Relay container works (Circuit Relay v2 server)
  - Verified: a NAT'd listener can obtain a reservation and receive relayed inbound connections.
- [x] Bootstrap container works (Kad-DHT server peer)
  - Verified: `ops/test/check-node.mjs --dht` succeeds and `pair:dial --bootstrap-check` succeeds.
- [x] NAT-to-NAT test pair works **when using an explicit relayed dial address**
  - Listener prints a copy/paste dial address like:
    - `/dns4/relay.sereus.org/tcp/4001/p2p/<relayPeerId>/p2p-circuit/p2p/<listenerPeerId>`
  - Dialer succeeds when invoked with `--dial-addr "<that addr>"`
- [~] Bootstrap-only discovery (`dht.findPeer(listenerPeerId)`) is **not working yet**
  - Current outcome: the dialer times out (no `FINAL_PEER` result) even after the listener:
    - reserves on the relay
    - listens on `/p2p-circuit`
    - dials the bootstrap and refreshes routing tables
  - Practical implication: today you can prove relay reachability, but not yet the full “dial by Peer ID via bootstrap-only DHT lookup” flow.

### Next paths to make bootstrap-only discovery work
- [ ] Add explicit “publish self to DHT” step(s) in the listener (instead of relying on passive routing-table learning)
  - Candidate: ensure the listener publishes a signed peer record / provider-style record that the bootstrap peer will return during `findPeer`.
  - Add verbose tracing in both listener and dialer for DHT protocol traffic so we can see whether the bootstrap peer ever learns/stores the listener.
- [ ] Evaluate switching the test pair from Kad-DHT to **FRET DHT** for small overlays
  - Rationale: Kademlia peer routing is a poor fit for a 1-node “DHT” unless the bootstrap peer reliably learns/stores peers.
  - Goal: dialer can resolve listener addresses using only:
    - `--bootstrap /dnsaddr/bootstrap.sereus.org`
    - `--peer <listenerPeerId>`

### Ops code sharing / multi-deployment support (deferred)
- [ ] Decide whether the libp2p node “apps” should live outside `ops/docker/*` so they can be reused by:
  - [ ] Docker Compose
  - [ ] systemd (bare server)
  - [ ] future k8s/helm deployment
- [ ] Modularize runbook docs/READMEs so common guidance is centralized and referenced:
  - [x] `sereus/ops/docs/dnsaddr.md`
  - [x] `sereus/ops/docs/keys.md`
- [ ] If yes: propose target layout (one of):
  - [ ] `sereus/ops/node-apps/{relay,bootstrap,bootstrap-relay}` + `sereus/ops/node-apps/lib/` for shared utilities
  - [ ] `sereus/packages/@sereus/libp2p-infra` (publishable) + thin wrappers in `ops/*`
- [ ] Identify what should be shared vs per-role:
  - [ ] key persistence + Peer ID printing
  - [ ] listen/announce address handling
  - [ ] logging + healthchecks
  - [ ] relay limits/config (when we add them)
  - [ ] DHT settings (if we keep DHT on bootstrap peers)

### `sereus-node` (deferred) – make it real
- [ ] Reality check: what Optimystic already provides (and gaps)
  - [x] **Protocol isolation via `networkName`** is implemented.
    - All Optimystic protocols are prefixed like `/optimystic/{networkName}/...` (see `optimystic/PROTOCOL-ISOLATION.md` and `@optimystic/db-p2p` `createLibp2pNode`).
    - Implication: a “cadre” very likely maps 1:1 to an Optimystic `networkName` (or a deterministic derivation like `sereus-cadre-${cadreId}`).
  - [x] A headless libp2p+Optimystic runtime exists for development/testing:
    - `optimystic/packages/test-peer` has a `service` command (no REPL) that starts a node via `@optimystic/db-p2p` `createLibp2pNode`.
    - It supports: `--network`, `--bootstrap` / `--bootstrap-file`, `--storage file|memory`, `--storage-path`, `--fret-profile edge|core`.
  - [ ] **Identity persistence is not clearly implemented**
    - `@optimystic/db-p2p` currently accepts `id?: string` and uses `peerIdFromString(id)` (no explicit private key load/save).
    - For a real `sereus-node`, we need **stable PeerID** (and the corresponding private key) across restarts.
    - TODO: decide on a persistence format (protobuf/JSON) and implement `--key-file` (or similar) in a dedicated node runner.
  - [ ] `relay?: boolean` exists in `NodeOptions` but appears **unused** in `createLibp2pNode` today (no circuit-relay service).
  - [ ] Cluster membership logic is in flux:
    - `optimystic/packages/db-p2p/src/cluster/service.ts` includes a note to “Re-enable and fix cluster membership logic for proper DHT routing”.

- [ ] Identify the runnable artifact (production direction)
  - [ ] Decide: should `sereus-node` run **Optimystic-only** (storage + p2p) or also embed **Quereus** (SQL surface)?
    - Hypothesis: Optimystic provides the p2p/storage substrate; Quereus is a higher-level access plane and may run separately and connect as a client.
  - [ ] Decide the bootstrap story for cadre networks:
    - `bootstrapNodes` in `@optimystic/db-p2p` are used for libp2p bootstrap discovery and also fed into FRET.
    - Question: do we expect operators to point `sereus-node` at **other Optimystic nodes** (recommended), vs pointing at generic libp2p bootstrap peers (likely not useful unless Optimystic also uses libp2p DHT directly).
  - [ ] Define minimum env/args for a first runnable “cadre member”:
    - `NETWORK_NAME` (cadre network name)
    - `BOOTSTRAP_ADDRS` (comma-separated multiaddrs, preferably `/dnsaddr/...`)
    - `LISTEN_PORT`
    - `STORAGE_PATH` + `STORAGE_CAPACITY_BYTES` (Arachnode ring selection)
    - `FRET_PROFILE=edge|core` (role tuning)
    - `CLUSTER_SIZE` + policy knobs (downsize/tolerance)

- [ ] Cadre enrollment (Sereus layer; not in Optimystic yet)
  - [ ] Define how a node joins a cadre:
    - What does an “enrollment token” contain? (cadre id, networkName, bootstrap list, auth, expiry)
    - How is it rotated/revoked?
  - [ ] Decide what secrets/state must persist on disk:
    - libp2p private key (PeerID)
    - Optimystic storage repo (file storage path)
    - any cadre enrollment state / certificates / ACLs (TBD)

- [ ] Bring `sereus/ops/docker/sereus-node` up to the current ops patterns
  - [ ] Replace the current placeholder `SEREUS_NODE_IMAGE` approach with either:
    - a local-build Dockerfile + entrypoint (preferred, consistent with other ops/docker stacks), or
    - an explicitly deferred “prebuilt image” doc.
  - [ ] Refactor `env.example` to host-level knobs (`HOST_PORT`, `HOST_BIND_IP`, `HOST_DATA_DIR`) plus the minimum `sereus-node` knobs above.
  - [ ] Update the compose file to use `./svc` and `--env-file env.local` workflow (same as relay/bootstrap).

- [ ] Docker wiring
  - [ ] Map required ports (tcp/ws/quic/etc) and document firewall rules (start with tcp only)
  - [ ] Add healthcheck and minimal logging guidance (PeerID, multiaddrs, networkName)
  - [ ] Add volume layout and backup guidance (keys + storage)
  - [ ] Add “start on reboot” instructions (Docker enablement + `restart: unless-stopped`)

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


