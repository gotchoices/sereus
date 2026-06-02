----
description: REVIEW — `yarn lint` is now a real ESLint gate (eslint 10 + typescript-eslint 8 flat config, `eslint.config.mjs`) encoding AGENTS.md style rules. Exits 0 on clean checkout (0 errors, ~118 warnings). Backlogged rules run as `warn`; cleanup deferred to backlog ticket `build-health-lint-warning-cleanup`. typecheck + cadre-core/cadre-host tests green.
prereq: build-health-dep-check
files: eslint.config.mjs, package.json, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-host/src/bin/host.ts, docs/STATUS.md, AGENTS.md
----

# Review: make `yarn lint` actually lint (AGENTS.md → ESLint)

Root `lint` was a no-op (`workspaces foreach -A run lint` with no package defining a `lint` script;
"Done in 0s", exit 0). There was no ESLint config anywhere outside `node_modules`. The AGENTS.md style
rules were therefore unenforced — human-review only.

`yarn lint` now runs **ESLint 10 + typescript-eslint 8** from the repo root against a single flat config,
`eslint.config.mjs`, covering all workspaces (TS, JS tooling, Svelte UIs). `yarn lint:fix` applies the
auto-fixable subset. **The gate exits 0 on a clean checkout** (0 errors, ~118 warnings — see backlog).

**Treat this as a starting point.** The deliverable was a *working, meaningful gate*, not a clean-codebase
pass. Per the ticket's scope warning, rules with a large pre-existing backlog were intentionally left at
`warn` and the cleanup deferred (backlog ticket `build-health-lint-warning-cleanup`). The headline judgement
call for the reviewer is the **error/warn split** below and the **type-aware scope** decision.

## What shipped

### `eslint.config.mjs` (root, flat config, ESM)
- Single root config (DRY) — `lint` is `eslint .`, `lint:fix` is `eslint . --fix`. Cross-platform: no shell
  globs in the CLI args; all file selection is via the config's `files`/`ignores` (works in PowerShell).
- Layers: global ignores → `js.configs.recommended` + `tseslint.configs.recommended` → node+browser globals
  → AGENTS.md rules (TS) → type-aware block (`no-floating-promises`) → svelte (`eslint-plugin-svelte`
  recommended + TS sub-parser) → JS/CJS tooling override → eslint-10 backlog downgrades → e2e override.
- DevDeps added at root: `eslint@^10`, `typescript-eslint@^8`, `@eslint/js`, `globals`,
  `eslint-plugin-svelte`, `svelte-eslint-parser`.

### AGENTS.md rule → ESLint mapping (and the error/warn decision)

| AGENTS.md rule | Rule | Level | Why |
|---|---|---|---|
| `void` unused promises | `@typescript-eslint/no-floating-promises` | **error** | type-aware, `packages/*/src` only; only 3–4 real sites, all fixed (see below) |
| ES modules | `@typescript-eslint/no-require-imports` | **error** | codebase already ESM; 1 intentional `require` disabled inline w/ rationale |
| braces around `case` w/ locals | `no-case-declarations` | **error** | already compliant |
| avoid `any` | `@typescript-eslint/no-explicit-any` | warn | ~67 pre-existing sites |
| `_` prefix unused | `@typescript-eslint/no-unused-vars` | warn | ~30; honors `^_` arg/var/caught/destructure patterns |
| no inline `import()` | `@typescript-eslint/consistent-type-imports` | warn | **partial** — only covers type-position imports; auto-fixed where safe |
| don't eat exceptions | `no-empty` (`allowEmptyCatch:false`) | warn | **partial** — ~4 empty catches |
| lowercase SQL reserved words | — | **not enforced** | SQL is in template literals; no clean rule. Human-review only. |
| tabs for code | — | **not enforced** | left to `.editorconfig`; avoided a formatter war |

eslint-10 `recommended` ships several rules that are **not** AGENTS.md rules and surfaced their own backlog;
downgraded to `warn` to keep the gate green: `prefer-const` (~23, incl. test-lifecycle false positives),
`preserve-caught-error` (~6), `no-useless-assignment` (~3), `no-control-regex` (1),
`svelte/no-at-html-tags` (1), `svelte/prefer-svelte-reactivity` (~5).

