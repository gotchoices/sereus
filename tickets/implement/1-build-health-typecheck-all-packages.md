----
description: add a typecheck script to every TS package so `yarn typecheck` validates the whole monorepo, not just reference-app-web
files: package.json, packages/cadre-core/package.json, packages/cadre-cli/package.json, packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/integration-tests/package.json, packages/quereus-plugin-sereus/package.json, packages/strand-proto/package.json, packages/reference-app-rn/package.json, packages/reference-app-web/package.json
effort: medium
----

# Make `yarn typecheck` cover the whole monorepo

Root `typecheck` (package.json:28) runs `yarn workspaces foreach -A run typecheck`, but only
`@serfab/reference-app-web` defines a `typecheck` script (`tsc --noEmit`,
packages/reference-app-web/package.json:10). The other eight workspaces are silently skipped, so
`yarn typecheck` validates 1 of 9 packages. Real type validation across the monorepo only happens
as a side effect of the much slower `yarn build`, and test files are never type-checked at all by
vitest (it transpiles via esbuild without type-checking). This gap is why a prior `integration-tests`
TS2353 error was invisible to `yarn typecheck`.

## Current state (researched)

Each TS package and its build config:

| package | has `build`? | build config | tests live in | covered by base `tsconfig.json` `include`? |
|---|---|---|---|---|
| cadre-cli | yes | `tsc -p tsconfig.build.json` | (CLI; few/none) | `include: ["src"]` |
| cadre-core | yes | `tsc -p tsconfig.build.json` | `test/*.spec.ts` | **no** — `test/` is outside `src` |
| cadre-host | yes | `tsc -p tsconfig.build.json && vite build` | `src/**/__tests__/*.test.ts` + `ui/` svelte | server tests: yes; build.json **excludes** `*.test.ts`/`*.spec.ts`/`test` |
| cadre-provider | yes | `tsc -p tsconfig.build.json` | — | `include: ["src"]` |
| integration-tests | yes | `tsc -p tsconfig.build.json` | `src/**/*.integration.ts` | yes (and build.json only excludes `*.spec.ts`/`*.test.ts`, so `.integration.ts` IS compiled) |
| quereus-plugin-sereus | yes | `tsc -p tsconfig.build.json && node scripts/build-browser.mjs` | (vitest) | `include: ["src"]` |
| strand-proto | yes (deprecated) | `tsc -p tsconfig.build.json` | (vitest) | `include: ["src"]` |
| reference-app-rn | no (expo) | — | — | `tsconfig.json` extends `expo/tsconfig.base`, `include: ["**/*.ts","**/*.tsx"]` |
| reference-app-web | n/a | `tsc --noEmit && vite build` | playwright e2e | already has `typecheck` |

All `tsconfig.build.json` files extend the package's base `tsconfig.json`; some add `noEmit:false`,
cadre-host/integration-tests add `exclude` for test files.

## Design decision: what scope should `typecheck` validate?

Two reasonable targets:

- **Shippable source only** — `tsc -p tsconfig.build.json --noEmit`. Mirrors exactly what `build`
  compiles, so it is guaranteed to pass today (build already passes) and adds zero new failures.
  This already catches the motivating `integration-tests` TS2353 case, because `.integration.ts`
  files are NOT excluded by that package's `tsconfig.build.json`.
- **Source + tests** — type-check test files too (`test/*.spec.ts`, `src/**/__tests__/*.test.ts`).
  These are currently type-unchecked anywhere (vitest skips type-checking, build.json excludes them),
  so this is where the most regressions hide — but enabling it may surface pre-existing errors.

**Recommendation:** ship the shippable-source typecheck for every package as the primary, must-pass
deliverable (closes the "1 of 9" bug with zero risk). Then, as a second pass, widen coverage to test
files where it can be made green; for any package whose tests have pre-existing type errors out of
scope for this ticket, leave the narrow typecheck, fix the quick ones, and document the remainder in
the review handoff (or file a follow-up fix ticket). Do NOT silently leave whole packages' tests
unchecked without saying so.

Concrete per-package command:
- Packages with `tsconfig.build.json` (cadre-cli, cadre-core, cadre-host, cadre-provider,
  integration-tests, quereus-plugin-sereus, strand-proto): `tsc -p tsconfig.build.json --noEmit`.
- reference-app-rn (no build.json): `tsc --noEmit -p tsconfig.json`.
- reference-app-web: already present — leave as-is.

For test coverage, prefer adding the test paths to the package's typecheck config rather than
inventing a new janky setup: e.g. a small `tsconfig.typecheck.json` per package that extends the base
and `include`s both `src` and the test dir (`test`, `src/**/__tests__`), then point `typecheck` at it.
Keep configs DRY (extend, don't copy).

## Out of scope / known gaps to note in handoff

- cadre-host `ui/` is Svelte (`ui/src/**/*.svelte`, tests in `ui/__tests__/*.test.ts`) and is not
  covered by the server `tsconfig.build.json`. Svelte type-checking needs `svelte-check`, not `tsc`.
  Document as a gap (the server typecheck does not validate the UI).
- reference-app-web's `tsc --noEmit` does not type-check `.svelte` files (would need `svelte-check`,
  which is already a devDependency). Pre-existing; note but do not necessarily fix here.
- strand-proto is deprecated (per AGENTS.md). Add a typecheck anyway for uniformity unless it
  surfaces errors; if it does, document and skip rather than fixing deprecated code.

## TODO

- [ ] Add a `typecheck` script to each TS package per the per-package commands above
      (cadre-cli, cadre-core, cadre-host, cadre-provider, integration-tests, quereus-plugin-sereus,
      strand-proto, reference-app-rn). Leave reference-app-web's untouched.
- [ ] Run `yarn typecheck` from the repo root and confirm it now fans out to every package and exits 0.
      Stream output (`yarn typecheck 2>&1 | tee /tmp/typecheck.log`).
- [ ] Decide and implement test-file coverage per the design decision; for any package left at
      shippable-source-only, record why.
- [ ] Fix any real type errors surfaced that are caused by this widening and are quick/in-scope.
      Pre-existing, unrelated failures → follow the "Pre-existing test failures" protocol
      (write tickets/.pre-existing-error.md) rather than chasing them here.
- [ ] Update docs/STATUS.md (or the relevant build-health doc) to note that `yarn typecheck` now
      covers the whole monorepo, and list any remaining coverage gaps (cadre-host UI, web .svelte).
- [ ] Produce a review/ handoff honest about what is and isn't type-checked.
