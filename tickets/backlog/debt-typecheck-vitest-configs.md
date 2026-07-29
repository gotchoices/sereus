description: Test-runner config files across the repo are not type-checked, so when the test runner drops or renames a setting the config keeps the dead setting and nothing complains — this already happened once and the broken setting went unnoticed for a whole major-version upgrade.
files: packages/*/vitest.config.ts, packages/*/tsconfig.typecheck.json, packages/integration-tests/tsconfig.typecheck.json
difficulty: easy
---

# Type-check every package's vitest.config.ts

## What's wrong

Each package's `typecheck` script runs `tsc --noEmit` over a `tsconfig.typecheck.json`
whose `include` covers only `src/` (and, in some packages, `test/`). The package's
`vitest.config.ts` sits at the package root and is therefore **outside every
type-check program**. TypeScript never validates it in CI; only an editor with the
file open shows the error.

That blind spot has already cost real coverage. `packages/integration-tests/vitest.config.ts`
carried a `test.poolOptions.forks.singleFork` block that Vitest 4 removed. The option was
silently ignored — integration scenarios that bind real network ports ran in parallel
despite a comment promising they would not — and `yarn typecheck` stayed green through the
whole Vitest 3 → 4 upgrade. TypeScript *would* have caught it (`'poolOptions' does not
exist in type 'InlineConfig'`), had the file been in the program.

## Current state

`packages/integration-tests` was fixed as part of the review of
`debt-vitest4-pooloptions-migration`: its `tsconfig.typecheck.json` now includes
`vitest.config.ts` and overrides `rootDir` to `"."` (needed because the base config
pins `rootDir: "src"`, which otherwise errors TS6059).

The other **seven** packages still have the gap:

- `cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`,
  `quereus-plugin-sereus`, `reference-app-rn`, `strand-proto`

## What "fixed" looks like

Every package's `yarn typecheck` includes its own `vitest.config.ts`, so a future runner
upgrade that removes or renames an option fails the type-check gate instead of degrading
silently. Whatever those seven configs currently contain that no longer type-checks is
fixed (or deliberately removed) as part of the same pass.

Note the packages differ in how their typecheck tsconfig is set up — some type-check
tests, some are shippable-source-only (see `docs/STATUS.md` → "Type-check coverage") —
so the include/rootDir tweak may not be identical in each.
