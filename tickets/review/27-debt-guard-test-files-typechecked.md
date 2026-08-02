description: A new automated check makes sure every test file the test runner executes is also being type-checked, so tests can no longer be quietly hidden from the type checker and drift out of sync with the code.
files: scripts/check-test-file-typecheck-coverage.mjs, scripts/check-test-file-typecheck-coverage.test.mjs, scripts/lib/typecheck-programs.mjs, scripts/check-vitest-typecheck-coverage.mjs, scripts/test-typecheck-allowlist.json, package.json, knip.ts, docs/STATUS.md
difficulty: medium
---

# Review: guard that every test file Vitest collects is inside a type-check program

## What landed

Vitest strips types and executes — it never type-checks the files it runs, so a test file only has
type safety if some `tsc` program happens to include it. Nothing enforced that. Now something does.

**`scripts/lib/typecheck-programs.mjs`** (new) — shared, side-effect-free helpers for both gates:
`readJson`, `normalizePath`, `vitestConfigPaths`, `workspacePackageDirs`,
`tsconfigPathsForTypecheckScript`, `resolvedProgramFiles`. Moved verbatim out of the existing gate,
`NOTE:` comments carried along. `normalizePath` is the one new function: `resolve()` plus
lowercasing on `win32`, applied on both sides of every path comparison (Vitest hands back
forward-slashed `C:/…`; TypeScript hands back platform separators; drive-letter case can differ).

**`scripts/check-vitest-typecheck-coverage.mjs`** (edited) — now imports from the lib and compares
through `normalizePath`. No behavior change; its 16 fixtures pass **with the test file unmodified**.

**`scripts/check-test-file-typecheck-coverage.mjs`** (new) — the gate. Per package holding a Vitest
config: `createVitest` → `globTestSpecifications()` → plus every project's `setupFiles` and
`globalSetup` → filter to TS extensions, drop `node_modules` → diff against the union of the
package's resolved `tsc` programs → subtract the validated allowlist. Each package is wrapped so one
broken config reports as that package's failure instead of aborting the sweep, and `vitest.close()`
always runs before the explicit `process.exit(await main())`.

**`scripts/test-typecheck-allowlist.json`** (new) — one entry, `@serfab/strand-proto`, three files.

**Root wiring** — `check:test-file-typecheck-coverage` + `test:test-file-typecheck-coverage` scripts,
chained into `typecheck` and `test`. `vitest: ^4.0.17` added to root `devDependencies` (the script
imports `vitest/node`; before this it resolved only by hoisting accident).

**`knip.ts`** — `test-harness/**` removed from the root workspace `ignore`. Not cosmetic drive-by:
adding root `vitest` made knip emit a new `Remove from ignore` configuration hint, because
`test-harness/*.ts`'s `vitest` import now resolves against the root manifest. Measured both ways —
unused-file count is 14 either way, so removing the ignore costs nothing and clears the hint.

**`docs/STATUS.md`** — new gate documented under "Type-check coverage"; the false `strand-proto`
bullet corrected; the three deliberate blind spots recorded under "Known coverage gaps".

## Validation actually run

- `yarn typecheck` — passes, both gates green at the end.
- `yarn lint` — clean.
- `node --test scripts/check-test-file-typecheck-coverage.test.mjs` — **29/29 pass** (~15 s).
- `node --test scripts/check-vitest-typecheck-coverage.test.mjs` — **16/16 pass**, file untouched.
- `yarn dep-check` — exits 0. One configuration hint remains (`@tsconfig/svelte`, pre-existing).
- **The gate actually bites**: temporarily added `"exclude": ["src/**/__tests__/**"]` to
  `packages/cadre-provider/tsconfig.typecheck.json` → exit 1, `19 of 19 collected test/setup file(s)
  are not in the type-check program`, ten files listed then `… and 9 more`. Reverted; tree verified clean.
- **The allowlist reason was measured, not copied**: temporarily added `test` to
  `packages/strand-proto/tsconfig.typecheck.json` and ran `tsc` → **11 errors**, not the ~12 the plan
  estimated (4x TS2353, 2x TS5097, TS2339, TS2322, TS2345, TS2352, TS2561). Both the allowlist
  `reason` and `docs/STATUS.md` say 11. Reverted; tree verified clean.

Repo baseline on a green run: **251 collected files across 9 Vitest packages, 3 allowlisted, 0
unexplained orphans**, in **~1.1 s** wall clock (plan budgeted ~1.2 s). Per-package spec+setup counts
match the plan's measured table exactly for all nine packages.

## What a reviewer should poke at

**The regression baseline is the whole repo passing.** If any change here makes a currently-covered
package start reporting orphans, the change is wrong — `node scripts/check-test-file-typecheck-coverage.mjs`
must print `0 unexplained orphans` (251 files / 9 packages / 3 allowlisted).

**Highest-value adversarial targets:**

- *Path normalization.* Only exercised on Windows in this run. The POSIX path (no lowercasing) is
  untested by CI here. A reviewer on Linux/macOS should confirm the repo sweep still reports 0 orphans.
- *`vitest.close()` under failure.* The `finally` in `collectRunFiles` covers post-creation failures;
  a `createVitest` that rejects mid-construction leaves nothing to close. Process exits cleanly today
  (verified — the sweep and all 29 fixtures terminate without hanging), but this is the shape most
  likely to leave a stray Vite handle if Vitest's constructor changes.
- *Allowlist staleness in both directions.* Fixtures cover both, but the real value only shows when
  `strand-proto` is eventually deleted or revived. Worth reading `validateAllowlist` for a path where
  a stale entry could be silently tolerated.
- *`record.error` short-circuits staleness checks.* Deliberate: if a package failed to resolve, neither
  staleness direction is knowable and the package already fails on its own. Confirm that can't mask a
  genuinely stale entry across runs.

**Known gaps, stated plainly rather than papered over:**

- The three deliberate blind spots (`.js` test files, `node_modules` setup modules, `.svelte`) are
  `NOTE:`-commented at their code sites and recorded in `docs/STATUS.md`. They are choices, not oversights.
- `yarn test` (the full workspace suite) was **not** run end-to-end — it routinely exceeds the
  ten-minute agent idle budget. The two script suites it newly chains were run directly and pass.
- Only `packages/*` is swept — inherited from the sibling gate's `workspacePackageDirs`, `NOTE:`-flagged
  in the lib. A second workspace root would go unchecked silently.
- Fixture cost: 29 spawns × ~0.55 s ≈ 15 s for `yarn test:test-file-typecheck-coverage`. Each spawn
  boots Vitest. Acceptable now; it grows linearly with fixture count.

## Review findings

- `docs/STATUS.md` line ~619 claims the dep-check gate "exits 0 with no knip configuration hints".
  That is stale at HEAD — `@tsconfig/svelte  packages/cadre-host  Remove from ignoreDependencies`
  is emitted today and predates this ticket (verified: it survives with root `vitest` removed).
  Left alone as out of scope for a test-file-coverage ticket, and it does not fail the gate — but it
  is the same class of doc-versus-reality drift this ticket exists to stop, in a neighbouring section.
- Tripwire parked as a `NOTE:` in `scripts/lib/typecheck-programs.mjs` (carried from the sibling gate):
  `workspacePackageDirs` hard-codes `packages/*`. Fine now; if workspaces ever grow a second root,
  both gates go quiet rather than failing.
