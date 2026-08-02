description: The phone app's tests run real compiled code from a neighbouring package, but nothing checks that code was rebuilt after its last edit — so those tests can quietly pass against a months-old build. Every other test suite in the repo already has that check.
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-rn/test/build-targets.spec.ts, packages/reference-app-rn/test/node-local-slots.spec.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-rn/test/push-wake.spec.ts, packages/reference-app-web/test/global-setup.ts, packages/reference-app-web/test/build-targets.spec.ts, test-harness/build-freshness.ts, test-harness/build-targets.ts, test-harness/build-targets-spec.ts
difficulty: easy
---

# `reference-app-rn` runs compiled `cadre-core` with no stale-build guard

## What is wrong

Six suites in this repository fail up front when a package they run compiled code
from has not been rebuilt since its sources changed (`test-harness/build-freshness.ts`,
called from each suite's vitest `globalSetup`). `packages/reference-app-rn` is not
one of them, and it needs to be.

Its unit tests import **runtime values** — not just types — from
`@serfab/cadre-core`, which resolves through a `node_modules` symlink to that
package's `dist`:

- `test/node-local-slots.spec.ts` → `PersistentTrustedOwnerStore`,
  `PersistentBootstrapPeerStore`, `DEFAULT_IDENTITY_KEY_ID`
- `test/secure-key-store.spec.ts` → `KeyStoreAccessError`
- `test/push-wake.spec.ts` → reaches `STRAND_WAKE_TYPE` through `src/push-wake.ts`

(`test/react/use-cadre.spec.ts` mocks the package out, so it is not affected.)

So an edit to `cadre-core/src` with no following `yarn build` is invisible here:
the run exercises the previous build and reports green. That is the exact failure
this guard exists to prevent, and it has bitten this repository three times
before.

## Expected behaviour

`yarn workspace @serfab/reference-app-rn test` should abort before any test runs
when a package it loads compiled code from is stale, naming the package and the
build command to run — the same message every other suite already produces.

## Resolved design (this ticket carries no open questions)

This was designed and hand-verified in full during planning — build, typecheck,
and the full `test/` suite (all 10 files, 164 tests) passed against the change
below, then reverted so the coding lands in this stage's own commit.

- `reference-app-rn` sets `installConfig.hoistingLimits: "workspaces"`, so its
  `@optimystic/*` and `@quereus/*` copies live in
  `packages/reference-app-rn/node_modules` rather than the repository root. The
  guard already handles that — it walks the `node_modules` chain up from the
  calling setup module — so this is wiring, not new guard behaviour.
- The vitest config declares **two** projects (`node`, `react`). Vitest 4 does not
  inherit a sibling project's `globalSetup`; each project block must set it
  itself. Only the `node` project needs it — `react` mocks `@serfab/cadre-core`
  out via `vi.mock`, so it never runs real compiled output.
- Importing `@serfab/cadre-core`'s entry point evaluates modules that statically
  import `@serfab/quereus-plugin-sereus`, `@optimystic/quereus-plugin-crypto` and
  `@optimystic/quereus-plugin-optimystic`, so a suite loading any real
  `cadre-core` symbol runs their compiled output too. The target list below
  covers those transitively, following `packages/reference-app-web/test/global-setup.ts`'s
  precedent with `@optimystic/db-p2p-storage-web` swapped for this app's
  `@optimystic/db-p2p-storage-rn` (confirmed at `../optimystic/packages/db-p2p-storage-rn/package.json`:
  `"main": "dist/src/index.js"`).
- `@optimystic/db-core` is listed even though this package's own `dependencies`
  never name it directly: `cadre-core` depends on it, and it resolves through the
  repository root's `node_modules` (the guard's `node_modules`-chain walk reaches
  the root as its last stop).
- `packages/reference-app-rn/package.json` already declares
  `"@serfab/cadre-core": "workspace:^"` — no manifest change needed there (unlike
  `reference-app-web`, which had to fix a `"*"` range so the manifest cross-check
  in `build-targets.spec.ts` could classify it).
- `test-harness/build-targets-spec.ts`'s `describeBuildTargets` provides the
  shared cross-check assertions (list covers every dist-backed dependency, list
  names each package once, and the scan actually found something) — use it rather
  than hand-writing the three specs again.

## TODO

