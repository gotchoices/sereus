description: Finish verifying and documenting a safety check that was just wired into three more parts of the codebase — the check stops tests from silently running old, unrebuilt code, and now needs its test runs, its self-checks, and the project docs confirmed.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-targets.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/quereus-plugin-sereus/test/build-targets.spec.ts, packages/quereus-plugin-sereus/vitest.config.ts, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/test/build-targets.spec.ts, packages/cadre-cli/vitest.config.ts, packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-host/src/__tests__/global-setup.ts, packages/cadre-host/src/__tests__/build-targets.test.ts, packages/cadre-host/vitest.config.ts, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-host/tsconfig.build.json, docs/STATUS.md
difficulty: easy
----

<!-- resume-note -->
This is a continuation of `debt-stale-build-guard-remaining-suites` (deleted; this
ticket replaces it), cut short by a mid-run budget warning. No log file exists —
this note is the full account of what a prior agent run already did and what is
still open.

# What's already done (all landed in the working tree, not committed)

The stale-build guard (`test-harness/build-freshness.ts`'s `assertBuildFresh`,
already used by `cadre-core` and `integration-tests`) is now wired into three
more suites, each following the exact `test/global-setup.ts` + companion
`*-targets.spec.ts`/`*.test.ts` pattern those two already use:

- **`packages/quereus-plugin-sereus`**: `test/global-setup.ts` (new) +
  `test/build-targets.spec.ts` (new), both linked-only `TARGETS` (this package
  has no `@serfab/*` dependency of its own). Wired into **both** `unit` and
  `e2e` project blocks in `vitest.config.ts` (it uses `test.projects`, not a
  flat `test` block). `tsconfig.typecheck.json`'s `rootDir` changed from `"."`
  to `"../.."` — required because the new file imports
  `../../../test-harness/build-freshness.js`, which sits above the old
  `rootDir` (TS6059); same fix pattern `cadre-core`'s own `tsconfig.typecheck.json`
  already carries, with the same comment copied over explaining why.
- **`packages/cadre-cli`**: `test/global-setup.ts` (new) +
  `test/build-targets.spec.ts` (new), `TARGETS` is `cadre-core`'s own list plus
  `@serfab/cadre-core` itself (this package's specs import real `cadre-core`
  symbols, and its `src/commands/*` load `cadre-core`'s compiled entry point at
  module-evaluation time regardless). Wired into `vitest.config.ts`'s single
  `test` block. Same `tsconfig.typecheck.json` `rootDir` fix as above.
