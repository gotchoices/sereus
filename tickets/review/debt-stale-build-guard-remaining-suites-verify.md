description: Finished verifying and documenting a safety check that stops tests from silently running against old, unrebuilt code — now wired into three more parts of the codebase (the SQL plugin, the CLI, and the self-hosted manager) — and fixed one real type-check gap the verification pass surfaced.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-targets.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/quereus-plugin-sereus/test/build-targets.spec.ts, packages/quereus-plugin-sereus/vitest.config.ts, packages/quereus-plugin-sereus/tsconfig.json, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/test/build-targets.spec.ts, packages/cadre-cli/vitest.config.ts, packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-host/src/__tests__/global-setup.ts, packages/cadre-host/src/__tests__/build-targets.test.ts, packages/cadre-host/vitest.config.ts, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-host/tsconfig.build.json, docs/STATUS.md
difficulty: easy
----

## What this covers

`test-harness/build-freshness.ts`'s `assertBuildFresh` (already used by `cadre-core` and
`integration-tests`) is now also wired into `quereus-plugin-sereus`, `cadre-cli`, and
`cadre-host` — each via its own `test/global-setup.ts` (or, for `cadre-host`, whose specs
live under `src/**/__tests__` rather than a package-root `test/`,
`src/__tests__/global-setup.ts`) calling `assertBuildFresh(TARGETS)`, plus a companion
`build-targets.spec.ts`/`build-targets.test.ts` that calls `targetListProblems` to catch
the target list itself silently rotting as `package.json` gains dependencies.
`cadre-provider` was deliberately left unwired — zero `workspace:`/`link:` dependencies of
its own, nothing for the guard to check.

This ticket is the verification pass for that wiring (a prior run landed the six new files
and config edits, already committed at `67707f7`, then got cut short by a budget warning
before finishing verification). Everything below was done in this pass.

## Verification performed

- **`yarn workspace @serfab/cadre-cli test`** — 14 test files, 164 tests, all passing.
- **`yarn workspace @serfab/cadre-host exec vitest list --filesOnly`** — confirmed
  `src/__tests__/build-targets.test.ts` is actually collected (listed first), then
  **`yarn workspace @serfab/cadre-host test`** — 59 test files, 511 tests passing + 4
  skipped (pre-existing skips, unrelated to this change).
- **Mutation-tested all three new `*-targets` specs**: for each of
  `quereus-plugin-sereus/test/build-targets.spec.ts`, `cadre-cli/test/build-targets.spec.ts`,
  and `cadre-host/src/__tests__/build-targets.test.ts`, temporarily deleted one real entry
  from that suite's `TARGETS` array, reran just that spec file, confirmed it failed with
  `"<pkg> is a <linked|workspace> dependency but is missing from the target list"`, then
  restored the entry. `git diff` on all three `global-setup.ts` files is empty after
  restore — confirmed clean.
- **Mutation-tested `assertBuildFresh`'s "missing dist" path**: renamed
  `../optimystic/packages/db-core/dist/src/index.js` out of the way (this repo's sandbox
  would not permit renaming the whole sibling `dist/` directory — permission denied on a
  directory `mv` even with the sandbox override, though creating/deleting files inside it
  and renaming a single file both worked fine; renaming the entry file alone is sufficient
  to exercise this path) and ran `yarn workspace @serfab/quereus-plugin-sereus test`.
  Failed fast with `"@optimystic/db-core: not built (missing dist/src/index.js). Run in
  ...\optimystic: yarn workspace @optimystic/db-core build"` — before any test file ran.
  Restored the file (renamed back, same mtime) and reran — 8 test files, 77 tests, 1 todo,
  matching the pre-mutation baseline.
