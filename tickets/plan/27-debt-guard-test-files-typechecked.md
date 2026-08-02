description: Nothing stops someone from quietly hiding a package's test files from the type checker, so tests can drift out of sync with the code for months before anyone notices — add an automated check that catches it.
prereq: debt-widen-typecheck-to-test-files
files: scripts/check-vitest-typecheck-coverage.mjs, scripts/check-vitest-typecheck-coverage.test.mjs, package.json, docs/STATUS.md
difficulty: medium
---

# Guard: every test file the test runner collects is also type-checked

## Why

Vitest never type-checks the files it runs — it strips types and executes. So a test file
only gets type safety if some `tsc` program also includes it. Nothing in the repo enforces
that today, and the consequence has already played out once: `cadre-provider` excluded its
own test directory from its type-check program to get past a batch of errors, the follow-up
was never filed, and `docs/STATUS.md` ended up pointing at a ticket slug that did not exist
on the board. The exclusion sat there unnoticed across several dependency upgrades. Two other
packages had the same exclusion, were fixed, and the doc was never corrected — so the written
record and the actual state disagreed in both directions at once.

The nearby precedent already exists and works well: `scripts/check-vitest-typecheck-coverage.mjs`
enforces that each package's `vitest.config.ts` is inside that package's type-check program,
after a Vitest option removal went unnoticed for a whole major version. This is the same
class of gap, one level out — the config is guarded, the tests it runs are not.

## What the check should do

For each workspace holding a Vitest config: ask Vitest (or replicate its `include` globs)
which test files it would collect, ask the TypeScript compiler API which files the package's
`typecheck` script actually resolves to, and fail naming any collected test file that is
absent from every type-check program.

The existing guard already solved the hard half of this — reading a package's `typecheck`
script, extracting every `-p`/`--project` it passes (there can be more than one), and using
`ts.getParsedCommandLineOfConfigFile` to expand `extends` / `include` / `exclude` into a real
file list. Extend that machinery rather than writing a second one.

## Things the design has to decide

- **Where the "what does Vitest collect" list comes from.** Re-implementing glob matching by
  hand is the janky-parser trap; prefer asking Vitest itself, or reusing its config object.
- **Packages that legitimately have no type-check program for some tests.** `strand-proto` is
  deprecated and source-only by design; `.svelte` files can only be checked by `svelte-check`.
  The guard needs an explicit, small, commented allowlist rather than silence — an entry
  someone has to justify beats a gap nobody sees.
- **Whether it belongs in the existing script or a sibling.** One script doing two checks
  keeps the tsconfig-resolution logic in one place; two scripts keep failure messages sharper.

## Acceptance

- Reintroducing an exclusion like `"exclude": ["src/**/__tests__/**"]` in any package's
  type-check config fails the root gate, naming the package and at least one orphaned file.
- The guard is chained into root `yarn typecheck` alongside the existing one.
- Throwaway-fixture tests prove it catches drift rather than merely passing today — mirror
  the style of `scripts/check-vitest-typecheck-coverage.test.mjs`, which covers ~16 fixture
  workspaces.
- `docs/STATUS.md` → "Type-check coverage" describes the new guard.