- **`packages/cadre-host`**: `src/__tests__/global-setup.ts` (new) +
  `src/__tests__/build-targets.test.ts` (new) — no package-root `test/` dir
  here, specs live under `src/**/__tests__`, so the guard files sit beside them
  per the original ticket's explicit instruction. `TARGETS` covers
  `@serfab/cadre-cli`, `@serfab/cadre-core`, `@serfab/cadre-provider`,
  `@serfab/quereus-plugin-sereus`, and the same five `@optimystic`/`@quereus`
  linked siblings. Wired into `vitest.config.ts`'s single `test` block. Same
  `tsconfig.typecheck.json` `rootDir` fix. **Additionally** had to add
  `"src/__tests__/global-setup.ts"` to `tsconfig.build.json`'s `exclude` array —
  unlike the other two packages, this one's test setup file lives *under* `src`
  (which the build config's base `include: ["src"]` already covers), so without
  an explicit exclude `tsc build` would have compiled it straight into `dist`
  alongside production code. The existing `"**/*.test.ts"` exclude entry does
  not catch it, since `global-setup.ts` doesn't match that glob.

`cadre-provider` was confirmed (during the planning stage, re-confirmed by
inspecting its `package.json` again in this implement pass) to need **no**
changes: zero `workspace:`/`link:` dependencies, nothing for the guard to check.
Do not wire it in.

## Verification already done

- `yarn workspace @serfab/cadre-core test` — baseline sanity check, run twice.
  First run failed on an unrelated stale sibling build
  (`../quereus/packages/quereus` src had been edited more recently than its
  `dist` by whatever was last happening in that sibling checkout) — fixed by
  `(cd ../quereus && yarn workspace @quereus/quereus build)`. Second run hit
  `Failed to resolve entry for package "@quereus/quereus"` from a stale Vite
  dep-optimizer cache left over from before that rebuild — fixed by deleting
  `packages/cadre-core/node_modules/.vite`, `packages/cadre-core/node_modules/.vite-temp`,
  and root `node_modules/.vite`. Third run: **83 test files / 1315 passed, 1
  skipped.** Neither issue was caused by this ticket's changes; both are
  pre-existing environmental drift from the actively-developed sibling repo
  (see `tickets/.pre-existing-known.md`'s existing entry on exactly this
  pattern — do not re-report it). Keep this in mind for the remaining runs
  below: if a linked-sibling suite fails with a resolution error rather than
  the guard's own "Stale build detected" message, clear that package's
  `node_modules/.vite` (and the root one) before concluding anything is broken.
- `yarn workspace @serfab/quereus-plugin-sereus test` — **8 test files passed,
  77 tests passed, 1 todo.** Confirms the guard runs under the default `vitest
  run` invocation, which covers both `unit` and `e2e` projects.
- **Mutation test performed and reverted**: touched
  `../quereus/packages/quereus/src/index.ts`'s mtime (content unchanged), then
  ran `yarn workspace @serfab/quereus-plugin-sereus exec vitest run --project
  unit` and `--project e2e` **separately**. **Both failed** with `Stale build
  detected... @quereus/quereus: dist is stale ... Run in C:\projects\quereus:
  yarn workspace @quereus/quereus build` — proving `globalSetup` set on both
  project blocks actually runs for both (the ticket's flagged open question:
  Vitest 4.1.8 does NOT reliably inherit a project-array-sibling `globalSetup`
  without setting it on each project, or at least it wasn't proven to — setting
  it on both, as done, is confirmed correct and required). Afterward ran
  `(cd ../quereus && yarn workspace @quereus/quereus build)` again to restore
  the sibling to a fresh, non-stale state — confirmed exit 0.

# What's still open

1. **Run `yarn workspace @serfab/cadre-cli test`.** Never run yet in this pass.
   Expect it to pass if `@serfab/cadre-core`'s dist and the linked siblings are
   fresh (they should be, given the cadre-core run above) — but confirm, and
   apply the same Vite-cache-clear fix if a resolution error (not a "Stale
   build detected" error) shows up instead of a pass.
2. **Run `yarn workspace @serfab/cadre-host test`.** Never run yet. Before
   trusting a pass or fail, first run
   `yarn workspace @serfab/cadre-host exec vitest list --filesOnly` and confirm
   `src/__tests__/build-targets.test.ts` actually appears in the list — the
   original ticket flagged this as a real risk: `cadre-host`'s `vitest.config.ts`
   `include` globs (`src/**/__tests__/**/*.test.ts`, `ui/__tests__/**/*.test.ts`)
   are easy to silently miss a new file under if the glob or suffix is off, and
   a guard that's silently never collected is worse than no guard (false
   confidence). If it's missing from that list, fix the `include`/file
   placement before moving on — do not just accept a green run without having
   seen the file named in `vitest list`.
3. **Mutation-test each of the three new `*-targets` specs** (the way the
   `cadre-core` ticket originally did): for each of
   `packages/quereus-plugin-sereus/test/build-targets.spec.ts`,
   `packages/cadre-cli/test/build-targets.spec.ts`, and
   `packages/cadre-host/src/__tests__/build-targets.test.ts` — temporarily
   delete one real entry from that suite's `global-setup.ts`'s `TARGETS` array,
   rerun that one spec file, confirm it fails with the expected `"... is a
   workspace/linked dependency but is missing from the target list"` message
   (from `targetListProblems` in `test-harness/build-targets.ts`), then restore
   the deleted entry. Not yet done for any of the three — passing on the first
   try with no proof it can fail is not sufficient coverage, and this was an
   explicit requirement in the original ticket.
4. **Mutation-test `assertBuildFresh`'s "missing dist" path** for at least one
   of the three new suites — `rm -rf` (or rename) one **linked** target's
   `dist` directory entirely (not just touch its `src` mtime — that path,
   "stale", was already proven above for `quereus-plugin-sereus`; "missing" is
   a distinct `StaleReason` in `test-harness/build-freshness.ts` and hasn't been
   exercised this pass) and confirm `yarn workspace <name> test` fails fast
   naming that package and a build remedy, rather than crashing some other way
   or silently passing. Restore the `dist` directory afterward (rebuild the
   sibling, don't just recreate an empty folder).
5. **`yarn typecheck` at the repo root.** Not run this pass. The
   `tsconfig.typecheck.json` `rootDir` changes for all three packages (and the
   `tsconfig.build.json` exclude for `cadre-host`) were made to fix TS6059
   errors that a Read-triggered LSP diagnostic surfaced live during editing (see
   the two `<new-diagnostics>` system reminders earlier in this session, both
   now resolved by the `rootDir` edits) — but the full root-level `yarn
   typecheck` (which runs every workspace, not just these three) has not been
   run to confirm nothing else regressed.
6. **`yarn lint` at the repo root.** Not run this pass. Six new files were
   written by hand, matching each target package's existing indent convention
   (tabs for `quereus-plugin-sereus`, matching its existing test files;
   2-space for `cadre-cli` and `cadre-host`, ditto) — this was checked by
   inspection against sibling files in the same directories, not by running
   the linter.
7. **Update `docs/STATUS.md`'s stale-build-guard section** with a short entry
   for these three newly-wired suites, following that section's existing entry
   style (see how the original two, `cadre-core` and `integration-tests`, are
   described there already), and note that `cadre-provider` was evaluated
   during planning and correctly excluded (zero `workspace:`/`link:`
   dependencies — nothing for the guard to check). Not done yet — the ticket
   explicitly asked for this and it was never reached this pass.

# Notes for whoever picks this up

- Do not re-litigate the target-list contents (which packages, which
  `distEntry`, `workspace` vs `linked`) — those were resolved during planning
  and are recorded in git history's now-deleted
  `debt-stale-build-guard-remaining-suites` ticket body if you need the
  reasoning again; what's written into the six new files above is final,
  reviewed-in-spirit content, not a draft.
- Two of the three new `*-targets` specs deviate slightly from the "pin one
  workspace and one linked name" instruction the original ticket gave, because
  it doesn't literally apply to every package: `quereus-plugin-sereus` has zero
  direct `workspace:` dependencies of its own (pins two `linked` names
  instead), and `cadre-host` has zero direct `link:` dependencies of its own —
  its `@optimystic`/`@quereus` entries are all reached transitively through
  `cadre-core` (pins two `workspace` names instead). This is intentional and
  matches what `distBackedDependencies` can actually find by scanning each
  package's own `package.json`; don't "fix" it into an entry that doesn't
  exist.
- The sibling-repo build/cache issues encountered above
  (`../quereus/packages/quereus` staleness, Vite dep-optimizer cache) are
  environmental, not defects in this ticket's changes — don't chase them as
  bugs, just repeat the same fix (rebuild the sibling; clear
  `node_modules/.vite`) if they resurface during the remaining verification.

## Tasks

- Run `yarn workspace @serfab/cadre-cli test`; fix and re-run if it fails for
  an environmental reason (stale sibling, Vite cache) rather than a real
  defect.
- Run `yarn workspace @serfab/cadre-host exec vitest list --filesOnly` and
  confirm `build-targets.test.ts` is collected; then run
  `yarn workspace @serfab/cadre-host test`.
- Mutation-test all three new `*-targets` specs (delete one `TARGETS` entry,
  confirm the expected failure message, restore).
- Mutation-test `assertBuildFresh`'s "missing dist" path for at least one
  suite (`rm -rf` a linked target's `dist`, confirm the failure, restore by
  rebuilding).
- `yarn typecheck` and `yarn lint` at the root; fix anything these three
  packages' new files trip.
- Update `docs/STATUS.md`'s stale-build-guard section per the notes above.
