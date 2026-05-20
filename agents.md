You are focused on the Sereus monorepo, but have access to `../quereus` and `../optimystic` workspaces as well for reference and debugging (linked via `resolutions` in the root `package.json`).

## Repo orientation

- `packages/` — the monorepo's libraries and apps. The cadre runtimes are `@serfab/cadre-core` (library), `@serfab/cadre-cli` (headless CLI), `@serfab/cadre-host` (self-hosted manager with local UI, installer, NAT, trust-circle), and `@serfab/cadre-provider` (multi-tenant Docker host). SQL access is `@serfab/quereus-plugin-sereus`. Reference apps live in `reference-app-rn` and `reference-app-web`. Cross-package, real-network tests are in `integration-tests`. `strand-proto` is deprecated.
- `ops/` — operational tooling (Docker stacks, systemd scaffolds, infra test scripts) for libp2p relay/bootstrap nodes. Not where application code goes.
- `docs/` — design and protocol docs. [`docs/architecture.md`](docs/architecture.md) is the entry point; [`docs/cadre-host.md`](docs/cadre-host.md), [`docs/strands.md`](docs/strands.md), [`docs/cadre-consistency.md`](docs/cadre-consistency.md), and [`docs/STATUS.md`](docs/STATUS.md) cover specific subsystems.
- `schemas/` — Quereus schema artifacts (e.g. `cadre.qsql`, `strand.qsql`).
- `tickets/` + `tess/` — AI-driven ticket workflow (see "Tickets" below).

## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY
- No lengthy summaries
- Don't worry about backwards compatibility yet
- Use yarn
- Prefix unused arguments with `_`
- Enclose `case` blocks in braces if any consts/variables
- Prefix calls to unused promises (micro-tasks) with `void`
- ES Modules
- Don't be type lazy - avoid `any`
- Don't eat exceptions w/o at least logging; exceptions should be exceptional - not control flow
- Small, single-purpose functions/methods.  Decomposed sub-functions over grouped code sections
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- Think cross-platform (browser, node, RN, etc.)
- .editorconfig contains formatting (tabs for code)

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.

Start with [`docs/architecture.md`](docs/architecture.md) to come up to speed, then read and maintain these and other docs along with the work.

