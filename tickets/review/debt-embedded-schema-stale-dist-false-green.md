description: Editing a file in one package used to be able to pass another package's whole test suite without the tests ever running the edit, because they ran the last compiled copy instead — a stale-build check that one test package already had is now shared and wired into the package where the problem was caught.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-freshness.spec.ts, test-harness/package.json, packages/cadre-core/test/global-setup.ts, packages/cadre-core/vitest.config.ts, packages/cadre-core/tsconfig.typecheck.json, packages/integration-tests/test/global-setup.ts, packages/integration-tests/vitest.config.ts, packages/integration-tests/tsconfig.typecheck.json, packages/integration-tests/src/harness/index.ts, knip.ts, docs/STATUS.md
difficulty: medium
----

# What was built

The stale-build guard that `packages/integration-tests` already had was lifted to a
shared home and wired into `packages/cadre-core`, which is where the false green was
actually observed (a new control-database table absent from the database under test
while the whole suite passed).

Why it happened at all: a workspace or `link:` dependency resolves through a
`node_modules` symlink to the package directory, and the manifest there points at
`dist`. Nothing in a package's own `vitest run` rebuilds its dependencies, so editing
`packages/quereus-plugin-sereus/src/...` and then running `yarn workspace
@serfab/cadre-core test` exercised the *previous* build of that package. Green, and
meaningless.

## File moves

- `packages/integration-tests/src/harness/build-freshness.ts` -> `test-harness/build-freshness.ts`
- `packages/integration-tests/src/harness/build-freshness.spec.ts` -> `test-harness/build-freshness.spec.ts`
- `packages/integration-tests/src/global-setup.ts` -> `packages/integration-tests/test/global-setup.ts`

`test-harness/` is a repo-root sibling of `schemas/`, `docs/`, `ops/`. It is **not** a
yarn workspace (root `workspaces` is `packages/*`) and is **never built** — consumers
import it by relative path, the way the schema-drift specs reach `schemas/strand.qsql`.
That is the point: a compiled shared package would itself be consumed from its own
`dist`, so the guard against stale builds could be defeated by its own stale build.
Vitest transpiles the `.ts` directly.

## API change

`assertCadreBuildFresh()` (zero-arg, hardcoded 11-package list) became:

```ts
export function assertBuildFresh(targets: readonly BuildTarget[]): void
```

Everything else (`BuildTarget`, `StaleReason`, `LinkedPackage`, `checkBuildFreshness`,
`checkLinkedTarget`, `resolveLinkedPackage`) is unchanged in body and signature; only
doc comments moved/were rewritten. The hardcoded list moved verbatim into
`packages/integration-tests/test/global-setup.ts`, so that suite's coverage is
byte-identical to before. `cadre-core` got its own 6-entry list — the workspace and
`link:` entries of its `package.json` `dependencies`, with `distEntry` values copied
from the integration list rather than re-derived. `@serfab/cadre-core` itself is
deliberately **absent** from its own list: vitest transpiles that package's `src`
directly, so its `dist` is not what runs there.

## Three things the ticket did not anticipate

These are the parts most worth a reviewer's attention, because the plan asserted the
opposite in two of them.

1. **TS6059 fires under `noEmit`.** The plan said a `noEmit: true` tsconfig would not
   object to a program file outside `rootDir`. It does — `tsc` reported
   `File '.../test-harness/build-freshness.ts' is not under 'rootDir' ...` immediately.
   Fixed by widening `rootDir` to `"../.."` (the repo root) in
   `packages/cadre-core/tsconfig.typecheck.json` and
   `packages/integration-tests/tsconfig.typecheck.json`. Both are `noEmit`, so
   `rootDir` there only decides what is *allowed in*, not where output lands; the
   emitting configs (`tsconfig.build.json`) still inherit `include: ["src"]` and are
   untouched, so nothing outside `src/` reaches any package's published output.
   This is also why `integration-tests`' global setup **moved out of `src/`** into
   `test/`: left in `src/`, its cross-repo-root import broke that package's *build*
   config (rootDir `src`, and it emits), which no amount of `noEmit` reasoning fixes.
   Moving it also makes both packages' setups symmetrical (`test/global-setup.ts`).
2. **The root `package.json` has no `"type"` field,** so a bare `test-harness/*.ts`
   was resolved as CommonJS under `module: NodeNext` and its `import.meta.url` was a
   hard error. Fixed with a `test-harness/package.json` containing `"type": "module"`
   (plus `private` and a comment-bearing `description`). Adding `"type": "module"` to
   the *root* manifest was rejected as too wide a blast radius — `scripts/*.js` at root
   scope would change module format.
3. **`knip` turned red, not just noisy.** The plan guessed a root-level directory
   would be outside knip's package-scoped analysis. It is not: knip attributed
   `test-harness/build-freshness.spec.ts`'s `import ... from 'vitest'` to the *root*
   workspace, which does not list `vitest`, and `Unlisted dependencies` is an
   error-level rule — `yarn dep-check` exited 1. Fixed by adding `'test-harness/**'`
   to the root workspace `ignore` in `knip.ts`, alongside the existing
   `tess/ops/docs/scripts` entries.

## Where the relocated spec runs

