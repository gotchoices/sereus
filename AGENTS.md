Focus: Sereus monorepo. Also have `../quereus` + `../optimystic` workspaces for reference/debug (linked via `resolutions` in root `package.json`).

## Repo orientation

- `packages/` — monorepo libs + apps. Cadre runtimes: `@serfab/cadre-core` (library), `@serfab/cadre-cli` (headless CLI), `@serfab/cadre-host` (self-hosted manager w/ local UI, installer, NAT, trust-circle), `@serfab/cadre-provider` (multi-tenant Docker host). SQL access: `@serfab/quereus-plugin-sereus`. Reference apps: `reference-app-rn`, `reference-app-web`. Cross-package real-network tests: `integration-tests`. `strand-proto` deprecated.
- `ops/` — operational tooling (Docker stacks, systemd scaffolds, infra test scripts) for libp2p relay/bootstrap nodes. Not app code.
- `docs/` — design + protocol docs. [`docs/architecture.md`](docs/architecture.md) is entry point; [`docs/cadre-host.md`](docs/cadre-host.md), [`docs/strands.md`](docs/strands.md), [`docs/cadre-consistency.md`](docs/cadre-consistency.md), [`docs/STATUS.md`](docs/STATUS.md) cover subsystems.
- `schemas/` — Quereus schema artifacts (e.g. `cadre.qsql`, `strand.qsql`).
- `tickets/` + `tess/` — AI-driven ticket workflow (see "Tickets" below).

## General

Most style rules machine-enforced by `yarn lint` (ESLint flat config in
`eslint.config.mjs`), a fully-enforced gate — every encoded rule is `error`, no
`warn` backlog. **Lowercase SQL reserved words** and **no runtime inline `import()`** are not
machine-checkable, human-review-only (see `docs/STATUS.md` → "Lint coverage").

- Lowercase SQL reserved words (e.g., `select * from Table`)
- No inline `import()` unless dynamically loading
- Don't create summary docs; update existing docs
- Stay DRY
- No lengthy summaries
- No backwards compat yet
- Use yarn
- Prefix unused args with `_`
- Brace `case` blocks if any consts/vars
- Prefix unused promise (micro-task) calls with `void`
- ES Modules
- Not type lazy — avoid `any`
- Don't eat exceptions w/o at least logging; exceptions exceptional, not control flow
- Small single-purpose functions/methods. Decomposed sub-functions over grouped code sections
- No half-baked janky parsers; use full parser or brainstorm another way w/ dev
- Think cross-platform (browser, node, RN, etc.)
- .editorconfig has formatting (tabs for code)

## Tickets (tess)

Project uses [tess](tess/) for AI-driven ticket management.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/).

Start w/ [`docs/architecture.md`](docs/architecture.md) to come up to speed, then read + maintain these + other docs along w/ work.

## Caveman

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
