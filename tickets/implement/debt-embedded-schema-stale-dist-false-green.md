description: Editing a database-schema file that is duplicated inside the compiled code can currently pass the whole test suite even though the tests never actually run the edit — this closes that gap for the specific case where it was caught (the `cadre-core` package testing a schema owned by `quereus-plugin-sereus`), by reusing an existing stale-build check that a different test package already has.
prereq:
files: packages/integration-tests/src/harness/build-freshness.ts, packages/integration-tests/src/harness/build-freshness.spec.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/global-setup.ts, packages/cadre-core/vitest.config.ts, packages/cadre-core/tsconfig.typecheck.json, packages/cadre-core/package.json, schemas/strand.qsql (unrelated precedent for a repo-root artifact referenced via relative path — see below)
difficulty: medium
----

# Background

`packages/cadre-core` depends on `@serfab/quereus-plugin-sereus` as a workspace
package. Workspace packages resolve through `node_modules/@serfab/quereus-plugin-sereus`,
which is a symlink to `packages/quereus-plugin-sereus`, and its `package.json`
`main`/`exports` point at `dist/`, not `src/`. Nothing in `cadre-core`'s own test
run rebuilds that dependency first, so `cadre-core`'s test suite (and any suite in
any package that depends on another workspace package) can silently run against a
stale build: edit `quereus-plugin-sereus`'s source, run `cadre-core`'s tests, get a
green result that says nothing about the edit. This was observed directly — see the
originating ticket for the reproduction (a new access-control table was silently
absent from the database under test while 938 tests reported passing).

**The fix already exists in this repo, for a different package.**
`packages/integration-tests/src/harness/build-freshness.ts` implements exactly this
check: `assertCadreBuildFresh()` compares, for a list of packages, the newest file
mtime under each package's `src/` against the newest mtime anywhere in its compiled
output, and throws with a "Run: yarn workspace X build" remedy if `src` is newer.
It already covers `@serfab/quereus-plugin-sereus` and `@serfab/cadre-core` themselves,
plus the linked sibling packages from `../optimystic` and `../quereus` (checked out
beside this repo and reached via `link:` resolutions in the root `package.json`).
It is wired into `integration-tests` only, via `src/global-setup.ts`, which vitest
runs once before that package's suite.

`cadre-core`'s own suite — the one that actually hit this bug — has no such guard.
This ticket wires the *same* mechanism into `cadre-core`, and in doing so lifts the
mechanism out of `integration-tests` so it has one home both packages import from,
rather than becoming a second hand-maintained copy (the exact failure mode this repo
is already trying to avoid with the schema itself).

# Design

`build-freshness.ts`'s logic is already fully general — nothing in
`checkBuildFreshness`, `checkLinkedTarget`, `resolveLinkedPackage`, or the repo-root/
`node_modules` discovery helpers is specific to `integration-tests`. Only two things
are integration-tests-specific: the hardcoded `TARGETS` array (which packages to
check) and the zero-argument convenience wrapper `assertCadreBuildFresh()` built
around it. Split those apart:

1. **Move** `packages/integration-tests/src/harness/build-freshness.ts` and its
   spec `build-freshness.spec.ts` to a new repo-root directory, `test-harness/`
   (a sibling of `schemas/`, `docs/`, `ops/` — a cross-package artifact, not
   workspace application code, so it does not belong under `packages/`). This
   mirrors a pattern the repo already uses: the schema drift specs
   (`packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`) reach
   `schemas/strand.qsql` at the repo root via a relative `new URL(...)`, not
   through a package dependency. Do the same here: consumers import
   `test-harness/build-freshness.ts` by relative path from wherever their own
   `test/`/`src` global-setup file lives. This deliberately avoids making the
   shared module its own buildable workspace package — a compiled shared package
   would reintroduce the identical staleness bug for the guard meant to catch it.
   Vitest transpiles the imported `.ts` file directly (via esbuild), so there is
   no build step in this loop at all.

2. In the moved `build-freshness.ts`, **generalize** the one integration-tests-specific
   entry point: replace the hardcoded `TARGETS` constant and `assertCadreBuildFresh()`
   with a single exported function that takes the target list as a parameter:

   ```ts
   export function assertBuildFresh(targets: readonly BuildTarget[]): void {
     // body is what assertCadreBuildFresh() has today, generalized to `targets`
   }
   ```

   Keep `BuildTarget`, `TargetLocation`, `StaleReason`, `LinkedPackage`,
   `checkBuildFreshness`, `checkLinkedTarget`, `resolveLinkedPackage` exported
   unchanged — only the hardcoded-list wrapper changes shape.