### Source fixes (small, behavior-preserving)
- Marked 4 genuinely fire-and-forget promises with `void` (the AGENTS.md convention), runtime unchanged:
  - `cadre-core/src/control-database.ts:497` and `strand-database.ts:221` — `void this.db.close()`
  - `cadre-core/src/seed-bootstrap.ts:640` — `void this.libp2pNode.handle(...)`
  - `cadre-host/src/bin/host.ts:917` — `void program.parseAsync()`
- `control-database.ts:277` — the conditional `require('fs/promises')` (deliberately CommonJS so Metro
  won't statically bundle it) now has an `// eslint-disable-next-line @typescript-eslint/no-require-imports`
  with a comment explaining why `import()` is *not* used here.
- `yarn lint:fix` auto-fixed `consistent-type-imports` / safe `prefer-const` across ~24 files (mostly
  `import` → `import type`). These are type-only rewrites; validated by typecheck + svelte-check (below).

### Scope / coverage decisions (review these)
- **Type-aware linting** (`projectService: true`) is enabled only for the node/library `src` trees
  (`cadre-core`, `cadre-cli`, `cadre-host`, `cadre-provider`, `quereus-plugin-sereus`, `integration-tests`).
  The bundler/expo apps (`reference-app-web`, `reference-app-rn`, `cadre-host/ui`) get **non-type-aware**
  rules only, to keep the type-aware pass fast/resolvable. So `no-floating-promises` does **not** cover the
  Svelte/RN apps. Documented as a deliberate first cut.
- **Ignored:** `**/dist`, `node_modules`, build/coverage/report dirs, `**/*.d.ts`, RN `android`/`ios`,
  `reference-app-rn/maestro/**` (Maestro JS engine globals), `strand-proto` (deprecated), and non-package
  trees `ops/`, `tess/`, `scripts/`, `**/scripts/`.
- JS/CJS/MJS files (metro.config.js, hermes polyfill, svelte configs, sidecar) get a relaxed override:
  `no-require-imports` off (intentional CommonJS), `no-unused-vars` with `^_` honored.

## Validation performed (and its limits)

- `yarn lint` → **0 errors**, ~118 warnings, exit 0. ✅
- `yarn typecheck` (all 9 workspaces) → exit 0. ✅ (validates the `import type` rewrites in `.ts`)
- `svelte-check` on `cadre-host/ui` → **0 new errors** on the 9 `.svelte`/route files I auto-fixed. ✅
- `yarn workspace @serfab/cadre-core test` → 261 passed. ✅
- `yarn workspace @serfab/cadre-host test` → 359 passed, 3 skipped. ✅

### Known gaps / things to probe
- **Warnings are unenforced.** ~118 `warn`s are real and currently advisory. Backlog ticket
  `build-health-lint-warning-cleanup` owns burning them down and promoting rules `warn → error`.
- **`.svelte` files are not type-aware-linted**, and `reference-app-web`'s `.svelte` are not covered by
  `tsc` either — only `svelte-check` (not wired into any gate) would catch type issues there. I ran
  svelte-check only on `cadre-host/ui` (the package whose `.svelte` I edited); I did **not** run it on
  `reference-app-web` (no `.svelte` files were touched there — only `e2e/global-setup.ts`, a type-import
  rewrite, which `tsc` on the e2e tsconfig is not part of `typecheck`). Reviewer may want to spot-check.
- **Pre-existing latent svelte-check error** (NOT mine, not in my diff, not caught by any current gate):
  `packages/cadre-host/ui/src/lib/events.ts:67` "'ctor' is possibly 'undefined'". Flagged in the backlog
  ticket; intentionally not fixed here.
- **`no-explicit-any` lower bound:** the ~67 count is the warn floor; real `any` usage may be higher in the
  not-type-aware-linted app code. The gate's `any` enforcement is a floor, not a ceiling.
- I did **not** run the full `yarn test` / integration-tests / e2e suites — only the two packages whose
  source I edited. The remaining source edits are pure type-only import rewrites validated by typecheck.

## How to verify
```
yarn lint            # expect: 0 errors, ~118 warnings, exit 0
yarn lint:fix        # idempotent now; should report the same warnings, no new file changes
yarn typecheck       # all workspaces, exit 0
yarn workspace @serfab/cadre-core test
yarn workspace @serfab/cadre-host test
```