`test-harness/build-freshness.spec.ts` is at the repo root, outside every package's
test globs, so it needed wiring. `packages/integration-tests/vitest.config.ts` gained
`'../../test-harness/**/*.spec.ts'` to its `include`. Verified two ways rather than
assumed: `vitest list --filesOnly` reports `../../test-harness/build-freshness.spec.ts`
among the collected files, and it executes (22/22). Note that `src/**/*.spec.ts` in
that config now matches **nothing** — that package's real tests are all
`*.integration.ts`, and this spec was the only `.spec.ts` it ever had. The pattern was
left in place rather than removed.

The spec stays typechecked: `packages/integration-tests/tsconfig.typecheck.json`
includes `"../../test-harness/**/*.ts"` and `"test/**/*.ts"`.

The `export * from './build-freshness.js'` line in
`packages/integration-tests/src/harness/index.ts` was **removed** — a repo-wide grep
confirmed `global-setup.ts` was its only importer, and it now reaches the module
directly. A comment records where the module went.

# Validation performed

All commands run from `C:\projects\sereus` unless noted.

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` | 68 files, 1054 passed / 1 skipped |
| `yarn workspace @serfab/quereus-plugin-sereus test` | 7 files, 68 passed / 1 todo |
| `yarn exec vitest run build-freshness` (in `packages/integration-tests`) | 1 file, 22 passed |
| `yarn exec vitest run schema-drift` (in `packages/quereus-plugin-sereus`) | 15 passed |
| `yarn exec vitest list --filesOnly` (in `packages/integration-tests`) | relocated spec present in collection |
| `yarn typecheck` (root, all workspaces) | clean |
| `yarn lint` (root) | clean |
| `yarn dep-check` (root) | exit 0 |

`control-schema-drift.spec.ts` lives in `packages/cadre-core/test/`, not in
`quereus-plugin-sereus` as the plan implied; it ran inside the cadre-core suite above.
Both drift specs are green and neither was touched.

## The originating bug, reproduced end-to-end

This is the acceptance test and it is the thing to re-run if you change anything here.

1. Touched `packages/quereus-plugin-sereus/src/strand-schema.ts`'s mtime (content
   unchanged — the guard is mtime-based) without rebuilding.
2. `yarn workspace @serfab/cadre-core test` -> **exit 1**, zero tests run:
   `@serfab/quereus-plugin-sereus: dist is stale — src was edited after the last build.
   Run: yarn workspace @serfab/quereus-plugin-sereus build`.
   Before this change the same scenario passed 1054 tests.
3. Renamed `packages/quereus-plugin-sereus/dist` aside (the fresh-clone / never-built
   case) -> **exit 1** with `not built (missing dist/index.js)` and the same remedy,
   not an ambiguous crash. Restored.
4. Rebuilt -> suite green again (68 files, 1054 passed).

# Known gaps — read before signing off

- **The full `integration-tests` suite was NOT run.** Only the filtered
  `vitest run build-freshness` invocation was, which does exercise the real config
  including the moved `globalSetup` (observed both passing and correctly throwing). The
  28 real-network `*.integration.ts` scenarios were skipped deliberately: sequential
  (`fileParallelism: false`) with a 60s per-test timeout, its wall clock is not
  agent-runnable inside the 10-minute idle budget. Nothing in this change touches
  scenario collection or scenario code, but the suite has not been observed green
  end-to-end since the move. **Worth one human/CI run.**
- **`assertBuildFresh` and `checkWorkspaceTarget` still have no unit tests** — this was
  already flagged as a gap by the earlier ticket and this change did not close it. Both
  are now covered only by the manual reproduction above. `assertBuildFresh` in
  particular changed shape in this ticket, so it is the least-tested new code here.
  A test would need to stub the repo-root discovery, which is why it was skipped
  before; that is a reason, not a justification.
- **Neither new/changed `TARGETS` list is verified against its package's actual
  `dependencies`.** Both are hand-maintained arrays. A dependency added to
  `cadre-core` tomorrow will not be guarded and nothing will say so — the same
  hand-maintained-list weakness the ticket criticised the path-alias alternative for,
  just narrowed to one list per package instead of one alias per import. A test that
  cross-checks each list against its `package.json` `dependencies` would close this;
  it is not written.
- **`cadre-core`'s list omits `@optimystic/db-p2p-storage-fs`** (present in the
  integration list) because it is not in `cadre-core`'s `dependencies`. If it is in
  fact reached transitively at runtime by these tests, the list is short by one.
  Not verified either way.
- **Sibling-repo churn makes the guard genuinely flaky here.** Mid-implementation,
  `../quereus/packages/quereus/src/planner/rules/join/rule-join-elimination.ts` was
  edited by concurrent work at 02:49 after a 02:47 build, so the guard failed a run for
  a reason unrelated to this ticket. That is the documented, deliberately-accepted
  behaviour (see `checkLinkedTarget`'s comment: a banner is ignorable and being ignored
  is how the original investigation went wrong), but a reviewer running these commands
  should expect it and rebuild `../quereus` rather than treat it as a defect here.
- **Not attempted, per the plan:** no change to the root `test` script (`-A`, not
  `-At`) and no `pretest`/build-ordering hooks. The guard covers single-package runs,
  which ordering would not.

# Review findings

- The guard's per-run cost is a recursive `readdirSync` + `statSync` walk of every
  target's `src` and `dist` — 6 packages for `cadre-core`, 11 for `integration-tests`,
  once per suite, unmeasurable against a 56s run. Parked as a `NOTE:` tripwire at the
  top of `checkBuildFreshness` in `test-harness/build-freshness.ts`: if the walk ever
  shows up in startup time, compare only `.tsbuildinfo` against the newest `src` entry
  instead of walking the whole output tree.
