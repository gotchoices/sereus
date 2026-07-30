description: Editing a file in one package used to be able to pass another package's whole test suite without the tests ever running the edit, because they ran the last compiled copy instead — a stale-build check that one test package already had is now shared, wired into the package where the problem was caught, and pinned so its dependency list cannot silently rot.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-freshness.spec.ts, test-harness/build-targets.ts, test-harness/package.json, packages/cadre-core/test/global-setup.ts, packages/cadre-core/test/build-targets.spec.ts, packages/cadre-core/vitest.config.ts, packages/cadre-core/tsconfig.typecheck.json, packages/integration-tests/test/global-setup.ts, packages/integration-tests/test/build-targets.spec.ts, packages/integration-tests/vitest.config.ts, packages/integration-tests/tsconfig.typecheck.json, packages/integration-tests/src/harness/index.ts, eslint.config.mjs, knip.ts, docs/STATUS.md, AGENTS.md
difficulty: medium
----

# What shipped

The stale-build guard that `packages/integration-tests` already had was lifted to a
shared, never-built home at `test-harness/` (a repo-root sibling of `schemas/` and
`docs/`, deliberately not a yarn workspace) and wired into `packages/cadre-core`,
where the false green was originally observed — a new control-database table absent
from the database under test while the whole suite passed.

Cause: a workspace or `link:` dependency resolves through a `node_modules` symlink
whose manifest points at `dist`. Nothing in a package's own `vitest run` rebuilds its
dependencies, so editing one and running a dependent package's tests exercises the
*previous* build.

- `assertCadreBuildFresh()` (zero-arg, hardcoded 11-package list) became
  `assertBuildFresh(targets)`; each consuming package owns its list in its own
  vitest `globalSetup`.
- `integration-tests`' list is byte-identical to the old hardcoded one;
  `cadre-core` got its own 6-entry list (its `workspace:`/`link:` dependencies).
- `test-harness/` is marked ESM by its own `package.json` (root manifest has no
  `"type"`) and ignored by knip's root workspace.
- Both suites' `tsconfig.typecheck.json` widened `rootDir` to the repo root — TS6059
  fires even under `noEmit`. The emitting configs are untouched, so nothing outside
  `src/` reaches any package's published output.

The originating bug was reproduced end-to-end during implement: touching
`packages/quereus-plugin-sereus/src/strand-schema.ts` without rebuilding made
`yarn workspace @serfab/cadre-core test` exit 1 with zero tests run, naming the
package and its build command; before the change the same scenario passed 1054 tests.
Removing `dist` entirely gave `not built (missing dist/index.js)` rather than an
ambiguous crash.

# Review findings

## Fixed in this pass (minor)

- **Two doc comments were stale in the commit that moved the files.**
  `test-harness/build-freshness.ts`'s module comment still listed
  `packages/integration-tests/src/global-setup.ts` as a consumer, and
  `packages/integration-tests/src/harness/index.ts` said `src/global-setup.ts` was the
  only importer. Both are `test/global-setup.ts` now. Corrected.

- **`assertBuildFresh` had no unit tests** — flagged as a known gap by the handoff,
  and the function whose shape changed in this ticket. Four cases added to
  `test-harness/build-freshness.spec.ts`, needing no stubbing of repo-root discovery
  (which is why the gap had stayed open): empty list passes; a workspace target naming
  no package under `packages/` throws with the `yarn install` remedy; an uninstalled
  linked target likewise; and multiple problems are reported in a *single* throw, one
  per line — a run aborted on the first stale package would send someone back for a
  second build.

- **Neither target list was verified against its package's manifest** — the handoff's
  largest self-declared hole: hand-maintained arrays that go unguarded in silence when
  a dependency is added. Closed. `test-harness/build-targets.ts` derives what a package
  actually runs from a rebuildable `dist` (a `workspace:` range, or a name the root
  `resolutions` redirects with `link:`) and reports anything a list misses or files
  under the wrong `location`. Each package asserts on it from its **own** suite
  (`packages/cadre-core/test/build-targets.spec.ts`,
  `packages/integration-tests/test/build-targets.spec.ts`) so drift fails that
  package's own `yarn test`, not only the rarely-run integration one. Coverage is
  checked rather than equality — `integration-tests` legitimately guards three
  packages it reaches transitively.
  Mutation-tested rather than assumed: deleting `@quereus/quereus` from `cadre-core`'s
  list fails the new spec with `@quereus/quereus is a linked dependency but is missing
  from the target list`; restored, green. Each spec also pins that the manifest scan
  found something, so an empty result can't pass the check vacuously.

