## Sereus Fabric

Sereus is a Web3 programming fabric built on consent-based strands where users control identity, data, and connections. Instead of global identities and central brokers, Sereus forms small, private subnets by invitation only. Each strand is a shared SQL database with role-based permissions, distributed across participants' devices for resilience.

### Why Sereus
- **Privacy by design**: No global identity directory; identities exist only within strands you join.
- **Direct peer connections**: libp2p multiaddresses enable end-to-end encrypted, serverless communication.
- **Familiar SQL**: Each strand is a relational database; apps read/write via standard SQL.
- **Decentralized & resilient**: Data is distributed across participants' devices (cadres).
- **Developer-friendly**: Focus on application logic; the fabric handles distribution and transport.

### Core Concepts
- **Strand**: An invitation-only trust domain backed by a shared SQL database with RBAC.
- **Cadre**: The set of nodes (phone, laptop, NAS, cloud server, …) that one party uses to participate. A cadre has a private **control network** (its own Optimystic DB on the `CadreControl` schema) that tracks members, authority keys, and strand participation.
- **Cohort**: All cadres of all members of a given strand — the combined peer set that hosts that strand's data.
- **Transport**: libp2p (NAT traversal, relays, encrypted streams).

### Technology Stack
- **Quereus** (SQL processor) — query parsing, transactions, distribution-aware planning. External (`../quereus`).
- **Optimystic** (storage engine) — B-trees, block storage, sharding, sync, plus FRET DHT for content addressing and node discovery. External (`../optimystic`).
- **libp2p** — addressing, NAT traversal, circuit relays, encryption.

### Repo Layout

This monorepo is split into three top-level areas:

- `packages/` — published libraries and apps (see below).
- `ops/` — operational tooling for running infrastructure (libp2p relay/bootstrap, Docker stacks, runbooks).
- `docs/` — design, architecture, and protocol documentation. **Start with [`docs/architecture.md`](docs/architecture.md).** Public site source is in `docs/web/`.
- `schemas/` — Quereus schema artifacts (e.g. `strand.qsql`, `cadre.qsql`).
- `tickets/` and `tess/` — AI-driven ticket workflow (see [`tess/agent-rules/tickets.md`](tess/agent-rules/tickets.md)).

### Packages

| Package | Purpose |
| --- | --- |
| [`@serfab/cadre-core`](packages/cadre-core) | Core library that runs a cadre node: connects to the control network, watches the `Strand` table, starts/stops per-strand libp2p+Optimystic instances, manages enrollment and seeds. Used by every runtime below. |
| [`@serfab/cadre-cli`](packages/cadre-cli) | CLI wrapper to start and manage a single cadre node from a `cadre.yaml` config — the headless deployment target for servers, NAS boxes, and CI. |
| [`@serfab/cadre-host`](packages/cadre-host) | Self-hosted cadre manager for an always-on home machine. Spawns cadre nodes as native child processes, ships a localhost Svelte UI, an installer (systemd-user / LaunchAgent / NSSM), DDNS + UPnP/PCP NAT layer, and a trust-circle invite flow. Sibling of `cadre-provider`. |
| [`@serfab/cadre-provider`](packages/cadre-provider) | Reference provider service for hosting cadre nodes on behalf of paying users — Docker-based orchestration, API keys / JWT, quotas, billing hooks. |
| [`@serfab/quereus-plugin-sereus`](packages/quereus-plugin-sereus) | Quereus plugin that exposes a Sereus strand as a SQL database. Composes the `@optimystic/quereus-plugin-crypto` and `@optimystic/quereus-plugin-optimystic` plugins and manages libp2p. |
| [`@serfab/strand-proto`](packages/strand-proto) | Invitation-based libp2p bootstrap protocol for provisioning a shared strand. **Deprecated** — kept for reference while strand formation moves into `cadre-core`. |
| [`@serfab/reference-app-rn`](packages/reference-app-rn) | React Native reference app: a peer-to-peer chat that exercises the full cadre + strand stack on phones. |
| [`@serfab/reference-app-web`](packages/reference-app-web) | Svelte 5 + Vite SPA counterpart to the RN app; validates the Optimystic stack in a browser. |
| [`@serfab/integration-tests`](packages/integration-tests) | Multi-process integration tests that drive real libp2p networking, storage, and multi-party scenarios across the cadre packages. |

External workspaces this monorepo depends on (linked via `resolutions` in the root `package.json`): `../quereus` and `../optimystic`.

### Getting Started

#### As an application developer

1. Read [`docs/architecture.md`](docs/architecture.md) for the cadre/strand model (control network, cohorts, seeds, enrollment).
2. Pick a cadre runtime:
   - Headless server / NAS → `@serfab/cadre-cli` (see its README for `cadre.yaml`).
   - Home machine for a small trust circle → `@serfab/cadre-host` (`npm i -g @serfab/cadre-host && cadre-host install`).
   - In-app embedded node → depend on `@serfab/cadre-core` directly (see `packages/reference-app-rn` for a worked example).
3. Define your sApp schema (Quereus `declare schema App { … }`) and use `@serfab/quereus-plugin-sereus` (or `cadre-core`'s APIs) to read/write the strand from SQL.

#### As a contributor

```bash
yarn install
yarn build        # workspaces foreach -At run build
yarn test         # workspace tests
yarn typecheck
```

The repo uses Yarn 4 workspaces. The root `package.json` links `@quereus/*` and `@optimystic/*` to sibling checkouts (`../quereus`, `../optimystic`) — clone those alongside this repo for local development.

### Ops (running bootstrap/relay nodes)

If you're operating infrastructure (e.g. **libp2p relay** and/or **bootstrap** nodes), start here:
- [`ops/README.md`](ops/README.md) (entry point)
- [`ops/docker/README.md`](ops/docker/README.md) (Docker-based production workflow + installer)

The public site lives in [`docs/web/`](docs/web/) (Overview, Architecture, Stack, Use Cases, Get Started) and is published to `https://sereus.org`.

### Status

Active development. Core concepts are stable; APIs/tooling are evolving. [`docs/STATUS.md`](docs/STATUS.md) is the living checklist. Early adopters should expect rapid iteration and close-to-the-code workflows.

### Credits

Sereus is a project of the GotChoices Foundation.
