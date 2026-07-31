description: Every package's test-runner config file is currently type-checked, but nothing stopped a newly added package from quietly skipping that — this ticket adds an automated check so the repo can't drift back into the silent-broken-setting problem it just fixed, and it has already been built and verified; what remains is confirming the diff and handing it to review.
files: scripts/check-vitest-typecheck-coverage.mjs, scripts/check-vitest-typecheck-coverage.test.mjs, package.json, docs/STATUS.md
difficulty: easy
---

# Guard the "vitest.config.ts is type-checked" invariant

## Status: implementation complete, awaiting confirmation + handoff to review

The design from the plan stage was resolved with no open questions, so this ticket was
implemented directly rather than left as a spec. Everything below is done and verified; the
job for whoever picks up this ticket is to re-run the verification commands, sanity-check the
diff against the "Edge cases & interactions" list, and move it to `tickets/review/`.

## What was built

`scripts/check-vitest-typecheck-coverage.mjs` — plain Node script, same shape as
`scripts/check-dep-ranges.mjs`. For every `packages/*` directory that has a `vitest.config.ts`:

1. Reads that package's `package.json` → `scripts.typecheck`.
2. Extracts every `-p <config>` argument from that script string (falls back to `./tsconfig.json`
   if the script has no `-p` flag at all — e.g. `reference-app-web`'s bare `tsc --noEmit`).
3. For each such tsconfig, calls the TypeScript compiler API —
   `ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, parseConfigHost)` — to get the actual
   resolved file list (this follows `extends` chains and expands `include`/`exclude` exactly as
   `tsc` would, so it isn't fooled by a file reached only implicitly through a directory or glob
   entry, and isn't fooled by a file reachable in principle but excluded).
4. Fails, naming the package and the tsconfig(s) checked, if `vitest.config.ts` is not in the
   resolved set for any of them.

Packages with no `vitest.config.ts` (currently only `reference-app-ns`) are never mentioned —
silence is the correct/passing state for them.

`scripts/check-vitest-typecheck-coverage.test.mjs` — `node --test`, fixture-based (throwaway
`mkdtempSync` workspaces via a `VITEST_TYPECHECK_COVERAGE_CHECK_ROOT` env var override, same
pattern as `DEP_RANGE_CHECK_ROOT` in `check-dep-ranges.test.mjs`). 10 cases, including — per the
ticket's verification requirement — one that removes `vitest.config.ts` from a synthetic
project's `include` and asserts the checker reports it (proving the guard catches real drift,
not just that it passes today).

Wiring in root `package.json`:
- `"check:vitest-typecheck-coverage": "node scripts/check-vitest-typecheck-coverage.mjs"` — the
  real gate against this actual repo's 10 workspaces, chained into `"typecheck"`
  (`yarn workspaces foreach -A run typecheck && yarn check:vitest-typecheck-coverage`). Runs
  every time anyone runs `yarn typecheck`, not just at test time.
- `"test:vitest-typecheck-coverage": "node --test scripts/check-vitest-typecheck-coverage.test.mjs"`
  — the fixture unit suite, chained into root `"test"` (mirrors `test:dep-ranges`).

`docs/STATUS.md` → "Type-check coverage": replaced the "Nothing *enforces* the invariant... see
`debt-guard-vitest-config-typechecked`" line with a paragraph describing the guard, what it checks,
and what the fixture suite proves.

## Verification already run (all green)

```
node scripts/check-vitest-typecheck-coverage.mjs          # exit 0, all 10 workspaces
node --test scripts/check-vitest-typecheck-coverage.test.mjs   # 10/10 pass
node --test scripts/check-dep-ranges.test.mjs              # 9/9 pass, unaffected
yarn typecheck                                             # green, ~19s, new gate runs at the end
yarn eslint scripts/check-vitest-typecheck-coverage.mjs scripts/check-vitest-typecheck-coverage.test.mjs
                                                             # 0 errors (scripts/ is eslint-ignored,
                                                             # same as check-dep-ranges.mjs — warning only)
```

Not yet run in this session: full `yarn test` (all 10 workspaces' own suites) — only the two
root-level `node --test` suites relevant to this change were run directly, since the full
per-workspace suite run is unrelated to this diff and is the kind of long-running validation
better left to CI/a full local run. `yarn test:dep-ranges` and `yarn test:vitest-typecheck-coverage`
(the two suites this change touches or adds) were both run directly above and pass.

## Edge cases & interactions

- **`typecheck` script with no `-p` flag** (`reference-app-web`: `tsc --noEmit`) — handled by
  falling back to `./tsconfig.json`. Covered by a fixture test.
- **`-p` flag position varies** (`reference-app-rn`: `tsc --noEmit -p tsconfig.json`, most others:
  `tsc -p tsconfig.typecheck.json --noEmit`) — regex is position-independent. Covered by a
  fixture test.
- **Glob `include` that reaches the config file implicitly**, e.g. `reference-app-rn`'s
  `["**/*.ts", "**/*.tsx"]` (no explicit `vitest.config.ts` entry) — must not false-positive as
  "not covered" just because the file isn't named literally in `include`. This is exactly why the
  check asks the TypeScript compiler API for the resolved file list instead of string-matching
  `include`. Covered by a fixture test.
- **`typecheck` script repointed at a different config** (the ticket's named regression: someone
  points `typecheck` back at `tsconfig.build.json`, which deliberately excludes tests/config) —
  must fail, naming the actual config the script now points at. Covered by a fixture test.
- **`typecheck` script that isn't `tsc`-based at all**, or a script field that's missing — can't
  statically know what it type-checks, so this is treated as a failure (not a silent pass) with a
  distinct reason string. Covered by a fixture test.
- **Referenced tsconfig doesn't exist on disk** — reported as a readable failure rather than an
  uncaught `ENOENT`/exception. Covered by a fixture test.
- **Multiple `-p` flags in one script** — not currently used by any package, but the extraction
  returns all of them and the package passes if *any* one covers `vitest.config.ts` (matches "the
  program the script compiles" framing — if any invocation covers it, the file is type-checked
  when the script runs).
- **`reference-app-ns`** — the one workspace with no `vitest.config.ts` today. Must produce zero
  output/failures for it. Covered by a fixture test ("package with no vitest.config.ts at all is
  not mentioned") and confirmed against the real repo run (`reference-app-ns` never appears in
  passing output). When `debt-ns-unit-test-harness` later adds a `vitest.config.ts` there, this
  guard starts covering it automatically — no code change needed here.
- **Windows path handling** — the script resolves both the TypeScript-returned file paths and the
  target `vitest.config.ts` path through `node:path`'s `resolve()` before comparing, so separator
  and relative-vs-absolute differences don't cause false mismatches. Verified by running the real
  check and the full fixture suite on Windows (this session's environment) — all pass.
- **`tsconfig` `extends` chains** — `ts.getParsedCommandLineOfConfigFile` resolves `extends`
  itself (used by e.g. `cadre-cli/tsconfig.typecheck.json` → `./tsconfig.json`), so a file only
  reachable through an inherited `include` is still correctly detected. Exercised implicitly by
  every fixture test (all fixtures use `extends`) and by the real-repo run.

## Nothing else to do

No open design questions remain. No backlog spin-off — the ticket's stated scope (guard the
invariant for future packages) is fully covered.
