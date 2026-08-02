description: Seven test suites rely on a single line of configuration to switch on their stale-build safety check, and nothing notices if that line is deleted — the check would silently stop running and every suite would keep reporting green.
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-web/vitest.config.ts, packages/cadre-core/vitest.config.ts, packages/cadre-cli/vitest.config.ts, packages/cadre-host/vitest.config.ts, packages/quereus-plugin-sereus/vitest.config.ts, packages/integration-tests/vitest.config.ts, test-harness/build-freshness.ts, scripts/check-test-file-typecheck-coverage.mjs
difficulty: easy
---

# The stale-build guard can be switched off by accident, silently

## Background

Several packages' test suites run *compiled* output of other packages rather than
their sources — the compiled copy is what a dependency's `package.json` points at,
so a source edit with no following build is invisible to the tests. The repo's
answer is a check (`test-harness/build-freshness.ts`) that runs once before a
suite starts and aborts it if any of those packages' build output is older than
its sources.

A package switches the check on by naming its setup file in one field of its
Vitest config:

```ts
globalSetup: ['./test/global-setup.ts'],
```

Seven packages do this today: `integration-tests`, `cadre-core`, `cadre-cli`,
`cadre-host`, `quereus-plugin-sereus`, `reference-app-web`, `reference-app-rn`.

## The problem

Delete that one line from any of them and everything still passes. The setup file
stays on disk, stays type-checked, and stays imported (the package's
`build-targets.spec.ts` imports its target list from it), so no lint rule, no
dead-code check and no test notices. The suite simply stops checking build
freshness and goes back to reporting green about code it never ran — the exact
failure the check was built to prevent, and one that previously cost three
repeated investigations of a bug that had already been fixed but not rebuilt.

The repo already has two sibling checks in this family, each written after the
same kind of silent drift bit someone:

- `scripts/check-vitest-typecheck-coverage.mjs` — every `vitest.config.ts` is
  inside its package's type-check program.
- `scripts/check-test-file-typecheck-coverage.mjs` — every test file Vitest
  collects, plus the setup files it executes, is type-checked.

Neither covers this direction. The second one asks Vitest which setup files it
executes and checks those are type-checked; a package that stops executing one
simply drops out of the list.

## Expected behaviour

A package whose test suite runs another package's compiled output must not be
able to lose its freshness check without something failing. Two shapes worth
weighing:

- **Repo-level**: a check that finds each package owning a stale-build setup file
  and asserts that package's Vitest config actually executes it — the same shape
  as the two scripts above, and the one that keeps the knowledge in one place.
- **Per-package**: have the setup record that it ran, and have the package's
  existing `build-targets.spec.ts` assert it did. Fails inside the suite it
  protects, at the cost of a marker passed between the setup process and the test
  process.

Either way the failure message should name the package and the missing wiring, so
whoever hits it can fix it without reading the guard's internals.

Out of scope: any change to what the freshness check itself compares.
