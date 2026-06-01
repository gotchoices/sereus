----
description: lint and dep-check are no-ops monorepo-wide and typecheck covers only 1 of 9 packages
files: package.json, packages/reference-app-web/package.json
----

The monorepo's `lint`, `dep-check`, and `typecheck` build-health gates give false assurance. They all delegate to per-package scripts via `yarn workspaces foreach -A`, but the underlying per-package scripts and tool configs are largely absent, so the gates report success while validating little or nothing. This contradicts the project's intent (AGENTS.md style rules, a planned CI pipeline) of catching regressions before build.

## lint is a no-op

Root `lint` runs `yarn workspaces foreach -A run lint` (package.json:23), but no package defines a `lint` script and there is no eslint configuration anywhere in the repo (only eslint configs nested inside `node_modules` exist). As a result `yarn lint` completes in roughly 0s having linted nothing and returns success. The AGENTS.md style rules — lowercase SQL reserved words, no `any`, `void` on unused promises, `_` prefix on unused arguments, braces around `case` blocks with locals, ES modules, no inline `import()` — are therefore not machine-enforced and can only be checked by human review.

## dep-check is a no-op

Root `dep-check` runs `yarn workspaces foreach -A run dep-check` (package.json:26), but no package defines a `dep-check` script and there is no knip/depcheck configuration in the repo. Consequently unused, missing, and phantom dependencies go undetected across all packages.

## typecheck covers only 1 of 9 packages

Root `typecheck` runs `yarn workspaces foreach -A run typecheck` (package.json:28), but only `@serfab/reference-app-web` defines a `typecheck` script (`tsc --noEmit`, packages/reference-app-web/package.json:10). The other TS packages are silently skipped, so real type validation across the monorepo only happens as a side effect of the much slower `yarn build`. This gap is why a prior `integration-tests` TS2353 error was invisible to `yarn typecheck` — the package that contained the error had no typecheck script to run.

## Expected behavior

The lint, dep-check, and typecheck gates should be meaningful and catch regressions before build:

- A real eslint configuration (flat config, cross-platform aware) plus per-package `lint` scripts so AGENTS.md style rules are machine-enforced.
- A dependency-check tool (knip or depcheck) with configuration plus per-package `dep-check` scripts so unused/missing/phantom dependencies are detected.
- A per-package `typecheck` script (e.g. `tsc -p tsconfig.build.json --noEmit`) for every TS package so `yarn typecheck` validates the whole monorepo, not just `reference-app-web`.

These gates are the foundation the planned CI pipeline (tickets/backlog/later/6-ci-pipeline-maestro.md) expects to invoke (`yarn typecheck`, `yarn lint`); without real per-package scripts and tool configs those CI steps would be equally hollow.

Key files: package.json (scripts at lines 23, 26, 28), packages/reference-app-web/package.json (the only package with a typecheck script, line 10). See AGENTS.md for the style rules that should be enforced.
