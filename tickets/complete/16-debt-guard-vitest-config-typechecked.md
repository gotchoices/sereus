description: Added an automated check that fails the build if any package's test-runner config file stops being type-checked, so the repo can never again silently drift back into a config setting going unvalidated.
files: scripts/check-vitest-typecheck-coverage.mjs, scripts/check-vitest-typecheck-coverage.test.mjs, package.json, docs/STATUS.md
---

# Guard the "vitest.config.ts is type-checked" invariant

## What shipped

- `scripts/check-vitest-typecheck-coverage.mjs` — for every `packages/*` dir holding a
  `vitest.config.{ts,mts,cts}`, reads that package's `package.json` `scripts.typecheck`, extracts
  every `-p` / `--project <config>` arg (falls back to `./tsconfig.json` if none), and asks the
  TypeScript compiler API (`ts.getParsedCommandLineOfConfigFile`) for the actual resolved file list
  of that tsconfig — following `extends` and expanding `include`/`exclude` the same way `tsc` would.
  Fails, naming the package, the config file, and the tsconfig(s) checked, if the vitest config
  isn't in that resolved set. Packages with no vitest config (currently just `reference-app-ns`)
  are silently skipped — the correct passing state for them.
- `scripts/check-vitest-typecheck-coverage.test.mjs` — `node --test`, 16 fixture-based cases using
  throwaway `mkdtempSync` workspaces via `VITEST_TYPECHECK_COVERAGE_CHECK_ROOT` (same pattern as
  `check-dep-ranges.test.mjs`'s `DEP_RANGE_CHECK_ROOT`). Includes cases that remove the config from
  a synthetic project's `include`, repoint `typecheck` at a build config, and rename the config to
  `.mts` — each asserts the checker catches it, so the suite proves the guard detects real drift,
  not just that it passes today.
- `package.json`: `check:vitest-typecheck-coverage` chained into root `typecheck`; the fixture
  suite chained into root `test` as `test:vitest-typecheck-coverage`.
- `docs/STATUS.md` → "Type-check coverage": describes the guard and what the fixture suite proves,
  replacing the earlier note that nothing enforced this.

Archaeology note: the code landed in commit `3bb3969` (labelled `ticket(plan):`) — the plan-stage
agent implemented ahead of its stage. `cdaf0c4` (`ticket(implement):`) only moves the ticket file.
`git show 3bb3969` is the implementation diff.

## Review findings

**Checked:** the full implementation diff (`3bb3969`) read before the handoff summary; the checker's
logic end-to-end against real package `typecheck` scripts (all ten packages listed and compared);
fixture-suite coverage vs. happy path / edge / error / regression / interaction; `package.json` gate
wiring in both the `typecheck` and `test` chains; `docs/STATUS.md` "Type-check coverage" prose vs.
the shipped behaviour; whether any other doc documents the sibling `check-dep-ranges` guard and
therefore should mention this one (only `docs/STATUS.md` does, and it does).

**Minor — fixed in this pass:**

- *Guard could be bypassed by renaming the config.* It looked for the literal filename
  `vitest.config.ts` only. Vitest equally accepts `vitest.config.mts` / `.cts`, so renaming the
  file made the package skip the gate **silently** — precisely the failure mode the guard exists to
  prevent. Now scans all three names, checks each one found, and names the offending file in the
  failure message. Two fixtures added (`.mts` uncovered → caught, `.mts` covered → passes).
- *Long-form `--project` was not recognised.* The extraction regex matched only `-p <config>`, so
  `tsc --project tsconfig.build.json` fell through to the `./tsconfig.json` default. Not merely
  imprecise: `reference-app-web`'s `tsconfig.json` **does** include its vitest config, so switching
  that package to `--project <some-other-config>` would have produced a false pass. Regex now
  matches `-p` and `--project`, space- or `=`-separated, anchored at a word boundary so `--pretty`
  can't match. One fixture added asserting the named config is the one actually checked.
- *Gaps the implementer flagged as untested are now tested.* Multiple `-p` flags in one script had
  its "covered by any one tsconfig" behaviour read from the code but never exercised — two fixtures
  added (covered by one of two → passes; covered by neither → fails). Also added a fixture for a
  package with **no** `typecheck` script at all (previously only the non-`tsc` script case existed).
  Suite went 10 → 16 cases, all green.

**Major — none.** No new tickets filed. The checker's structure (small named functions, TypeScript
API instead of hand-rolled `include` matching, fixture workspaces instead of asserting against this
repo's own packages) holds up; nothing found warranted a follow-up ticket.

**Tripwires — recorded, not ticketed:**

- Package discovery hardcodes `packages/*` and would silently miss a second workspace root. Parked
  as a `NOTE:` comment on `workspacePackageDirs` in the checker; matches the root `package.json`
  `workspaces` field today.
- The "is this a `tsc` script?" test is `script.includes('tsc')`, and project-flag extraction is
  flag scraping rather than shell parsing. Correct for all ten packages today; a wrapper script
  (`node tools/typecheck.mjs`) would pass the sniff and then fall back to the wrong tsconfig. Parked
  as a `NOTE:` comment above `PROJECT_FLAG`. Deliberately not "fixed" — a real shell parser here is
  the kind of half-baked parsing the repo's guidelines rule out.
- Windows path normalisation relies on `resolve()` before set comparison rather than a dedicated
  mixed-separator fixture. Left as-is: the real-repo run and all 16 fixtures pass on Windows, and a
  synthetic separator test would assert Node's `path` behaviour, not this script's.

**Docs:** `docs/STATUS.md` "Type-check coverage" was accurate for the original implementation but
was rewritten to match the widened behaviour (`.mts`/`.cts`, `--project`, 16 fixtures) and trimmed;
it had also grown a long fixture inventory that now reads as one sentence. No other doc references
the guard or needed to.

## Verification performed (this session)

| command | result |
| --- | --- |
| `node scripts/check-vitest-typecheck-coverage.mjs` | exit 0, all 10 workspaces covered |
| `node --test scripts/check-vitest-typecheck-coverage.test.mjs` | 16/16 pass (was 10) |
| `node --test scripts/check-dep-ranges.test.mjs` | 9/9 pass, unaffected |
| `yarn typecheck` | green, ~19s, new gate runs and passes at end of chain |
| `yarn lint` | 0 errors |
| `yarn dep-check` | exit 0; knip output unchanged (new scripts not flagged) |
| `yarn workspaces foreach -A run test` | 3 pre-existing integration failures, see below; everything else green |

## Pre-existing failures encountered (not this ticket's)

The whole-workspace test run surfaced three `integration-tests` scenario failures, all already
listed in `tickets/.pre-existing-known.md` against blocked slugs, so they were **not** re-triaged
and no `.pre-existing-error.md` was written:

- `control-cohort-three-node-isolation.integration.ts` and
  `control-write-degraded-cohort-member.integration.ts` → `transactor-key-network-ignores-network-scoping` (blocked)
- `zz-scratch-delete-alone.integration.ts` (`SyncRetryExhaustedError` out of `@optimystic/db-core`)
  → `forked-control-collection-sync-livelocks` (blocked)

All three fail inside `../optimystic` code and none touch anything in this diff (repo-root scripts
and docs only).

Note on runtime: the full workspace test run takes ~11.5 minutes wall-clock, dominated by the
sequential `integration-tests` suite (~523s). `--exclude '@serfab/integration-tests'` did not take
effect on this Yarn version, so the run cannot be trimmed that way from an agent session.
