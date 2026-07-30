description: Every package's test-runner config file is currently type-checked, but nothing stops a newly added package from quietly skipping that — add an automated check so the repo can't drift back into the silent-broken-setting problem it just fixed.
files: scripts/check-dep-ranges.mjs, scripts/check-dep-ranges.test.mjs, package.json, docs/STATUS.md, packages/*/tsconfig.typecheck.json, packages/*/vitest.config.ts
difficulty: easy
---

# Guard the "vitest.config.ts is type-checked" invariant

## Background

Vitest never type-checks its own config file. If the installed Vitest drops or renames a
setting, a config that still uses the old setting keeps running with that setting silently
ignored. This actually happened: `test.poolOptions.forks.singleFork` was removed in Vitest 4,
`packages/integration-tests/vitest.config.ts` kept it, and the integration suite ran its
network-binding scenarios in parallel for a whole major version without anyone noticing.

The fix was to pull each package's `vitest.config.ts` into the TypeScript program that
`yarn typecheck` runs, so an unknown option becomes a hard type error. That is now true for
all nine packages that have a `vitest.config.ts`.

## The gap

The invariant is held together only by nine hand-edited config files and a paragraph in
`docs/STATUS.md`. Nothing fails if it is broken. Three realistic ways it silently regresses:

- A **new package** lands with a `vitest.config.ts` and a `tsconfig.typecheck.json` copied
  from a sibling — but the `include` list is trimmed and the config file is left out.
  `packages/reference-app-ns` is the concrete near-term case: it is the one workspace with no
  `vitest.config.ts` today, and `debt-ns-unit-test-harness` will add one.
- Someone **repoints a `typecheck` script** back at `tsconfig.build.json` (two packages were
  pointed there until recently), which deliberately does not include the config file.
- Someone **narrows an `include`** while cleaning up, and the removal looks harmless because
  the package still type-checks green.

In every case `yarn typecheck` stays green and the protection is gone.

## What is wanted

A check that fails the build when a package with a `vitest.config.ts` does not have that file
in the program its `typecheck` script actually compiles. The repo already has the shape for
this: `scripts/check-dep-ranges.mjs` is a plain Node script, and
`scripts/check-dep-ranges.test.mjs` runs it under `node --test`, wired into the root
`yarn test` via `test:dep-ranges`. Following that pattern keeps it cross-platform and
independent of any one package's test runner.

The check needs to reason about what the `typecheck` script really compiles, not about a
hardcoded list of packages. Reading each `package.json`'s `typecheck` script to find which
tsconfig it uses, then asking TypeScript which files that project resolves to (for example
`tsc -p <config> --listFiles`, or the TypeScript API's config parser), is more robust than
pattern-matching `include` arrays — `include` can reach a file by directory, by glob, or not
at all, and only the resolved file list settles it.

## Expected behaviour

- Passes today, unchanged, against all ten workspaces.
- Fails with a clear message naming the offending package when a `vitest.config.ts` exists but
  is absent from that package's type-check program.
- Says nothing about packages that have no `vitest.config.ts` — that is not a violation.
- Runs in seconds, on Windows and POSIX alike, with no network.

## Verification

The check must be proven to actually catch a violation, not merely to pass. Reviewers have
confirmed the underlying protection works by injecting an unknown key into a
`vitest.config.ts` and observing `TS2769 … does not exist in type 'InlineConfig'`; the guard
deserves the equivalent — a test that removes the config file from a synthetic project and
asserts the check reports it.

Update `docs/STATUS.md` → "Type-check coverage" to point at the guard instead of describing
the invariant as convention-only.