3. In `packages/integration-tests/src/global-setup.ts`, move the old `TARGETS`
   array here (it becomes this package's own concern, not the shared module's),
   and call the new `assertBuildFresh(TARGETS)` instead of the old
   `assertCadreBuildFresh()`. Import `assertBuildFresh` and `BuildTarget` from
   the relocated `../../../test-harness/build-freshness.js` (four `..` segments:
   `harness-caller-dir` doesn't apply here — `global-setup.ts` sits directly in
   `src/`, so it's `src/` -> `integration-tests/` -> `packages/` -> repo root =
   three `..` segments: `../../../test-harness/build-freshness.js`). Update
   `packages/integration-tests/src/harness/index.ts`'s
   `export * from './build-freshness.js';` line similarly (that file sits one
   level deeper, in `src/harness/`, so it needs four `..` segments:
   `../../../../test-harness/build-freshness.js`), or drop that re-export line
   entirely if nothing outside `global-setup.ts` actually imports the harness's
   `build-freshness` re-export (check for other importers before deciding).

4. In `packages/cadre-core`, add `test/global-setup.ts` defining this package's
   own target list — every workspace or linked package `cadre-core` imports
   directly, mirroring the subset of `integration-tests`' existing list that
   `cadre-core` actually depends on (see its `package.json` `dependencies`):

   ```ts
   const TARGETS: BuildTarget[] = [
     { packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
     { packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
     { packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
     { packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
     { packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
     { packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
   ];
   export default function setup(): void {
     assertBuildFresh(TARGETS);
   }
   ```

   `distEntry` values are copied from `integration-tests`' existing `TARGETS` —
   don't re-derive them, they're already correct for these exact packages.
   Wire it into `packages/cadre-core/vitest.config.ts` via
   `globalSetup: ['./test/global-setup.ts']` (same key `integration-tests`
   already uses).

5. `packages/cadre-core/tsconfig.typecheck.json` already includes `"test"`
   (alongside `"src"`), so the new `test/global-setup.ts` is typechecked as part
   of `yarn workspace @serfab/cadre-core typecheck`. Its import of
   `../../../test-harness/build-freshness.js` reaches outside the package's
   `rootDir`; confirm this typechecks cleanly (`noEmit: true` in this tsconfig
   means TypeScript's rootDir-vs-emit restriction, which is what would normally
   object to a file outside `rootDir`, does not apply — there is no emission to
   place a "wrong" relative path into). `tsconfig.build.json` (the one that
   actually emits `dist/`) inherits `include: ["src"]` from `tsconfig.json` and
   is untouched by this change, so nothing outside `src/` is ever compiled into
   `cadre-core`'s published output.

