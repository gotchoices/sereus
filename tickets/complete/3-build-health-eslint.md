----
description: COMPLETE — `yarn lint` is now a real ESLint gate (eslint 10 + typescript-eslint 8 flat config, `eslint.config.mjs`) encoding AGENTS.md style rules. Exits 0 on clean checkout (0 errors, 118 warnings). Reviewed: cleaned up 72 whitespace-only "junk" lines that `lint:fix` left behind when stripping unused disable directives; verified the headline `no-floating-promises` error rule actually fires; lint + typecheck + cadre-core/cadre-host/quereus-plugin-sereus tests all green. Two pre-existing/out-of-scope gaps spun off to backlog.
prereq: build-health-dep-check
files: eslint.config.mjs, package.json, agents.md, docs/STATUS.md, packages/cadre-host/src/bin/host.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-host/src/nat/secrets/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/quereus-plugin-sereus/test/browser-bundle.spec.ts, packages/quereus-plugin-sereus/test/browser-shape.spec.ts, packages/reference-app-web/e2e/global-setup.ts
----

# Complete: make `yarn lint` actually lint (AGENTS.md → ESLint)

Root `lint` was a no-op (`workspaces foreach -A run lint`, no package defining `lint`, "Done in 0s",
exit 0). `yarn lint` now runs **ESLint 10 + typescript-eslint 8** from the repo root against a single
flat config (`eslint.config.mjs`) covering all workspaces (TS, JS tooling, Svelte UIs). `yarn lint:fix`
applies the auto-fixable subset. The gate **exits 0 on a clean checkout** (0 errors, 118 warnings).
Backlogged rules run at `warn`; cleanup + `warn→error` promotion is deferred to
`build-health-lint-warning-cleanup`.

See the implement commit `e402f6c` for the full shipped design (config layers, AGENTS.md→rule mapping,
error/warn rationale, source fixes). This file records the **review pass** over it.

## Review findings

Scrutinized the implement diff with fresh eyes (SPP/DRY/modularity/scalability/maintainability/perf/
resource-cleanup/error-handling/type-safety), re-ran every gate, and probed the claims in the handoff.

### Checked — and OK
- **Headline `no-floating-promises` (error) is real, not a no-op.** Verified the type-aware pass works
  by dropping a scratch `Promise.resolve().then(...)` into `cadre-core/src` and confirming ESLint
  reported it as an error (`projectService` resolves; rule fires). Removed the probe.
- **The 4 `void`-marked promises and the 1 `eslint-disable`d `require`** are genuine fire-and-forget /
  intentional-CommonJS sites; behavior-preserving.
- **Auto-fixed `import` → `import type` rewrites are sound.** Spot-checked every binding that was
  converted (`CadreNode`, `CliConfigFile`, `ResolvedConfig`, `Database`, `KeyObject`, the `ConfirmDialog`
  `$props()` `const`) — all are used only in type positions, so the rewrites can't break runtime. The RN
  app has no `typecheck` gate, so `use-cadre.ts`'s `CadreNode` rewrite was verified by hand (type-only).
- **`yarn lint:fix` is idempotent** — a second run produces 118 warnings and changes no files.
- **No "unused eslint-disable directive" warnings** linger in the output.
- **error/warn split and type-aware scope decision** (node/lib `src` only; bundler/expo apps
  non-type-aware) are reasonable, documented first cuts; concur with the deferral.

### Found — fixed inline (this pass)
- **`lint:fix` left 72 whitespace-only "junk" lines.** When ESLint 10 stripped the now-unused
  `// eslint-disable-next-line no-console` / `no-var` / `require-yield` directives, it removed the
  comment text but left the line's indentation behind, producing 72 lines containing only spaces
  (67 in `cadre-host/src/bin/host.ts` alone, plus `secrets/index.ts`, `seed-bootstrap.spec.ts`,
  `browser-bundle.spec.ts`, `browser-shape.spec.ts`, `global-setup.ts`). These were not caught by the
  gate (no `no-trailing-spaces` rule) and made the diff sloppy. **Deleted all 72 precisely** (blame-scoped
  to commit `e402f6c` so the ~161 pre-existing whitespace-only lines elsewhere were left untouched; line
  endings preserved as LF). Re-ran lint/typecheck/tests after — still green.

### Found — out of scope, spun off to backlog (not fixed here)
- **`.editorconfig` is referenced but does not exist.** `eslint.config.mjs`, the new `docs/STATUS.md`
  section, the backlog ticket, and AGENTS.md all justify *not* linting indentation by saying it is "left
  to `.editorconfig`" — but there is **no `.editorconfig` in the repo**, and indentation is actually mixed
  (`cadre-host/src` = 2-space, `cadre-core/test` = tabs). So "tabs for code" is enforced nowhere and the
  docs overstate the situation. Not fixed inline: adding a tab `.editorconfig` would surface the mixed
  reality and start exactly the "formatter war" the ticket explicitly avoided. Recorded as a note on
  `build-health-lint-warning-cleanup` for a maintainer to resolve (add+reformat vs. correct the docs).
- **Root instructions file tracked as lowercase `agents.md`.** `CLAUDE.md` imports `@AGENTS.md`, but the
  file is tracked as `agents.md`; on a case-sensitive filesystem (Linux CI) that reference won't resolve
  and the project instructions silently fail to load — a latent cross-platform bug. **Pre-existing**
  (parent tree is also lowercase), unrelated to linting, surfaced only because this ticket edited the
  file. Filed `tickets/backlog/agents-md-filename-case.md`.

### Not applicable / nothing found
- **Security / resource-cleanup / error-handling regressions:** none. The diff is mechanical (config +
  type-only import rewrites + `void`/disable annotations); no control-flow or lifecycle changes.
- **DRY / dead config:** `eslint.config.mjs` is a single root config; the only intentional duplication is
  the `no-unused-vars` options repeated for the TS vs JS/CJS overrides (different `args` handling) —
  justified.

## Validation performed (review pass, all green)
- `yarn lint` → **0 errors, 118 warnings, exit 0** (after the whitespace cleanup).
- `yarn lint:fix` → idempotent; no file changes beyond the 6 cleaned files.
- `yarn typecheck` (all 9 workspaces) → exit 0.
- `yarn workspace @serfab/cadre-core test` → 261 passed.
- `yarn workspace @serfab/cadre-host test` → 359 passed, 3 skipped.
- `yarn workspace @serfab/quereus-plugin-sereus test` → 35 passed, 1 todo (its test files were touched
  by the cleanup).
- Not run (unchanged source / not agent-runnable): `integration-tests` (real-network) and the Playwright
  e2e suites. The only edits in those packages are a single deleted blank line in `global-setup.ts`
  (inside a `declare global` block — inert).

## Follow-ups
- `build-health-lint-warning-cleanup` (backlog) — burn down the 118 warnings, promote `warn → error`,
  and resolve the `.editorconfig` question.
- `agents-md-filename-case` (backlog) — rename `agents.md` → `AGENTS.md`.
