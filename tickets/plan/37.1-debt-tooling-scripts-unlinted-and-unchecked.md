----
description: The repo's build and gate helper scripts are skipped by the linter and by the type checker, so roughly 2,600 lines of tooling code — including the scripts that enforce quality gates on everything else — get no automated checking at all.
files: eslint.config.mjs, docs/STATUS.md, scripts/, packages/*/scripts/
difficulty: medium
----

# Tooling scripts are outside every automated check

## What is true today

`eslint.config.mjs` lists `scripts/**` and `**/scripts/**` in its global `ignores` block. Nothing
under either path is linted. Nothing under either path is inside a TypeScript program either — the
files are plain `.mjs`/`.js`, and no `tsconfig.json` in the repo sets `allowJs`/`checkJs` or includes
them.

Measured with `wc -l` on 2026-08-02:

- root `scripts/` — 1,768 lines across 9 files
- `packages/*/scripts/` — 891 lines across 5 files

So ~2,660 lines of code that runs on every developer machine and in every gate invocation has no lint
pass and no type pass.

## Why it matters more than it used to

When the exclusion was written, `scripts/` held release helpers. It now holds the gates themselves:
`check-dep-ranges.mjs`, `check-vitest-typecheck-coverage.mjs`, `check-test-file-typecheck-coverage.mjs`
and a shared `lib/`, together with their own test suites — the code that decides whether `yarn lint`,
`yarn typecheck`, `yarn test` and `yarn dep-check` pass or fail. A silent mistake in that code does not
show up as a red build; it shows up as a gate that stops catching things, which is the exact failure
mode the type-check-coverage work exists to prevent.

`docs/STATUS.md` already records the exclusion honestly (see "Lint coverage" → Scope notes), so this
is not a documentation drift; it is a scope decision that has outlived its rationale.

## What the work is

Two arms, both rooted at the same place — the `ignores` entry in `eslint.config.mjs`:

**Lint.** Drop `scripts/**` and `**/scripts/**` from the global `ignores`, give those trees a config
block with node globals and non-type-aware rules, and fix whatever the first run reports. The
per-package `scripts/` dirs need the same treatment or their own narrower ignore — note that removing
`**/scripts/**` also pulls in `packages/cadre-host/scripts/*.mjs`, which `knip.ts` already declares as
real entry points.

**Type-check (open question, decide as part of the work).** Options are: leave them as unchecked
JavaScript; add `// @ts-check` plus a `checkJs` tsconfig covering `scripts/`; or convert the gate
scripts to TypeScript and run them through `tsx`/a build step. The third buys the most and costs the
most — the scripts currently run with bare `node` and no toolchain, which is part of why they are
reliable. Pick one deliberately rather than defaulting.

Whatever lands, update `docs/STATUS.md` → "Lint coverage" → Scope notes so the recorded scope matches
reality again.
