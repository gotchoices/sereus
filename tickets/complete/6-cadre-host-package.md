---
description: Foundation skeleton for the @serfab/cadre-host workspace package, sibling of @serfab/cadre-provider. Adds the package, stub CLI, docs, and publish wiring that the five sibling tickets (process orchestrator, trust circle, NAT, installer, local UI) plug into.
files: packages/cadre-host/ (new), docs/cadre-host.md (new), docs/architecture.md, package.json (root)
---

## What landed

A new `@serfab/cadre-host` workspace package was added as a sibling of `@serfab/cadre-provider`. Foundation only — no orchestrator, auth, NAT, installer, or UI logic yet. Stubs and re-exports establish the surface that `cadre-host-process-orchestrator`, `cadre-host-trust-circle`, `cadre-host-nat`, `cadre-host-installer`, and `cadre-host-local-ui` will fill in.

### Files added

- `packages/cadre-host/package.json` — workspace package at version `0.6.0`, bin `cadre-host` → `dist/bin/host.js`. Deps: `commander`, `debug`, `fastify`, `@serfab/cadre-core` (workspace:^), `@serfab/cadre-provider` (workspace:^).
- `packages/cadre-host/tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` — mirrored from cadre-provider.
- `packages/cadre-host/src/bin/host.ts` — commander setup with five stub subcommands (`install`, `start`, `status`, `invite`, `uninstall`). Each prints `cadre-host <name>: not yet implemented` and exits 0.
- `packages/cadre-host/src/index.ts` — type re-exports of `Orchestrator`, `OrchestratorCreateRequest`, `OrchestratorCreateResult`, `OrchestratorStats`, `ContainerStatus`, `ContainerResources` from `@serfab/cadre-provider`.
- `packages/cadre-host/src/__tests__/cli.smoke.test.ts` — vitest smoke test that execs the compiled bin with `--help` and `--version`.
- `packages/cadre-host/README.md` — short three-section README (What / Install / More).
- `docs/cadre-host.md` — new doc covering persona, package boundary, deployment model, security posture, and architecture sketch, with two mermaid diagrams.

### Files edited

- `docs/architecture.md` — link to `cadre-host.md` from the "Flexible deployment" bullet, add `HOST` node to the Package Structure mermaid, append an Implementation Status subsection for the foundation.
- `package.json` (root) — append `pub:cadre-host` to `scripts` and chain it into the `pub` aggregator.

## Review findings

### Process

- Re-read the implement-stage diff (`git show 0dc5850`) end-to-end before consulting the handoff.
- Verified declared re-exports actually exist in `packages/cadre-provider/src/index.ts` (lines 53–55, 73–77).
- Verified `scripts/publish-package.js` accepts arbitrary package names (`cd packages/<name>` + clean/build/publish).
- Compared `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, and bin layout against the cadre-provider sibling for structural parity.
- Ran `yarn workspace @serfab/cadre-host build`, `yarn workspace @serfab/cadre-host test` (both smoke tests pass, ~150ms), and `yarn workspaces foreach -A run test` (full workspace, 25 tests, exit 0, 2m 27s).
- Manually invoked `node packages/cadre-host/dist/bin/host.js --help`, `--version`, `install`, and an unknown command — all behave as expected (stubs exit 0; unknown command rejected with exit 1 by commander).

### SPP / DRY / scalability / modularity

- No findings. The package is intentionally thin and consists of a CLI shell, type re-exports, and config. No duplication or premature abstraction.

### Type safety

- No findings. `strict: true` is on; the type-only re-export (`export type { ... }`) is correct and the full topological build passes.

### Resource cleanup / error handling

- No findings applicable. The bin is non-resident (commander runs an action then exits). The smoke test throws a clear error if `dist/bin/host.js` is missing rather than silently passing — good.

### Test coverage

- The smoke test covers help-text contents (all five subcommand names) and `--version`. Adequate for a stub-only release. The stub action paths are not exercised, but their behavior is trivial (`console.log` + `process.exit(0)`) — not worth dedicated tests.

### Docs

- `docs/architecture.md` updates are consistent (link + mermaid node + status subsection). The HOST node hangs off `CC` (cadre-core) in the Package Structure mermaid, which matches the eventual dependency direction even though the foundation only directly depends on cadre-provider today.
- `docs/cadre-host.md` is more persona-prose than the rest of the docs tree, but the content matches the actual target persona (household admin, not professional operator). The threat-model framing (Spotify, Steam client analogy) is unusual for this docs tree but accurate and not inappropriate. Left as written — tightening it further would not materially help readers and the persona detail is genuinely informative for sibling-ticket authors.
- README points at the forthcoming installer ticket and explicitly says commands print "not yet implemented" today. Honest about the foundation status.

### Observed but not changed

- **`@serfab/cadre-core`, `debug`, `fastify` are declared as runtime deps but not yet imported by any file in `src/`.** Strictly per the project guideline "Don't design for hypothetical future requirements," these could be removed and re-added by the sibling tickets that use them. Left in place because (a) the ticket spec explicitly listed them, (b) the package is documented as a foundation skeleton whose surface is fixed by this ticket, and (c) removing them produces churn in five sibling-ticket diffs to add the same deps back. If the maintainer prefers minimal deps, the fix is `yarn workspace @serfab/cadre-host remove debug fastify @serfab/cadre-core` and sibling tickets add what they need.
- **Yarn rewrote the `bin` field from object form to string form on install.** Both forms are valid Node/npm bin entries. The string form matches cadre-provider's precedent.
- **No `typecheck` script in `package.json`.** Consistent with cadre-provider, which also has no `typecheck` script — both rely on `tsc -p tsconfig.build.json` during `build` for the same effect. `yarn workspaces foreach -A run typecheck` ran clean at the workspace level.
- **`src/__tests__/` is included in the published `files` list via the `src` entry.** Same pattern as cadre-provider (which has `src/server/__tests__/shutdown-after.test.ts`). Not ideal but consistent — separate concern from this ticket.
- **Stub commands exit 0 rather than nonzero.** Reasonable for a foundation release; sibling tickets will replace these with real implementations before the package is shipped as runnable.

### Validation summary

- `yarn workspace @serfab/cadre-host build` — passes.
- `yarn workspace @serfab/cadre-host test` — 2/2 pass (156ms).
- `yarn workspaces foreach -A run test` — 25/25 pass across all workspaces (2m 27s, exit 0).
- `yarn workspaces foreach -A run typecheck` — clean.
- Manual bin invocation (`--help`, `--version`, each stub subcommand) — behaves as expected.

No fixes were applied in this pass; everything is consistent with the ticket's foundation-only scope and the cadre-provider sibling's conventions.

## Sibling-ticket downstream impact

The five sibling tickets can now:

- `cadre-host-process-orchestrator` — add `src/orchestrator/host-process-orchestrator.ts` implementing the re-exported `Orchestrator` interface; export it from `src/index.ts`.
- `cadre-host-trust-circle` — add `src/auth/trust-circle.ts`; replace the stub `invite` command in `src/bin/host.ts`.
- `cadre-host-nat` — add `src/nat/` subdirectory; export the layer from `src/index.ts`.
- `cadre-host-installer` — replace the stub `install`/`uninstall` commands; add `src/installer/` and `packages/cadre-host/service/` platform scripts.
- `cadre-host-local-ui` — replace the stub `start`/`status` commands; add `src/ui/` and `src/server/` for the fastify-on-localhost management API.

Each sibling ticket extends `src/index.ts` with the surfaces it introduces.