- Add `packages/reference-app-rn/test/global-setup.ts`, modeled on
  `packages/reference-app-web/test/global-setup.ts`: export `TARGETS` (a
  `BuildTarget[]`) and a default `setup()` calling `assertBuildFresh(TARGETS, import.meta.url)`.
  Target list (verified against the sibling checkouts' actual `dist` layout):
  ```
  { packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' }
  { packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' }
  { packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' }
  { packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' }
  { packageName: '@optimystic/db-p2p-storage-rn', distEntry: 'dist/src/index.js', location: 'linked' }
  { packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' }
  { packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' }
  { packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' }
  ```
- Wire it into `packages/reference-app-rn/vitest.config.ts`: add
  `globalSetup: ['./test/global-setup.ts']` to the `node` project block only.
- Add `packages/reference-app-rn/test/build-targets.spec.ts` calling
  `describeBuildTargets('reference-app-rn', { packageDir: packageRootFrom(import.meta.url, '..'), targets: TARGETS, expectFound: {...} })`
  from `test-harness/build-targets-spec.ts`, mirroring
  `packages/reference-app-web/test/build-targets.spec.ts`. `expectFound` needs at
  least one `workspace` and one `linked` hit — `@serfab/cadre-core` and
  `@optimystic/db-p2p` work (both are declared `dependencies` in this package's
  own `package.json`, unlike `db-core`, which isn't declared here and so isn't in
  `distBackedDependencies`'s output to check against).
- Run `yarn workspace @serfab/reference-app-rn test` — expect it to fail loudly
  the first time with "dist is stale" for `@serfab/cadre-core` (its `dist` will
  be behind at the time this lands); run `yarn workspace @serfab/cadre-core build`
  and re-run to confirm all 10 test files / 164 tests pass green.
- Run `yarn workspace @serfab/reference-app-rn typecheck` — must stay clean; both
  new files are plain `.ts` under `test/`, already covered by the existing
  `tsconfig`/vitest-typecheck-coverage gates the same way the other spec files
  are.
- Confirm the guard actually catches drift: touch a file under
  `packages/cadre-core/src` (e.g. `touch`), re-run the RN test command, confirm
  it fails naming `@serfab/cadre-core` as stale, then rebuild and re-run to
  confirm green again — don't leave the touched mtime/rebuild in a state that
  breaks other suites.

## Edge cases & interactions

- **`react` project must stay unaffected.** It mocks `@serfab/cadre-core` via
  `vi.mock` in `test/react/use-cadre.spec.ts` and never touches real compiled
  output — adding `globalSetup` there would be pure overhead at best, and a false
  failure at worst if the guard's `node_modules` walk behaves differently from a
  different `setupUrl` directory. Verify only the `node` project block gets the
  new `globalSetup` line.
- **Hoisting-limited resolution.** This package's `@optimystic/*` /
  `@quereus/*` copies live under `packages/reference-app-rn/node_modules`, not
  the repo root. Confirm `resolveLinkedPackageFrom` actually finds them there
  first (it walks up from `test/global-setup.ts`'s own directory) — a green run
  after building all targets is the practical proof; if a target reports
  "unresolved: not installed" despite `yarn install` having run, the walk is
  hitting the wrong copy.
- **`@optimystic/db-core`'s missing declaration.** It's a real target (imported
  transitively via `cadre-core`) but absent from this package's own
  `dependencies`, so `distBackedDependencies`/`targetListProblems` never checks
  it against the manifest — don't expect `build-targets.spec.ts`'s "cover every
  dependency" assertion to say anything about it one way or the other; that's
  expected, matching `reference-app-web`'s own precedent (its target list is a
  superset of its own `dependencies` too).
- **Stale-build failure ordering.** `assertBuildFresh` throws in `globalSetup`
  before any test file runs — a stale `@serfab/cadre-core` must abort the whole
  `node` project (all files under `test/**/*.spec.ts` except `test/react/**`),
  not just the specs that happen to import it. Confirm the failure message names
  `@serfab/cadre-core` specifically (not a generic vitest setup error) when
  intentionally left stale.
- **Concurrent installConfig drift.** If a future dependency bump changes which
  packages get hoisted vs. package-local (edits to `installConfig.hoistingLimits`
  or the root `resolutions` map), `build-targets.spec.ts`'s manifest cross-check
  is what will catch a target silently falling out of coverage — don't skip
  adding it even though it feels like boilerplate.