- **`packages/integration-tests/vitest.config.ts` had a dead glob.** `src/**/*.spec.ts`
  matched nothing after the move (that package's real tests are all `*.integration.ts`).
  Replaced with `test/**/*.spec.ts`, which is where the suite's own unit specs now live.
  Collection verified with `vitest list --filesOnly`: 28 scenarios plus both spec files.

- **`AGENTS.md`'s repo orientation did not list `test-harness/`** — a new root-level
  directory. Added. `docs/STATUS.md` gained the drift-check bullet.

## Resolved, not carried forward

- **`cadre-core`'s list omits `@optimystic/db-p2p-storage-fs`** — the handoff left this
  "not verified either way". Verified: that package is absent from the root
  `resolutions`, and `node_modules/@optimystic/db-p2p-storage-fs` is a real directory,
  not a symlink. `checkLinkedTarget` skips registry copies unconditionally, so the
  entry is inert wherever it appears. `integration-tests` keeps it (harmless, and it
  would start being checked if it were ever linked); `cadre-core` correctly omits it.

## Filed as a new ticket (major)

- `backlog/debt-stale-build-guard-remaining-suites` — `quereus-plugin-sereus`,
  `cadre-cli`, `cadre-host` and `cadre-provider` all consume linked sibling output and
  have no guard. `quereus-plugin-sereus` matters most: its schema-drift tests compare
  this repo's schema against Quereus's real behaviour, which is exactly what a stale
  `@quereus/quereus` build invalidates silently. Out of scope here (this ticket was
  scoped to `cadre-core`), and it is wiring rather than design now that the mechanism
  is shared.

## Tripwires (recorded, deliberately not ticketed)

- **Type-aware lint no longer reaches the guard.** `eslint.config.mjs` scopes the
  type-aware pass (`no-floating-promises`) to `packages/*/src/**`; the module was in
  that scope at its old path and is not at its new one, and neither are the packages'
  `test/` trees. Nothing in either is async, so the one rule has nothing to bite on.
  Parked as a `NOTE:` beside the type-aware `files` list in `eslint.config.mjs`, with
  the remedy (give `test-harness/` its own `tsconfig.json`, add both globs) — the
  project service can't resolve those files today because no `tsconfig.json` includes
  them.
- **Per-run walk cost** — carried over from the implement pass, already parked as a
  `NOTE:` at `checkBuildFreshness`.

## Checked, nothing found

- **Repo-root discovery from the new location.** `findWorkspaceRoot` walks up from
  `test-harness/`; the new `test-harness/package.json` declares no `workspaces` key, so
  it is skipped and the repo root still resolves. Exercised by every run above.
- **Dangling references to the moved module.** Repo-wide grep for
  `build-freshness` / `assertCadreBuildFresh`: no stale importers, no stale paths left
  after the two comment fixes.
- **Emit boundaries.** The widened `rootDir` is confined to the two `noEmit` typecheck
  configs; `tsconfig.build.json` in both packages still includes only `src`, so no test
  file can reach published output.
- **Error handling / resource cleanup / type safety.** The guard is entirely synchronous
  `node:fs`, holds no handles, and every `try` around a filesystem call returns a typed
  sentinel the caller acts on rather than swallowing. Spec fixtures clean up in
  `afterEach`. No `any`. Nothing to report.

# Validation

All green, from `C:\projects\sereus`:

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` | 69 files, 1057 passed / 1 skipped |
| `yarn exec vitest run build-freshness build-targets` (in `integration-tests`) | 2 files, 28 passed |
| `yarn exec vitest run build-targets` (in `cadre-core`) | 3 passed |
| `yarn exec vitest list --filesOnly` (in `integration-tests`) | 28 scenarios + 2 specs collected |
| `yarn typecheck` (root, all workspaces) | clean |
| `yarn lint` (root) | clean |
| `yarn dep-check` (root) | exit 0 |

# Still open for a human or CI

- **The full `integration-tests` suite has not been run end-to-end since the move.**
  Its 28 real-network scenarios are sequential with a 60s per-test timeout — wall clock
  exceeds the agent idle budget, so both the implement and review passes ran only the
  filtered unit specs (which do exercise the real config, including the moved
  `globalSetup`, observed both passing and correctly throwing). Nothing in either pass
  touches scenario collection or scenario code, and collection was verified explicitly.
  Worth one CI run.
- **Sibling-repo churn makes the guard genuinely noisy here.** Concurrent work in
  `../quereus` editing a file after its last build will abort these suites. That is the
  documented, deliberately-accepted behaviour (a banner that lets the suite continue is
  ignorable, and being ignored is how the original investigation went wrong) — rebuild
  the sibling rather than treating it as a defect.
