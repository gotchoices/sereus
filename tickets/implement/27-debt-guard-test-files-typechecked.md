description: Nothing stops someone from quietly hiding a package's test files from the type checker, so tests can drift out of sync with the code for months before anyone notices — add an automated check that catches it.
files: scripts/check-test-file-typecheck-coverage.mjs, scripts/check-test-file-typecheck-coverage.test.mjs, scripts/lib/typecheck-programs.mjs, scripts/check-vitest-typecheck-coverage.mjs, scripts/test-typecheck-allowlist.json, package.json, docs/STATUS.md
difficulty: medium
---

# Guard: every test file Vitest collects is also inside a type-check program

## Why

Vitest strips types and executes — it never type-checks the files it runs. A test file only
gets type safety if some `tsc` program includes it. Nothing enforces that today. It already
bit once: `cadre-provider` excluded its own test directory from its type-check config to get
past a batch of errors, no follow-up was filed, and `docs/STATUS.md` ended up citing a ticket
slug that never existed. Two other packages had the same exclusion, were fixed, and the doc
was never corrected — so the written record and reality disagreed in both directions at once.

The sibling guard `scripts/check-vitest-typecheck-coverage.mjs` already enforces the level
below this one (each package's `vitest.config.ts` is inside its own type-check program). This
is the same class of gap one level out: the config is guarded, the tests it runs are not.

## Current state (measured, not assumed)

A working prototype of this guard was run against the repo at `011f3ed`. Result:

```
@serfab/cadre-cli:              17 collected, 0 orphaned
@serfab/cadre-core:             88 collected, 0 orphaned
@serfab/cadre-host:             61 collected, 0 orphaned   (two tsconfigs: package + ui/)
@serfab/cadre-provider:         19 collected, 0 orphaned
@serfab/integration-tests:      41 collected, 0 orphaned   (incl. ../../test-harness/build-freshness.spec.ts)
@serfab/quereus-plugin-sereus:   9 collected, 0 orphaned   (vitest `projects:` — unit + e2e)
@serfab/reference-app-rn:       10 collected, 0 orphaned   (vitest `projects:` — node + react)
@serfab/reference-app-web:       3 collected, 0 orphaned
@serfab/strand-proto:            3 collected, 3 orphaned   <-- only failure
```

Whole sweep costs **~1.2 s** wall clock in one Node process (all nine packages, including
process start). That is the entire budget this adds to root `yarn typecheck`.

`strand-proto` is the one real gap, and it is not fixable: its `tsconfig.typecheck.json`
includes only `src` + `vitest.config.ts`, while its vitest config collects
`test/auto/**/*.ts`. Adding `test` to that include was tried and produces ~12 errors
(`TS2353` `peerId` no longer in `Libp2pOptions`, `TS2339` `Stream.stream` gone, `TS5097`
`.ts` import extensions, `BootstrapMode` widening) — the package is deprecated and its tests
have bit-rotted against current libp2p types. It goes on the allowlist, with that reason
written down.

**`docs/STATUS.md` is wrong about this today.** The "Shippable source only" bullet says
`strand-proto` "has no test files anyway, so nothing is hidden by the narrower program."
It has three, and they are hidden. Fix that sentence as part of this ticket.

## Design

### Where the collected-file list comes from

Ask Vitest. `vitest/node` exports `createVitest`, and the `Vitest` instance has
`globTestSpecifications()`, which resolves the config (including `extends`, plugins, and
nested `projects:`) and globs the test files **without importing or running them**. Verified
against all nine packages and against throwaway tmpdir fixtures:

```js
import { createVitest } from 'vitest/node';

const vitest = await createVitest('test', { root: packageDir, watch: false });
const specs = await vitest.globTestSpecifications();           // TestSpecification[]
const setups = vitest.projects.flatMap((p) => [...p.config.setupFiles, ...p.config.globalSetup]);
await vitest.close();
```

`specs[i].moduleId` is an absolute path (forward-slashed on Windows — normalize, see below).
This is the whole reason not to hand-roll glob matching: `quereus-plugin-sereus` and
`reference-app-rn` both use `projects:` with per-project `include`/`exclude`, and
`integration-tests` reaches *outside* its own package (`../../test-harness/**/*.spec.ts`).
A hand-written matcher would have to reproduce all three.

Two confirmed properties that make this safe to run inside a type-check gate:

- `globTestSpecifications()` does **not** execute `globalSetup` or import any test file.
- After `await vitest.close()` the process exits naturally — no lingering Vite handle.

`setupFiles` and `globalSetup` are folded into the same collected set: Vitest executes them
too, and they are never type-checked either. All of them are already covered today, so this
costs nothing now and closes the same hole.

### Where the type-check file list comes from

Unchanged from the sibling guard: read the package's `typecheck` script, scrape every
`-p`/`--project` argument (there can be more than one — `cadre-host` runs two passes), fall
back to `./tsconfig.json` when there are none, and feed each to
`ts.getParsedCommandLineOfConfigFile`, which follows `extends` and expands `include`/`exclude`
into a concrete file list. A file covered by **any one** of the package's programs is covered.

### Script layout — sibling script plus a shared module

Three-way split, so the cheap synchronous guard does not grow an async Vitest boot and the
two failure messages stay distinct:

```
scripts/lib/typecheck-programs.mjs          (new)  shared helpers, no side effects, no top-level exit
scripts/check-vitest-typecheck-coverage.mjs (edit) trimmed to import from lib; behavior unchanged
scripts/check-test-file-typecheck-coverage.mjs (new) this guard
scripts/check-test-file-typecheck-coverage.test.mjs (new) fixtures
scripts/test-typecheck-allowlist.json       (new)  allowlist data
```

`scripts/lib/typecheck-programs.mjs` exports, moved verbatim out of the existing script:

```js
export function readJson(path)                                   // JSON.parse(readFileSync(...))
export function workspacePackageDirs(root)                       // packages/* with a package.json
export function vitestConfigPaths(packageDir)                    // vitest.config.{ts,mts,cts} that exist
export function tsconfigPathsForTypecheckScript(packageDir, script)
export function resolvedProgramFiles(tsconfigPath)               // Set<normalized abs path>
export function normalizePath(p)                                 // resolve(p), lowercased on win32
```

Keep every existing `NOTE:` comment with the function it documents (the `packages/*`-only
workspace assumption, the flag-scraping-not-shell-parsing caveat, the
why-resolve-the-program-rather-than-read-`include` rationale). Do not restate them in the new
script — point at the lib.

`normalizePath` is new and is applied on **both** sides of every comparison. Vitest returns
`C:/projects/...`; TypeScript returns platform separators; drive-letter case can differ
between the two. `resolve()` alone happened to work in the prototype, but lowercasing on
`win32` removes a whole class of platform flake for free. Apply it in the existing guard too
— strictly safer, no behavior change on a matching path.

### Allowlist

Data file `scripts/test-typecheck-allowlist.json`, read relative to the root under check, so
fixtures can supply their own and the allowlist logic is directly testable. Absent file =
empty allowlist. Keyed by package name (what failure messages print):

```json
{
  "@serfab/strand-proto": {
    "reason": "Deprecated, source-only by design. Its test/ has bit-rotted against current libp2p types (TS2353 peerId is no longer in Libp2pOptions, TS2339 Stream.stream, TS5097 .ts import extensions); adding `test` to tsconfig.typecheck.json produces ~12 errors and the package is not being revived.",
    "files": [
      "test/auto/bootstrap.integration.ts",
      "test/auto/bootstrap.ts",
      "test/auto/peerid-sanity.ts"
    ]
  }
}
```

Exact package-relative POSIX paths — no globs, so there is no second glob implementation and
a moved file forces someone to touch the list.

**The allowlist is validated, not merely consulted.** Any of these fails the gate:

- an entry naming a package that is not a workspace with a Vitest config;
- an entry with a missing, empty, or whitespace-only `reason`;
- `files` missing, not an array, empty, or containing a non-string / absolute / `..`-escaping path;
- a listed file that Vitest does **not** collect (deleted or renamed — stale entry);
- a listed file that **is** in a type-check program (the package got fixed — stale entry).

The last two are the point. A silently-stale allowlist is precisely how `docs/STATUS.md`
drifted last time; the guard must make a fixed package fail until its justification is
deleted.

### Failure output

Mirror the sibling guard's shape. Group by package; cap the per-package file list at 10 and
print `… and N more` so a whole-directory exclusion does not dump 80 lines — and say the
count, never truncate silently.

```
check-test-file-typecheck-coverage: test files Vitest runs that `tsc` never checks:

  @serfab/foo (packages/foo)
    3 of 19 collected test/setup file(s) are not in the type-check program resolved from
    packages/foo/tsconfig.typecheck.json (typecheck script: "tsc -p tsconfig.typecheck.json --noEmit"):
      src/__tests__/a.test.ts
      src/__tests__/b.test.ts
      src/__tests__/global-setup.ts

1 package(s) run test files that are never type-checked.
```

Success line: `check-test-file-typecheck-coverage: every test file Vitest collects is inside its package's type-check program (N files across M packages; K allowlisted).` — state the allowlisted count so the exemption is visible on a green run.

Allowlist-validation failures get their own clearly-labelled block, e.g.
`stale allowlist entry: @serfab/foo test/x.spec.ts is now inside the type-check program — delete the entry`.

### Deliberate blind spots (document as `NOTE:` at the code site)

- Only files with a TypeScript extension (`.ts`, `.tsx`, `.mts`, `.cts`) are checked. A `.js`
  test file cannot be in a `tsc` program without `allowJs`, and the repo has zero today. If
  JS test files ever appear they pass unchecked.
- Any collected path containing `node_modules` is skipped — a `globalSetup` resolved out of a
  dependency is not this repo's to type-check.
- `.svelte` files are not a concern here: every Vitest `include` in the repo targets `*.ts`,
  so no `.svelte` file is ever collected. (`svelte-check` coverage remains the separate,
  already-documented gap.)

### Root wiring

`vitest` is currently a devDependency of all nine packages at `^4.0.17` but **not** of the
root. The new script imports `vitest/node` and resolves it only via node_modules hoisting
today, which is both fragile and a phantom dependency by `knip`'s rules. Add
`"vitest": "^4.0.17"` to root `devDependencies`.

Root `package.json` scripts:

```jsonc
"check:test-file-typecheck-coverage": "node scripts/check-test-file-typecheck-coverage.mjs",
"test:test-file-typecheck-coverage": "node --test scripts/check-test-file-typecheck-coverage.test.mjs",
"typecheck": "yarn workspaces foreach -A run typecheck && yarn check:vitest-typecheck-coverage && yarn check:test-file-typecheck-coverage",
"test": "... && yarn test:vitest-typecheck-coverage && yarn test:test-file-typecheck-coverage",
```

Fixture-root env var: `TEST_FILE_TYPECHECK_COVERAGE_CHECK_ROOT` (same pattern and same
comment style as `VITEST_TYPECHECK_COVERAGE_CHECK_ROOT`).

Exit handling: collect all failures, print, then `process.exit(code)` explicitly **after**
every `vitest.close()` — matching the sibling script's `process.exit(main())` shape.

## Edge cases & interactions

Each of these should land as a fixture test unless marked otherwise.

**Core drift detection**

- `"exclude": ["src/**/__tests__/**"]` reintroduced in a package's typecheck config → exit 1,
  names the package and at least one orphaned file. (This is the headline acceptance case.)
- Package whose `typecheck` is repointed at a `tsconfig.build.json` that omits `test/` → exit 1.
- Package fully covered → exit 0, package not named in output.
- Package with a Vitest config that collects **zero** files (`--passWithNoTests` packages like
  `cadre-cli` when tests are removed) → exit 0, no failure.

**Vitest config shapes**

- `projects:` with per-project `include` + `exclude`: a file collected by only one project and
  missing from the program → exit 1. (Verified working in a tmpdir fixture during planning.)
- `setupFiles` / `globalSetup` outside the program → exit 1, file named.
- A test file **outside** the package directory (`../../test-harness/**`, the real
  `integration-tests` case) is checked against the package's program and passes when the
  program includes it — assert this against a fixture with a sibling directory above `packages/`.
- Vitest config that throws on load → exit 1 with the package named and the error text, not an
  unhandled rejection.
- `vitest.config.mts` / `.cts` handled identically to `.ts` (shared `vitestConfigPaths`).

**Multiple type-check programs**

- Two `-p` flags (the real `cadre-host` shape: package tsconfig + `ui/tsconfig.json`), file
  covered by the second one → exit 0.
- Two `-p` flags, file in neither → exit 1.
- Bare `tsc --noEmit` with no `-p` defaults to `./tsconfig.json` (the real `reference-app-web`
  shape) → covered file passes.

**Allowlist**

- Allowlisted orphan → exit 0, and the success line reports the allowlisted count.
- Stale entry: allowlisted file is now inside the program → exit 1, message says to delete the entry.
- Stale entry: allowlisted file no longer collected by Vitest → exit 1.
- Entry naming a non-existent / non-Vitest package → exit 1.
- Entry with empty or whitespace-only `reason` → exit 1.
- Entry whose `files` is absent / empty / contains an absolute or `..` path → exit 1.
- No allowlist file at all → treated as empty, no crash.
- Malformed JSON in the allowlist → exit 1 with a readable parse error, not a stack trace.

**Cross-cutting**

- Path normalization: the comparison must survive Vitest's forward-slashed `C:/…` versus
  TypeScript's platform separators, and drive-letter case differences on Windows. The whole
  repo passing today (9/9 packages, 0 spurious orphans) is the regression baseline — if a
  normalization change makes any covered package start reporting orphans, the change is wrong.
- Refactoring `check-vitest-typecheck-coverage.mjs` onto the shared lib must leave its 16
  existing fixture tests passing untouched. Do not edit that test file to accommodate the
  refactor; if it needs editing, the refactor changed behavior.
- No `packages/` directory at all → exit 0 (the sibling guard already has this fixture).
- Runtime: keep the added `yarn typecheck` cost near the measured ~1.2 s. If a design change
  pushes it past ~5 s, say so in the handoff rather than absorbing it silently.

## TODO

### Phase 1 — shared module, no behavior change

- Create `scripts/lib/typecheck-programs.mjs` and move `readJson`, `workspacePackageDirs`,
  `vitestConfigPaths`, `tsconfigPathsForTypecheckScript`, `resolvedProgramFiles`, the
  `parseConfigHost` object and the `PROJECT_FLAG` regex out of
  `scripts/check-vitest-typecheck-coverage.mjs`, carrying their `NOTE:` comments along.
- Add `normalizePath(p)` to the lib: `resolve(p)`, lowercased when `process.platform === 'win32'`.
  Have `resolvedProgramFiles` build its `Set` through it.
- Rewrite `check-vitest-typecheck-coverage.mjs` to import from the lib and compare through
  `normalizePath`. Its header comment stays; drop the parts now living in the lib.
- Run `yarn test:vitest-typecheck-coverage` — all 16 existing fixtures must pass with the test
  file unmodified.

### Phase 2 — the new guard

- Add `"vitest": "^4.0.17"` to root `devDependencies`; `yarn install`.
- Write `scripts/check-test-file-typecheck-coverage.mjs`: header comment explaining the gap and
  pointing at this ticket + `docs/STATUS.md`; `TEST_FILE_TYPECHECK_COVERAGE_CHECK_ROOT` env
  override; per-package `createVitest` → `globTestSpecifications()` → `+ setupFiles/globalSetup`
  → filter to TS extensions and drop `node_modules` → diff against the union of the package's
  resolved programs → subtract the allowlist.
- Wrap each package in try/catch so one broken Vitest config reports as that package's failure
  rather than aborting the sweep; always `await vitest.close()`.
- Write `scripts/test-typecheck-allowlist.json` with the single `@serfab/strand-proto` entry and
  the reason text above.
- Implement allowlist validation (shape + both staleness directions) as its own reporting block.
- Add the `NOTE:` comments for the three deliberate blind spots at their code sites.
- Wire the two root `package.json` scripts and chain them into `typecheck` and `test`.

### Phase 3 — fixtures

- Write `scripts/check-test-file-typecheck-coverage.test.mjs` mirroring the sibling test's
  structure (`node:test`, `mkdtempSync` fixture builder, `spawnSync` the script with the env
  var, `rmSync` in a `finally`).
- Fixture configs must be **import-free** plain objects — `export default { test: { … } };` —
  since a tmpdir fixture cannot resolve `vitest/config`. Verified working during planning;
  the sibling test already uses this trick.
- Cover every case in "Edge cases & interactions" above.

### Phase 4 — validate and document

- `yarn typecheck` (must pass, including both guards), `yarn lint`,
  `yarn test:vitest-typecheck-coverage`, `yarn test:test-file-typecheck-coverage`.
- Sanity-check the guard actually bites: temporarily add `"exclude": ["src/**/__tests__/**"]`
  to `packages/cadre-provider/tsconfig.typecheck.json`, confirm exit 1 naming the package and
  its files, then revert that edit.
- `docs/STATUS.md` → "Type-check coverage":
  - Add a bullet for the new guard alongside the existing `check-vitest-typecheck-coverage` one:
    what it enforces, how it gets the file list (`createVitest` + `globTestSpecifications`, which
    is what makes `projects:` and out-of-package includes work), the allowlist and its
    staleness checks, the measured ~1.2 s cost, and the fixture count.
  - **Correct the `strand-proto` bullet** — it currently claims the package "has no test files
    anyway". It has three (`test/auto/*.ts`), they are outside its type-check program, and they
    are now explicitly allowlisted with a recorded reason.
  - Record the three deliberate blind spots (JS test files, `node_modules` setup files, and that
    `.svelte` is a non-issue here) under "Known coverage gaps".
