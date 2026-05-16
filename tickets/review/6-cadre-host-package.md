---
description: Review the new @serfab/cadre-host workspace skeleton, stub CLI, docs, and root publish wiring. Foundation only — no orchestrator, auth, NAT, installer, or UI logic yet.
files: packages/cadre-host/ (new), docs/cadre-host.md (new), docs/architecture.md, package.json (root)
---

## What landed

A new `@serfab/cadre-host` workspace package was added as a sibling of `@serfab/cadre-provider`. This ticket establishes the surface that the five sibling tickets (`cadre-host-process-orchestrator`, `cadre-host-trust-circle`, `cadre-host-nat`, `cadre-host-installer`, `cadre-host-local-ui`) will plug into. No real service logic yet.

### Files created

- `packages/cadre-host/package.json` — name `@serfab/cadre-host`, version `0.6.0` (matches workspace), bin `cadre-host` → `dist/bin/host.js`. Deps: `commander`, `debug`, `fastify`, `@serfab/cadre-core` (workspace:^), `@serfab/cadre-provider` (workspace:^). DevDeps mirror cadre-provider (rimraf, typescript, vitest, types). Scripts mirror cadre-provider (clean/build/test/dev:test/start). Yarn rewrote the `bin` field from object form to string form on install — that is fine, both forms are valid, and the string form matches cadre-provider.
- `packages/cadre-host/tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` — copied verbatim from cadre-provider.
- `packages/cadre-host/src/bin/host.ts` — commander setup with five stub subcommands (`install`, `start`, `status`, `invite`, `uninstall`). Each prints `cadre-host <name>: not yet implemented` and exits 0. `--help` and `--version` work normally.
- `packages/cadre-host/src/index.ts` — re-exports `Orchestrator`, `OrchestratorCreateRequest`, `OrchestratorCreateResult`, `OrchestratorStats`, `ContainerStatus`, `ContainerResources` from `@serfab/cadre-provider`. Block comment documents which sibling tickets will add what.
- `packages/cadre-host/src/__tests__/cli.smoke.test.ts` — vitest smoke test that runs `node dist/bin/host.js --help` and asserts all five subcommand names appear; also asserts `--version` prints non-empty. Requires `yarn build` to have run (throws a clear error if `dist/bin/host.js` is missing rather than silently passing).
- `packages/cadre-host/README.md` — short three-section README (What / Install / More) per ticket spec.
- `docs/cadre-host.md` — new doc (~135 lines) covering: persona, package boundary, deployment model (with mermaid topology diagram), security posture (trust-circle vs zero-trust), architecture sketch (second mermaid), v0.x status.

### Files edited

- `docs/architecture.md` — three small edits:
  - "Flexible deployment" bullet now links to `cadre-host.md`.
  - The Package Structure mermaid gained a `HOST` node connected from `@serfab/cadre-core`.
  - New "Implementation Status > `@serfab/cadre-host` (Foundation)" subsection at the end.
- `package.json` (root) — appended `pub:cadre-host` to the `scripts` block and chained it into the `pub` aggregator. Followed the existing pattern verbatim (`node scripts/publish-package.js cadre-host`).

### Files not changed

- `packages/cadre-provider/src/index.ts` — verified during implementation that `Orchestrator`, `OrchestratorCreateRequest`, `OrchestratorCreateResult`, `OrchestratorStats`, `ContainerStatus`, `ContainerResources` are all already exported. No change needed. The plan-stage decision to leave shared types in cadre-provider (no third "orchestration-core" package) was kept.
- `scripts/publish-package.js` — verified to accept arbitrary `<package-name>` argv (it does — just `cd`s into `packages/<name>` and runs clean/build/publish). No change needed.

## Validation performed

- `yarn install` — succeeded, registered the new workspace (warnings are pre-existing and unrelated).
- `yarn workspaces foreach -At run build` — full topological build succeeded; cadre-host's dist tree contains `bin/host.js`, `bin/host.d.ts`, `bin/host.js.map`, `index.js`, `index.d.ts`, `index.js.map`.
- `yarn workspace @serfab/cadre-host test` — both smoke tests pass (134ms).
- Manually ran `node packages/cadre-host/dist/bin/host.js --help` — exit 0, help text lists all five subcommands.
- Manually ran `node packages/cadre-host/dist/bin/host.js install` — printed `cadre-host install: not yet implemented`, exit 0.

## Known gaps and reviewer guidance

This is a foundation ticket: it deliberately ships no behavior. Treat the following as expected, not bugs:

- All CLI subcommands are stubs. The bin exists to anchor packaging and CLI shape; it is not yet a runnable service.
- `src/index.ts` re-exports six types from cadre-provider and nothing else. The sibling tickets will add `HostProcessOrchestrator`, `TrustCircleAuth`, the NAT layer, the installer scripts, and the local UI/management API under their own subdirectories.
- No `typecheck` script in `package.json`. Neither does cadre-provider; `tsc -p tsconfig.build.json` during build is the de-facto typecheck and it passes. If you want to add one for consistency, that is a one-line change but it changes the precedent across packages.

Things worth double-checking:

- **Yarn rewrote `bin` from object form to string form on install.** Both Node and npm accept both forms, but if you have a strong preference, reverting to the object form `{ "cadre-host": "dist/bin/host.js" }` will work — yarn just normalizes single-bin packages. The string form is what cadre-provider uses.
- **The five subcommand names.** I picked them straight from the ticket spec. If the sibling-ticket UX wants different verbs (e.g. `join` instead of `invite`, `service` instead of `install`), it is cheaper to rename now than after the trust-circle work lands.
- **Persona doc tone.** `docs/cadre-host.md` reads as more opinionated/casual than the rest of the docs tree (the threat-model paragraph in particular). Read it through once and tighten if it does not fit the house voice — this is a doc-only edit, low risk.
- **README install command.** `npm install -g @serfab/cadre-host && cadre-host install` is aspirational — the installer ticket will likely change the exact UX. The README points at the forthcoming installer ticket; if you want to soften the wording further, that is a low-stakes edit.

## Sibling-ticket downstream impact

The five sibling tickets can now:

- `cadre-host-process-orchestrator` — add `src/orchestrator/host-process-orchestrator.ts` implementing the re-exported `Orchestrator` interface; export it from `src/index.ts`.
- `cadre-host-trust-circle` — add `src/auth/trust-circle.ts`; replace the stub `invite` command in `src/bin/host.ts` with a real implementation.
- `cadre-host-nat` — add `src/nat/` subdirectory; export the layer from `src/index.ts`.
- `cadre-host-installer` — replace the stub `install` and `uninstall` commands; add `src/installer/` and any platform-specific scripts under `packages/cadre-host/service/`.
- `cadre-host-local-ui` — replace the stub `start` and `status` commands; add `src/ui/` and `src/server/` for the fastify-on-localhost management API.

Each ticket extends `src/index.ts` with the surfaces it introduces.
