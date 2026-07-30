description: Six more packages' test-runner config files are now type-checked, so a future Vitest option removal fails `yarn typecheck` instead of silently doing nothing, closing the gap `integration-tests` already fixed.
files: packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-core/tsconfig.typecheck.json, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-provider/tsconfig.typecheck.json (new), packages/cadre-provider/package.json, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/strand-proto/tsconfig.typecheck.json (new), packages/strand-proto/package.json, docs/STATUS.md
---

# Type-check every package's vitest.config.ts (6 remaining packages)

## What changed

Applied the plan from the implement ticket verbatim — no deviations:

- **`cadre-cli`, `cadre-core`, `quereus-plugin-sereus`**: added `"vitest.config.ts"` to
  `tsconfig.typecheck.json`'s `include`. All three already had a `rootDir` override wide
  enough (`.`, `../..`, `.` respectively), so no TS6059 risk.
- **`cadre-host`**: `tsconfig.typecheck.json` had no `rootDir` override (inherited `src`
  from base `tsconfig.json`). Added `rootDir: "."` plus `vitest.config.ts` to `include`.
  Left `test`/`ui/__tests__` out — this package's `typecheck` stays source-only by design
  (see `docs/STATUS.md` known-gaps note on `cadre-core`/`cadre-host` test type drift).
- **`cadre-provider`**: new `tsconfig.typecheck.json` (extends `./tsconfig.json`,
  `rootDir: "."`, `include: ["src", "vitest.config.ts"]`,
  `exclude: ["src/**/__tests__/**"]`) so its co-located `.test.ts` files (confirmed
  present: `src/service/__tests__/*.test.ts`, `src/server/__tests__/*.test.ts`,
  `src/config/__tests__/*.test.ts`) stay out of the type-check program (they carry the
  same kind of type drift `cadre-core`/`cadre-host` tests do — untouched here).
  `package.json`'s `typecheck` script now points at this new file instead of
  `tsconfig.build.json`; `build` script and `tsconfig.build.json` itself are untouched.
- **`strand-proto`**: new `tsconfig.typecheck.json` (extends `./tsconfig.json`,
  `rootDir: "."`, `include: ["src", "vitest.config.ts"]`). `package.json`'s `typecheck`
  script repointed the same way; `build`/`tsconfig.build.json` untouched.
- **`docs/STATUS.md`** → "Type-check coverage": added a bullet describing the
  `vitest.config.ts`-included-everywhere invariant and why it exists (the Vitest 4
  `singleFork` removal precedent), updated the per-package scope bullets to note
  `cadre-core`/`cadre-host`/`cadre-provider`/`strand-proto` now type-check via their own
  `tsconfig.typecheck.json` (not `tsconfig.build.json`) with `vitest.config.ts` included,
  and corrected the stale "`cadre-provider` has no test files" line — it has test files,
  they're intentionally excluded from `typecheck`, not absent.

`reference-app-rn` needed no change (confirmed pre-existing: its `typecheck` script runs
`tsc --noEmit -p tsconfig.json` directly, whose `include` already matches
`vitest.config.ts` at the package root).

## Validation performed

- `yarn workspace @serfab/cadre-cli typecheck` — clean
- `yarn workspace @serfab/cadre-core typecheck` — clean
- `yarn workspace @serfab/cadre-host typecheck` — clean
- `yarn workspace @serfab/quereus-plugin-sereus typecheck` — clean (its
  `vitest.config.ts` uses `test.projects` with two named projects, `unit`+`e2e` —
  type-checks cleanly under the installed Vitest version, no cast/suppress needed)
- `yarn workspace @serfab/cadre-provider typecheck` — clean (confirms the
  `src/**/__tests__/**` exclude actually keeps test-file type drift out — no new errors
  appeared)
- `yarn workspace @serfab/strand-proto typecheck` — clean
- `yarn workspace @serfab/cadre-provider build` — clean, `tsconfig.build.json` path
  untouched
- `yarn workspace @serfab/strand-proto build` — clean, `tsconfig.build.json` path
  untouched
- Root `yarn typecheck` (all workspaces) — clean, gate still green end-to-end

## What the reviewer should double check

- The `cadre-provider` and `strand-proto` `tsconfig.typecheck.json` files are new — worth
  confirming they aren't picked up anywhere unexpected (e.g. an IDE `tsconfig` search, a
  future `tsc -b` project-reference graph) beyond the `typecheck` script that now points
  at them.
- No test files were run as part of this ticket (only `typecheck`/`build`); this is a
  config-only, source-scope-preserving change, so `yarn test` wasn't re-run per package —
  reasonable to spot-check `cadre-provider`'s test run still passes if the reviewer wants
  extra confidence, though nothing in this diff touches runtime test code or `vitest`
  config content itself, only the TS *program* that type-checks the config file.
- No pre-existing test failures encountered; nothing written to
  `tickets/.pre-existing-error.md`.
