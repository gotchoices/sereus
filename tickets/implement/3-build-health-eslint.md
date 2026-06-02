----
description: add an eslint flat config (cross-platform, type-aware) encoding AGENTS.md style rules plus per-package lint scripts so `yarn lint` machine-enforces the rules
prereq: build-health-dep-check
files: package.json, packages/*/package.json, AGENTS.md
effort: high
----

# Make `yarn lint` actually lint, enforcing AGENTS.md style rules

Root `lint` (package.json:23) runs `yarn workspaces foreach -A run lint`, but no package defines a
`lint` script and there is no eslint configuration anywhere in the repo (only configs nested inside
`node_modules`). `yarn lint` completes in ~0s and returns success, so the AGENTS.md style rules are
not machine-enforced and can only be caught by human review.

Verified: `yarn lint` prints "Done in 0s" and exits 0; no `eslint.config.*` / `.eslintrc*` exists
outside node_modules.

## Scope warning (read first)

This is the largest of the three build-health tickets. Standing up eslint will almost certainly
surface a non-trivial number of pre-existing violations across nine packages. **Do not let "fix every
violation" balloon this ticket.** The deliverable is: a working, meaningful lint gate that exits 0 on
a clean checkout. Strategy for handling the violation backlog:

- Encode AGENTS.md rules as `error` only where the codebase is already (or trivially) compliant or
  auto-fixable (`eslint --fix`).
- For rules that surface a large pre-existing backlog, set them to `warn` initially (gate still
  passes) and document the backlog + a follow-up cleanup in the review handoff, OR file a separate
  fix/backlog ticket for the cleanup. Don't hand-fix hundreds of sites inside this ticket.
- Be explicit in the handoff about which rules are `error` vs `warn` and why.

## AGENTS.md rules → eslint mapping

| AGENTS.md rule | eslint mechanism | notes |
|---|---|---|
| no `any` ("avoid type lazy") | `@typescript-eslint/no-explicit-any` | start `warn` if backlog is large |
| `void` on unused promises (micro-tasks) | `@typescript-eslint/no-floating-promises` | **type-aware** — needs `parserOptions.project` |
| `_` prefix on unused args | `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: '^_'`, `varsIgnorePattern: '^_'` | |
| braces around `case` blocks with locals | `no-case-declarations` (built-in) | |
| ES modules | flat config `languageOptions.sourceType: 'module'` + `@typescript-eslint/no-require-imports` | |
| no inline `import()` unless dynamic | best-effort: `@typescript-eslint/consistent-type-imports` discourages type `import()`; there is no clean rule for runtime inline import. Document as partial / human-review. | don't over-promise |
| lowercase SQL reserved words | **not generically machine-enforceable** by eslint (SQL lives in template literals) | leave to human review; note explicitly that this rule is NOT enforced |
| don't eat exceptions w/o logging | no precise rule; `no-empty` (with `allowEmptyCatch:false`) partially flags empty catches | partial |
| tabs for code (.editorconfig) | optional `@stylistic` indent rule, or defer to editorconfig/prettier | keep minimal; don't introduce a formatter war |

Be honest in code comments and the handoff about which AGENTS.md rules are fully enforced, partially
enforced, or not enforceable here.

## Config design

- **Flat config** (`eslint.config.js`/`.mjs`, eslint 9 / typescript-eslint v8) at repo root, since the
  repo uses ESM. A single root flat config can cover all workspaces via `files`/`ignores` globs (DRY),
  with per-language overrides (TS, `.svelte` via `eslint-plugin-svelte`, RN/expo if desired).
- **Type-aware linting** is required for `no-floating-promises`. This needs
  `languageOptions.parserOptions.projectService: true` (or `project` pointing at each package's
  tsconfig). It is slower; scope it to source files and ensure each package's tsconfig is resolvable.
  If wiring type-aware linting across all nine packages proves heavy, an acceptable first cut is to
  enable type-aware rules where straightforward and document the rest as follow-up.
- Ignore generated/vendored paths: `**/dist/**`, `**/node_modules/**`, build output, `.expo`, etc.
- Cross-platform: the `lint` script must run on Windows (PowerShell) and POSIX. Use `eslint .` and let
  the flat config's `files`/`ignores` do file selection — **do not** pass shell globs like `**/*.ts`
  as CLI args (PowerShell won't expand them).

## Wiring

- Add devDependencies at root: `eslint`, `typescript-eslint` (or `@typescript-eslint/{parser,
  eslint-plugin}`), `globals`, and `eslint-plugin-svelte` + `svelte-eslint-parser` for the Svelte UIs
  (reference-app-web, cadre-host/ui).
- Either set root `lint` (package.json:23) to `eslint .` directly (simplest, one config), or add a
  `lint` script to each package and keep the foreach. Recommend the single root `eslint .` for DRYness
  unless the per-package fan-out is required by CI; document the choice.

## TODO

- [ ] Add eslint + typescript-eslint (+ svelte plugin/parser, globals) as root devDependencies.
- [ ] Author a root flat `eslint.config.js` mapping AGENTS.md rules per the table; ignore dist/vendor;
      add TS + Svelte overrides; enable type-aware linting for `no-floating-promises` where feasible.
- [ ] Wire `lint` (root `eslint .` and/or per-package), cross-platform safe (no shell globs in args).
- [ ] Run `yarn lint 2>&1 | tee /tmp/lint.log`. Run `eslint --fix` for auto-fixable issues. Triage the
      rest: keep noisy/backlogged rules at `warn`, fix the cheap `error`s, get the gate to exit 0.
- [ ] Document in the handoff: which rules are error vs warn, which AGENTS.md rules are not enforceable
      (SQL casing, runtime inline import), and the violation backlog + proposed follow-up.
- [ ] Update AGENTS.md / docs/STATUS.md to note that style rules are now machine-enforced via `yarn
      lint`, and which rules remain human-review-only.
- [ ] Produce a review/ handoff honest about gaps and the deferred violation cleanup.