6. Do **not** change the root `test` script (`yarn workspaces foreach -A run test`)
   from `-A` to `-At`, and do not add any `pretest`/build-ordering hooks. The
   guard added here is strictly stronger than build ordering: build ordering
   only helps the full `yarn test` root run; the bug as observed happened via a
   single-package run (`yarn workspace @serfab/cadre-core test`, the way an
   implement-stage agent typically runs a package's own tests), which build
   ordering at the root would not have caught but this guard does, because it
   checks freshness regardless of how or in what order tests were invoked. Adding
   ordering on top would be redundant scope for no additional coverage.

## Why not the other two options from the originating ticket

- **Path-alias consumers to source instead of `dist` during tests**: would also
  work, but requires per-consumer vitest alias config (and, for `cadre-core`,
  aliasing five packages' worth of linked-sibling imports too, since those are
  real compiled dependencies of real behavior, not just the schema), and every
  future workspace/linked dependency added to a package would need the same
  alias remembered by hand — another hand-maintained list, just a different
  shape than the one this ticket removes. The freshness-guard approach instead
  reuses a mechanism that already exists, is already unit-tested, and already
  covers every one of these packages for `integration-tests`.
- **Extend the drift-guard specs to compare against `dist/` as a third copy**:
  narrower than the actual problem. The originating ticket's own scope note
  says the staleness risk applies to "anything else `cadre-core` imports from
  that package, not only to the schemas" — a `dist/`-comparison guard bolted onto
  the two existing string-drift specs would catch only the schema, not (for
  example) a stale access-control function or a stale linked-sibling behavior
  change. The freshness guard already generalizes to all of it.

# Edge cases & interactions

- **Fresh clone / nothing built yet**: guard must report `missing` with a clear
  `yarn workspace <pkg> build` remedy, not an ambiguous crash. Already handled by
  `checkBuildFreshness`/`problemMessage` — confirm by deleting
  `packages/quereus-plugin-sereus/dist` and running `cadre-core`'s tests.
- **Only the workspace dependency is stale, linked siblings are fine**: guard
  must name only the stale one, not fail generically. Already covered by
  existing unit tests in the relocated spec — rerun them.
- **The exact originating bug**: edit `packages/quereus-plugin-sereus/src/strand-schema.ts`
  (or any file under its `src/`) without rebuilding, then run
  `yarn workspace @serfab/cadre-core test` directly (not `yarn test` from root).
  This must now fail loudly with a stale-build message instead of silently
  passing. Rebuild (`yarn workspace @serfab/quereus-plugin-sereus build`) and
  confirm the suite passes again. This is the acceptance test for this ticket —
  it reproduces the exact scenario from the originating ticket's bug report.
- **`tsc --incremental` partial rewrites**: a rebuild only rewrites the `dist`
  files a change actually touched, so `dist/index.js`'s own mtime can lag behind
  a genuinely fresh build. Already handled — `checkBuildFreshness` compares
  against the newest mtime anywhere under the output root, not just the entry
  point. No new code needed; just don't accidentally narrow this when wiring
  `cadre-core`'s target list.
- **Windows junctions** (this repo's `../optimystic`/`../quereus` links are
  Windows junctions on this dev machine): already handled — `lstatSync(...).isSymbolicLink()`
  reports `true` for junctions too, per the existing code comment. No change
  needed, but don't "fix" this if it looks odd during review.
- **Registry-installed copy vs. `link:`ed working copy** of an `@optimystic`/`@quereus`
  package: only a real symlink is checked; a registry install is skipped
  (`not-linked`), since its `src`/`dist` mtimes are meaningless. Unchanged by
  this ticket — just don't accidentally apply the workspace-only code path to
  these targets.
- **Moving the file must not silently break `integration-tests`' own suite**:
  after the move, run `yarn workspace @serfab/integration-tests test` and
  confirm the relocated `build-freshness.spec.ts` still executes and passes (its
  path changes from `src/harness/build-freshness.spec.ts` to
  `test-harness/build-freshness.spec.ts` at the repo root — that file is no
  longer inside any package's own `test`/`src` include glob, so it will only run
  if something still points vitest at it; if nothing does, either keep the spec
  physically alongside the file that still gets picked up some other way, or
  give it an explicit include entry — decide during implementation and verify
  it actually executes, don't just move it and assume).
- **`yarn dep-check` (knip)**: after moving files out of
  `packages/integration-tests/src`, run `yarn dep-check` and confirm nothing new
  is flagged as unused (a root-level `test-harness/` directory sits outside any
  workspace and outside knip's package-scoped analysis, so it should be a
  non-issue, but confirm rather than assume).
- **The two existing schema drift specs are out of scope and must stay green**:
  `strand-schema-drift.spec.ts` and `control-schema-drift.spec.ts` compare
  source-to-source and don't touch `dist` at all; this ticket must not change
  their behavior. Run both explicitly as part of verification.
- **`yarn typecheck` at the root** (`yarn workspaces foreach -A run typecheck`)
  must stay green for both `cadre-core` and `integration-tests` after the file
  move and the new cross-package relative import.

# TODO

- Create `test-harness/` at the repo root; move `build-freshness.ts` and
  `build-freshness.spec.ts` there from `packages/integration-tests/src/harness/`
- Generalize `assertCadreBuildFresh()` into `assertBuildFresh(targets: readonly BuildTarget[])` in the moved file
- Update `packages/integration-tests/src/global-setup.ts` to own its `TARGETS` list locally and call `assertBuildFresh(TARGETS)` via the new relative import path
- Update `packages/integration-tests/src/harness/index.ts`'s re-export (or remove it if unused — check for other importers first)
- Confirm the relocated `build-freshness.spec.ts` still actually runs as part of some `yarn workspace ... test` invocation; wire it in if it doesn't
- Add `packages/cadre-core/test/global-setup.ts` with `cadre-core`'s own `TARGETS` list (per the Design section) and wire it via `globalSetup` in `packages/cadre-core/vitest.config.ts`
- Reproduce the originating bug end-to-end: edit `quereus-plugin-sereus` source without rebuilding, run `cadre-core`'s tests directly, confirm a loud stale-build failure; rebuild; confirm green again
- Run `yarn workspace @serfab/integration-tests test`, `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/quereus-plugin-sereus test`, `yarn typecheck`, and `yarn dep-check`; confirm all green
