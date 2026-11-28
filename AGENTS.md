Focus: Sereus monorepo. Also have `../quereus` + `../optimystic` workspaces for reference/debug (linked via `resolutions` in root `package.json`).

## Repo orientation

- `packages/` — monorepo libs + apps. Cadre runtimes: `@serfab/cadre-core` (library), `@serfab/cadre-cli` (headless CLI), `@serfab/cadre-host` (self-hosted manager w/ local UI, installer, NAT; runs nodes that join phone-owned cadres by QR claim or invitation), `@serfab/cadre-provider` (multi-tenant Docker host). SQL access: `@serfab/quereus-plugin-sereus`. Strict config-file checking shared across those programs, with no dependencies: `@serfab/config-check`. Platform-neutral cadre management for apps, no UI (cadrons, claims, owner key backup, relays, invitation bootstrap lists, app links, the background runner): `@serfab/cadre-client`. React Native kit (native Noise crypto; subpath imports only): `@serfab/cadre-rn`. Reference apps: `reference-app-rn`, `reference-app-web`, `reference-app-ns`. Cross-package real-network tests: `integration-tests`.
- `ops/` — operational tooling (Docker stack, installer, infra test scripts) for libp2p relay nodes. Not app code.
- `docs/` — see "Docs". Index: [`docs/README.md`](docs/README.md). Current work state lives in [`tickets/`](tickets/), not in docs.
- `schemas/` — Quereus schema artifacts (`control.qsql`, `strand.qsql`, `chat.qsql`, `chat-simple.qsql`).
- `test-harness/` — test infrastructure shared across packages (stale-build guard, schema-text comparison, reporter for tests a failed setup kept from running). Not a workspace, never built; imported by relative path from packages' vitest `globalSetup` and specs.
- `tickets/` + `tess/` — AI-driven ticket workflow (see "Tickets").

## General

Most style rules machine-enforced by `yarn lint` (ESLint flat config in
`eslint.config.mjs`, then the doc check `scripts/check-docs.mjs`), a fully-enforced gate — every encoded rule is `error`, no
`warn` backlog. **Lowercase SQL reserved words** and **no runtime inline `import()`** are not
machine-checkable, human-review-only (see [`docs/contributing/gates.md`](docs/contributing/gates.md) → "Lint coverage").

- Lowercase SQL reserved words (e.g., `select * from Table`)
- No inline `import()` unless dynamically loading
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

## Docs

Come up to speed: [`docs/concepts.md`](docs/concepts.md) (model + the only glossary), then [`docs/architecture.md`](docs/architecture.md) (how the pieces fit), then the one subsystem doc the task touches. Maintain docs along w/ work.

Layout:

- `docs/cadre/` — one party's control network + machines (schema, replication, convergence, trust + admission, adding/removing machines, owner keys, several apps in one cadre, the node).
- `docs/strands/` — lifecycle, inviting + joining, closed-strand membership + keys, writes + offline mode, app schemas, hibernation.
- `docs/network/` — relays, strand addressing, deadlines + link budget.
- `docs/hosting/` — cadre-host design + its management API, provider-hosted nodes. `docs/platforms/` — React Native, NativeScript, browser, the reference apps.
- App developers: [`docs/getting-started.md`](docs/getting-started.md), [`docs/api.md`](docs/api.md), [`docs/schema-guide.md`](docs/schema-guide.md).
- `docs/contributing/` — testing, gates, topology coverage map, device testing, releasing.
- `docs/design/` — designs not built (decentralized push, human contracts on strands, async control consistency). Not a description of the system.
- Package `README.md` — install, run, command/flag/option reference for that package. Concepts live in `docs/`; published READMEs link there by GitHub URL (relative links are dead on npm).

Rules:

- One home per fact. Source + schema comments own per-function behaviour, per-constraint rules, signatures, constants. Docs own the model, each mechanism's what + why, invariants + what they prevent, what an API promises, config + defaults, procedures, limits. READMEs own usage. Link instead of restating.
- Docs describe the system as it is now. A problem that was found and fixed is history: name the ticket slug (or the upstream commit) and stop. Do not retell the diagnosis, the dates, or the before-state. Keep a past fact only when it is the reason the current design is the way it is, and then state it as a constraint, not a story.
- Not in docs: measurements from a run, what a test does or which spec proves a claim, work status, hand copies of interfaces/enums, `file.ts:123` line refs. The topology coverage map is the one place scenario files are listed.
- Known limits + accepted tradeoffs go in the owning doc's "Limits and accepted tradeoffs" section: what is not guaranteed or was declined, why, revisit condition. Cite an open ticket by slug only.
- One list item, one claim plus its reason. When an item needs a second topic, give it a labelled sub-paragraph; when it describes a mechanism with several parts, make it a headed section and leave a one-sentence item linking to it.
- Extending a doc: add to the section that owns the topic, or add a section. Do not append to the nearest bullet. Don't create summary docs.
- Size is gated (`yarn check:docs`, part of `yarn lint`): document 6,000 words, paragraph or list item 120, table cell 50; links + heading anchors must resolve. Over budget means split by topic or move detail to the source comment that owns it, not raise the limit.
- Source comments cite docs as `docs/<path>.md → "Heading"`. Renaming or moving a heading: grep for its title and update the citations in the same change.
- Terms: use the glossary's meaning; add a term there, not in a subsystem doc.

## Tickets (tess)

Project uses [tess](https://github.com/gotchoices/tess) for AI-driven ticket management.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/).
If asked to "tend the garden" or similar, see tess/agent-rules/tend.md.

## Mannered prose

Mannered prose substitutes metaphor and flourish for direct statement. Instead of "a parameter worth varying," the mannered writer produces "a dial worth turning." Instead of "this point still matters," they write "this point earns its keep." The phrases exist to display the writer, not to convey the idea, and readers can tell. That is why mannered prose irritates: it makes the reader work harder so the writer can perform. It is also imprecise. Metaphors drag in connotations the writer did not choose and cannot control. The fix is to say what you mean. When a literal phrase is available, use it.