- **`yarn typecheck` (root, fans out to every workspace)** — caught a real gap: pulling
  `test-harness/build-targets.ts` into `quereus-plugin-sereus`'s typecheck program (via its
  new `test/build-targets.spec.ts` importing it, combined with the `rootDir: "../.."`
  already set in `tsconfig.typecheck.json`) surfaced `TS2554: Expected 0-1 arguments, but
  got 2` at `build-targets.ts`'s `new Error(message, { cause })` call.
  `quereus-plugin-sereus/tsconfig.json` was the one package among the four
  (`cadre-core`/`cadre-cli`/`cadre-host` already had it) still missing the
  `"lib": ["ES2022", "DOM", "DOM.Iterable"]` bump that overload needs — added it, matching
  the existing pattern and comment style byte-for-byte in spirit. `yarn typecheck` now
  passes clean across all workspaces; re-ran `yarn workspace @serfab/quereus-plugin-sereus
  build` afterward to confirm the `lib` bump (a superset, so shouldn't have) didn't change
  build output — it built clean, same as before.
- **`yarn lint` (root)** — exit 0, no output (eslint prints nothing on a clean run).
- **`docs/STATUS.md`** — added a bullet under the stale-build-guard section (after "Target
  lists pinned against their manifests", before "Sequential integration runs restored")
  covering all three new suites, the `cadre-provider` exclusion and why, the `unit`+`e2e`
  double-wiring `quereus-plugin-sereus` needed (Vitest 4.1.8 does not run a
  project-array-sibling's `globalSetup` unless each project block sets it itself — verified
  by mutation-testing both `--project unit` and `--project e2e` separately in the prior
  pass), the `tsconfig.build.json` exclude `cadre-host` needed for its `src`-nested test
  setup file, and the `tsconfig.json` `lib` fix this pass made.

## Use cases for testing / validation

- **Golden path**: `yarn workspace @serfab/<pkg> test` for each of the three packages
  should pass when every workspace and linked sibling is freshly built.
- **Stale workspace package**: touch (edit, don't just `touch(1)`) a `src` file in
  `@serfab/cadre-core` without rebuilding, then run `yarn workspace @serfab/cadre-cli test`
  or `@serfab/cadre-host test` — should fail fast naming `cadre-core` and the
  `yarn workspace @serfab/cadre-core build` remedy, before any test executes.
  (`quereus-plugin-sereus` has no workspace target to exercise this way — it's linked-only.)
  See the important caveat below about mtime vs. content.
- **Stale linked sibling**: edit `../quereus/packages/quereus/src/index.ts` (or any file
  under its `src`) without rebuilding, run any of the three packages' `test` script —
  should fail naming `@quereus/quereus` and `yarn workspace @quereus/quereus build`, to be
  run in the sibling checkout.
- **Missing dist**: delete/rename a linked or workspace target's compiled entry point —
  should fail with "not built (missing ...)" rather than crashing some other way.
- **Target-list drift**: add a new `workspace:`/`link:` dependency to one of these three
  packages' `package.json` without adding it to that package's `global-setup.ts` `TARGETS`
  — `yarn workspace <pkg> test` should fail via `build-targets.spec.ts`/`.test.ts`, not
  silently keep passing.
- **`cadre-host` file collection**: if `src/__tests__/build-targets.test.ts` (or any new
  test file placed oddly) is ever silently dropped from collection, `yarn workspace
  @serfab/cadre-host exec vitest list --filesOnly` should be the first thing checked — a
  guard that's never collected is worse than no guard.

## Known gaps / things the reviewer should double-check

- **mtime, not content hash**: `checkBuildFreshness` compares mtimes, not content. During
  this pass, `../quereus/packages/quereus/src/index.ts` had a newer mtime than `dist` with
  **zero actual content diff** (confirmed via `git diff` in that sibling repo — file was
  clean), which still tripped the guard as stale. This is pre-existing, documented behavior
  of `build-freshness.ts` (not something this ticket changed or should fix), but it means
  the guard can false-positive on a mtime-only touch (e.g. a `git checkout` in the sibling,
  a tool that touches without editing). Rebuilding is the correct response either way; flag
  this to a reviewer only so a false-positive during their own re-verification isn't
  mistaken for a defect in the three new files.
- **tsc incremental can no-op silently**: relatedly, if a sibling's `src` content is
  unchanged, `tsc --incremental` may not even rewrite `dist/tsconfig.tsbuildinfo`'s mtime,
  so a plain rebuild doesn't clear a mtime-only false-positive — deleting the
  `.tsbuildinfo` file(s) first forces a real rewrite. Encountered and worked around this
  pass; not a defect, just a rough edge in the sibling repos' own build setup, worth knowing
  if a reviewer re-runs the mutation tests and a rebuild doesn't seem to "take."
  Environmental, outside this ticket's scope.
- **Directory rename blocked in this sandbox**: this agent's environment refused
  `mv <dir>` on a sibling-repo directory (`Permission denied`) even with the sandbox
  override, while file-level renames inside that same directory worked fine. Worked around
  by renaming just the entry file rather than the whole `dist/` tree. If a reviewer's
  environment behaves differently, either approach validates the same `StaleReason:
  'missing'` code path (`test-harness/build-freshness.ts:230-241`).
- No new tripwires were identified this pass — the guard's known edge cases (mtime vs.
  content, registry-copy skip, hoisting-limited packages) are all already documented in
  `test-harness/build-freshness.ts`'s own comments or `docs/STATUS.md`'s existing bullets.

## Not re-litigated

Per the prior implement pass's notes (now superseded by this file): target-list contents
(which packages, which `distEntry`, `workspace` vs `linked`) were resolved during planning
and are final, reviewed-in-spirit content — don't relitigate which packages appear in each
`TARGETS` array. `quereus-plugin-sereus` pins two `linked` names (no `workspace:` deps of
its own) and `cadre-host` pins two `workspace` names for the `distBackedDependencies` smoke
assertion (no direct `link:` deps of its own — reached transitively through `cadre-core`);
both deviations are intentional, matching what each package's own `package.json` actually
declares.
