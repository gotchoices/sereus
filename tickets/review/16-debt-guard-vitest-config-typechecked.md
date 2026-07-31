description: Added an automated check that fails the build if any package's test-runner config file (vitest.config.ts) stops being type-checked, so the repo can never again silently drift back into a config setting going unvalidated.
files: scripts/check-vitest-typecheck-coverage.mjs, scripts/check-vitest-typecheck-coverage.test.mjs, package.json, docs/STATUS.md
---

# Guard the "vitest.config.ts is type-checked" invariant

## What shipped

- `scripts/check-vitest-typecheck-coverage.mjs` — for every `packages/*` dir with a
  `vitest.config.ts`, reads that package's `package.json` `scripts.typecheck`, extracts every
  `-p <config>` arg (falls back to `./tsconfig.json` if none), and asks the TypeScript compiler
  API (`ts.getParsedCommandLineOfConfigFile`) for the actual resolved file list of that tsconfig
  — following `extends` and expanding `include`/`exclude` the same way `tsc` would. Fails, naming
  the package and tsconfig(s) checked, if `vitest.config.ts` isn't in that resolved set. Packages
  with no `vitest.config.ts` (currently just `reference-app-ns`) are silently skipped — that's the
  correct passing state for them.
- `scripts/check-vitest-typecheck-coverage.test.mjs` — `node --test`, 10 fixture-based cases using
  throwaway `mkdtempSync` workspaces via `VITEST_TYPECHECK_COVERAGE_CHECK_ROOT` (same pattern as
  `check-dep-ranges.test.mjs`'s `DEP_RANGE_CHECK_ROOT`). Includes a case that removes
  `vitest.config.ts` from a synthetic project's `include` and asserts the checker catches it —
  proves the guard detects real drift, not just that it passes today.
- `package.json`: `check:vitest-typecheck-coverage` chained into root `typecheck`; new fixture
  suite chained into root `test` as `test:vitest-typecheck-coverage`.
- `docs/STATUS.md` → "Type-check coverage": describes the guard and what the fixture suite proves,
  replacing the earlier note that nothing enforced this.

## Verification performed (this session, all green)

| command | result |
| --- | --- |
| `node scripts/check-vitest-typecheck-coverage.mjs` | exit 0, all 10 workspaces covered |
| `node --test scripts/check-vitest-typecheck-coverage.test.mjs` | 10/10 pass |
| `node --test scripts/check-dep-ranges.test.mjs` | 9/9 pass, unaffected (regression check) |
| `yarn typecheck` | green, ~16s, new gate runs and passes at the end of the chain |
| `yarn eslint scripts/check-vitest-typecheck-coverage.mjs scripts/check-vitest-typecheck-coverage.test.mjs` | 0 errors (2 "file ignored" warnings — `scripts/` is eslint-ignored repo-wide, same as `check-dep-ranges.mjs`) |

Reviewed the script source directly against the ticket's "edge cases & interactions" list
(no-`-p`-flag fallback, `-p` position independence, glob `include` reaching the file implicitly,
repointed-config regression, non-`tsc` script, missing tsconfig, `extends` chains) — each has a
matching fixture in the test file and the logic in `checkPackage`/`tsconfigPathsForTypecheckScript`/
`resolvedProgramFiles` matches what's claimed.

## Known gaps / not covered

- Full `yarn test` (all 10 workspaces' own suites) was **not** run this session — only the two
  root-level `node --test` suites this change touches (`check-vitest-typecheck-coverage.test.mjs`,
  `check-dep-ranges.test.mjs`) were run directly. This diff doesn't touch any package's own test
  code, so the risk is low, but a reviewer wanting full-suite confidence should run it.
- No fixture exercises **multiple `-p` flags in one script** end-to-end against a real package
  (no current package needs it) — the "passes if any one tsconfig covers the file" behavior is
  read from the code (`tsconfigPaths.some(...)`), not exercised by a dedicated test.
- Windows-path handling (`resolve()` normalization before comparing) was verified by the full
  fixture suite and real-repo run passing on Windows, but there's no fixture specifically
  asserting mixed-separator paths compare equal — it's an emergent property of using `resolve()`
  rather than a targeted regression test.
