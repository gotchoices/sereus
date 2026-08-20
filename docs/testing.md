# Testing, gates, and release checks

The rules and coverage guarantees behind this repo's four root gates — `yarn typecheck`,
`yarn dep-check`, `yarn lint`, `yarn test` — plus the one release-time check that is
deliberately *not* a gate (`yarn smoke:published`).

This document holds **policy and rationale**: what each gate covers, what it deliberately does
not, and why. It is not a status board. Current pass/fail state lives in the suites themselves;
in-flight defects live in [`tickets/`](../tickets) (see [`tess/agent-rules/tickets.md`](../tess/agent-rules/tickets.md)),
and known pre-existing failures in [`tickets/.pre-existing-known.md`](../tickets/.pre-existing-known.md).

## Where measurements live

Storage-operation budgets are pinned in the specs that assert them, each carrying its own
`MEASURED_ON` date and the full history in its doc comment:

- `packages/cadre-core/test/control-start-storage-op-budget.spec.ts` — control-database start,
  cold and warm.
- `packages/cadre-core/test/strand-solo-write-budget.spec.ts` — solo strand launch/insert/select.

Both are two-sided (a ceiling as regression guard, a floor at half the measurement as
anti-vacuity guard), and the operative consequence — that a control start's duration is
(raw-storage operations) × (device cost per operation), so the *count* is the thing worth
pinning — is recorded as a `NOTE:` at `control-database.ts`'s `loadSchema` call site, which is
where someone debugging a slow launch actually lands. Do not copy those numbers here; a second
copy is a second thing to leave stale.

## Stale-build guard

Every suite that runs *compiled* output — a spawned real `cadre-cli` child, or an in-process
import from a package's `dist` — is guarded against running a previous build. `test-harness/build-freshness.ts`
exports `assertBuildFresh(targets, setupUrl)`; each consuming package owns its target list in its
own vitest `globalSetup`, and `test-harness/build-targets.ts` derives what that package actually
runs from a rebuildable `dist` so a hand-written list cannot silently go stale. The invariants
worth not re-litigating:

- **`test-harness/` is never built and is not a workspace.** A compiled shared package would be
  consumed from its own `dist` and so could be defeated by exactly the staleness it exists to
  catch. It is imported by relative path.
- **Linked sibling workspaces are guarded too.** `../optimystic` and `../quereus` reach
  `node_modules` as symlinks via the root `resolutions`, are developed concurrently, and cost
  three re-investigations of an already-fixed replication bug before this existed.
- **A dependency that is a real directory rather than a symlink is skipped, never judged.** Its
  `src`/`dist` mtimes are packing artifacts and would report a permanent, unfixable "stale".
- **`assertBuildFresh` takes the caller's `import.meta.url` as a required argument.** Resolution
  walks `<dir>/node_modules` from the calling module up to the monorepo root inclusive, because
  packages setting `installConfig.hoistingLimits: "workspaces"` keep their own copies and that is
  what their suites load. A default would silently reinstate the blind spot.
- **`cadre-provider` is the one package with no guard**, because it declares zero
  `workspace:`/`link:` dependencies. Nothing here would flag its omission if it ever gains one — a
  `NOTE:` in its `vitest.config.ts` says so at the site.
- Test files (`*.test.ts`, `*.spec.ts`, `test/`, `__tests__/`) are excluded from the source scan —
  they are not build inputs, so editing a spec does not trip the guard.

The guard is unit-covered by `test-harness/build-freshness.spec.ts`, and per-package target-list
drift fails that package's own `yarn test` via `test-harness/build-targets-spec.ts`.

## Type-check coverage

`yarn typecheck` (root) fans out to **every** TS workspace. Each package defines a `typecheck`
script (`tsc --noEmit`) so type validation does not depend on the slower `yarn build`, and test
files are type-checked where possible (vitest itself never type-checks).

- Every TS package has a `typecheck` script; `yarn typecheck` validates all 10 workspaces.
- Every package that **has** a `vitest.config.ts` also has that file inside its `typecheck` program, so a
  Vitest option the installed version no longer recognizes fails `yarn typecheck` instead of sitting
  silently unused (this bit once: a `test.poolOptions.forks.singleFork` removal in Vitest 4 went
  unnoticed for a whole major-version upgrade — the setting was ignored and scenario files ran in
  parallel despite binding real network ports; now expressed as top-level `pool: 'forks'` +
  `fileParallelism: false`).
  Covered via `tsconfig.typecheck.json` (`cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`,
  `quereus-plugin-sereus`, `strand-proto`, `integration-tests`) or the package's main `tsconfig.json`
  (`reference-app-ns`, `reference-app-rn`, `reference-app-web`).
  Verified by injecting an unknown key into each of the ten configs and confirming `TS2769
  … does not exist in type 'InlineConfig'` — including keys nested inside `test.projects[].test`
  (`ProjectConfig`), which is where the `poolOptions` precedent lived.
  Enforced going forward by `scripts/check-vitest-typecheck-coverage.mjs` (`yarn check:vitest-typecheck-coverage`,
  chained into root `yarn typecheck`): for every `packages/*` holding a `vitest.config.{ts,mts,cts}`,
  it reads that package's `typecheck` script, extracts the tsconfig(s) it invokes (`-p`/`--project`,
  falling back to `./tsconfig.json`), asks the TypeScript compiler API which files those actually
  resolve to (`ts.getParsedCommandLineOfConfigFile`, which follows `extends` and expands
  `include`/`exclude` — robust against `include` reaching the file by directory, glob, or not at all),
  and fails naming the package if the config file is absent from that resolved list. Silent about
  packages with no vitest config. `scripts/check-vitest-typecheck-coverage.test.mjs`
  (`yarn test:vitest-typecheck-coverage`, chained into root `yarn test`) proves the guard catches
  drift — not just that it passes today — with 16 throwaway-fixture workspaces covering: the config
  dropped from `include`, `typecheck` repointed at a build config that omits it (the second
  regression mode above), a `.mts`-renamed config, `--project`/`-p` in either position, two `-p`
  flags where only one program covers the file, a bare `tsc --noEmit` defaulting to `./tsconfig.json`,
  a glob `include` reaching the file implicitly, a missing or non-`tsc` `typecheck` script, and a
  `typecheck` script pointing at a missing config.
- Every test file Vitest **collects** — plus every `setupFiles` / `globalSetup` module it executes
  alongside them — is inside its package's type-check program. Vitest strips types and runs; it never
  type-checks the files it executes, so a test file has type safety only if some `tsc` program happens
  to include it, and nothing enforced that. It had already slipped: `cadre-provider` excluded its own
  test directory from `tsconfig.typecheck.json` to clear a batch of errors, with no follow-up filed.
  Enforced by `scripts/check-test-file-typecheck-coverage.mjs` (`yarn check:test-file-typecheck-coverage`,
  chained into root `yarn typecheck` after the config gate above). It asks Vitest itself for the file
  list — `createVitest` + `globTestSpecifications()` from `vitest/node`, which resolves each package's
  config (`extends`, plugins, nested `projects:`) and globs the matches **without importing or running
  any of them** — then diffs that list against the union of the package's resolved `tsc` programs.
  Asking Vitest rather than re-implementing its globbing is what makes the awkward shapes work:
  `quereus-plugin-sereus` and `reference-app-rn` use `projects:` with per-project `include`/`exclude`,
  and `integration-tests` collects `../../test-harness/build-freshness.spec.ts` from outside its own
  package. The whole sweep costs ~1.2 s wall clock in one Node process — that is the
  entire cost added to root `yarn typecheck`. Root declares `vitest` as a devDependency so the
  script's `vitest/node` import is a real dependency rather than a hoisting accident (which also let
  `test-harness/**` come out of knip's root `ignore`).
  Exemptions live in `scripts/test-typecheck-allowlist.json`, keyed by package name, each carrying a
  written `reason` and exact package-relative file paths (no globs, so a moved file forces someone to
  touch the list). The allowlist is **validated, not merely consulted**: an entry naming a package that
  is not a Vitest workspace, a blank `reason`, a missing/empty/absolute/escaping `files` path, a file
  Vitest no longer collects, or a file that is now *inside* the program all fail the gate. That last
  one is the point — a package that gets fixed fails until its justification is deleted.
  `scripts/check-test-file-typecheck-coverage.test.mjs` (`yarn test:test-file-typecheck-coverage`,
  chained into root `yarn test`) proves it catches drift rather than merely passing today, with 30
  throwaway-fixture workspaces covering: the `src/**/__tests__/**` exclusion reintroduced, `typecheck`
  repointed at a build config that omits `test/`, a file collected by only one `projects:` entry,
  `setupFiles`/`globalSetup` left outside the program, a spec collected from outside the package (both
  covered and uncovered), a Vitest config that throws on load, an unreadable `package.json`, a `.mts`
  config, two `-p` flags (covered by the second, and by neither), a bare `tsc --noEmit`, a package
  collecting zero files, the ten-file output cap, and every allowlist shape and staleness case above.
  Every one of those per-package failure modes is *contained*: a package that cannot be resolved is
  reported by name and the sweep continues to the rest, rather than aborting on the first bad one.
  Shared mechanics for both gates (workspace discovery, `-p` scraping, program resolution, and path
  normalization — Vitest reports forward-slashed `C:/…` paths, TypeScript reports platform separators)
  live in `scripts/lib/typecheck-programs.mjs`; the config gate's 16 fixtures pass unmodified across
  that refactor.
- Per-package scope:
  - Source **+ tests**: `cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`, `integration-tests`,
    `quereus-plugin-sereus` (via `tsconfig.typecheck.json`), `reference-app-rn`,
    `reference-app-web` (`test/**/*.ts` + `vitest.config.ts` are in its `tsconfig.json` `include`; the Playwright
    specs stay in `tsconfig.e2e.json`, checked by the separate `typecheck:e2e` script — which is chained into
    that package's `build`, **not** into root `yarn typecheck`, so the fast gate does not cover them)
  - Shippable **source only**, via a dedicated `tsconfig.typecheck.json` that also includes
    `vitest.config.ts` (kept separate from the real `tsconfig.build.json` so widening the typecheck
    program can't change what `yarn build` emits or where): `strand-proto` — deprecated. Its three test
    files (`test/auto/*.ts`) **are** hidden by that narrower program: Vitest collects them and no `tsc`
    program includes them. Adding `test` to the include produces 11 errors where the tests have bit-rotted
    against current libp2p types (4x `TS2353` `peerId` no longer in `Libp2pOptions`, 2x `TS5097` `.ts`
    import extensions, `TS2339` `Stream.stream`, plus `BootstrapMode` widening), and the package is not
    being revived — so those three files are explicitly allowlisted in
    `scripts/test-typecheck-allowlist.json` with that reason recorded there
  - `reference-app-ns` type-checks its whole `tsconfig.json` program (`tsc --noEmit -p tsconfig.json`), whose
    `include` lists `test/**/*.ts` and `vitest.config.ts` beside `app/` and `src/`. That program keeps
    `customConditions: ["react-native", "browser"]`, which turned out not to disturb resolution of
    `vitest`/`vitest/config` types — so no separate test tsconfig was needed
- Known coverage gaps:
  - `cadre-host` `ui/` (Svelte) and `reference-app-web` `.svelte` files are **not** covered — `tsc` can't type-check
    `.svelte`; that needs `svelte-check` (already a devDependency in both). Not wired into `typecheck` yet.
    `cadre-host`'s `ui/__tests__/*.ts` test files (not `.svelte`) **are** covered, via a second `tsc` pass over
    `ui/tsconfig.json` chained into the package's `typecheck` script. That config's `include` also lists
    `src/**/*.svelte`, which plain `tsc` silently ignores — the entry is there for `svelte-check`, not for this pass.
  - `check-test-file-typecheck-coverage` has three deliberate blind spots, each marked `NOTE:` at its
    code site. Only files with a TypeScript extension (`.ts`, `.tsx`, `.mts`, `.cts`) are checked — a
    `.js` test file cannot sit inside a `tsc` program unless its config sets `allowJs` (none here does)
    and the repo has zero JS test files today, so such a file would pass unchecked rather than fail
    unfixably. Collected modules that resolve inside `node_modules` are skipped — a dependency's
    `globalSetup` is not this repo's code to type-check. And `.svelte` is a non-issue for *this* gate:
    every Vitest `include` in the repo targets `*.ts`, so no `.svelte` file is ever collected (Svelte
    coverage remains the separate `svelte-check` gap above).
  - The seven `tsconfig.typecheck.json` files are near-identical (`extends ./tsconfig.json`, widen `rootDir`,
    `noEmit`, list `vitest.config.ts`). There is no shared base config in this repo — each package's
    `tsconfig.json` is hand-duplicated too — so the boilerplate is consistent with existing practice rather
    than new debt. If a compiler option ever has to change across all of them at once, that is the point to
    introduce a root `tsconfig.base.json` and have every package extend it.

## Dependency-check coverage

`yarn dep-check` (root) runs [knip](https://knip.dev) from the repo root against a single config
(`knip.ts`) covering the workspaces listed in it, then `scripts/check-dep-ranges.mjs` (see the next
section).

- `dep-check` detects unused, missing (phantom/unlisted), and unresolved deps/binaries across all workspaces.
- Gate semantics (`knip.ts` `rules`): dependency-class issues are `error` (fail the gate); dead-code
  classes (unused **files / exports / types**) are `warn` (surfaced but non-blocking). Cleaning the
  existing dead-code backlog (~15 files, ~40 exports, ~29 exported types, mostly in the reference apps
  and host UI) is **deferred**.
- NativeScript resolves page modules by string (`app-root.xml` `defaultPage`, runtime `Frame.navigate`), so
  knip's only auto-detected entry (`app/app.ts`, from `main`) reaches almost nothing and 13 real deps look
  unused. `knip.ts` declares that package's real entry points — the `*-page.ts` pages, the webpack-only
  polyfills/shims, `nativescript.config.ts`, and the manual `solo-smoke.ts` helper — so the whole `src/` graph
  is genuinely analysed rather than excluded.
- Phantom deps must be declared where production/test code imports them transitively. Packages setting
  `installConfig.hoistingLimits: "workspaces"` (`reference-app-ns`, `reference-app-web`) must not lean on
  root hoisting at all.
- Documented framework/dynamic false-positive ignores live in `knip.ts` with rationale: Expo/Metro-implicit
  (reference-app-rn), Vite-config-implicit (reference-app-web), webpack-config-implicit plus the NativeScript
  platform runtime and the global `ns` CLI binary (reference-app-ns), dynamic-`import()`/runtime-`resolve` deps
  (cadre-host: nat-port-mapper, qrcode-terminal, cadre-cli bin), and runtime-registered Quereus plugins
  plus the same `req.resolve`d cadre-cli bin (integration-tests — its harness spawns real CLI children).
  Non-workspace trees (`tess/`, `ops/`, `docs/`, `scripts/`) are ignored.
- **Zero configuration hints is part of the gate's value**: a hint means `knip.ts` is carrying an exemption
  reality no longer needs. Two were retired that way (`test-harness/**` from the root `ignore`,
  `@tsconfig/svelte` from `cadre-host`'s `ignoreDependencies` — knip resolves the tsconfig `extends` on its
  own now). One `Duplicate exports` hit on `reference-app-ns/src/shims/noise-crypto.js` is intentional: the
  shim binds all four of upstream's export names (`pureJsCrypto`/`nodeCrypto`/`asCrypto`/`defaultCrypto`) to
  the same pure-JS object so it can stand in for `@chainsafe/libp2p-noise`'s node-crypto module.

## Lint coverage

`yarn lint` (root) runs [ESLint](https://eslint.org) 10 + typescript-eslint 8 from the repo root
against a single flat config (`eslint.config.mjs`) covering all workspaces (TS, JS tooling, and
Svelte UIs via `eslint-plugin-svelte`). `yarn lint:fix` applies the auto-fixable subset.
`eslint.config.mjs` encodes the AGENTS.md style rules.

- Rules at **`error`**: `no-floating-promises`
  (type-aware, `packages/*/src` only — the AGENTS.md "`void` unused promises" rule), `no-require-imports`
  (ES-modules; one intentional cross-platform `require` in `control-database.ts` is `eslint-disable`d with
  rationale), `no-case-declarations`, `no-unused-vars` (honors the `_`-prefix convention),
  `consistent-type-imports`, `no-empty` (empty catch), `no-explicit-any` (the AGENTS.md "avoid `any`" rule),
  and the Svelte UI rules
  `svelte/no-at-html-tags` / `svelte/prefer-svelte-reactivity` (the
  remaining sites — a locally-generated QR SVG, plus transient/replace-only Set/Date instances — are false
  positives carrying scoped `eslint-disable` + rationale). Plus eslint-10 recommended additions that are **not**
  AGENTS.md rules: `prefer-const`, `preserve-caught-error`, `no-useless-assignment`, `no-control-regex`
  (one deliberate control-char guard in `update/apply.ts` is `eslint-disable`d with rationale).
  `preserve-caught-error`'s `new Error(msg, { cause })` fix required bumping `lib` to `ES2022` (target
  unchanged at `ES2020`) in `cadre-core`/`cadre-host` tsconfigs.
- **Project-specific invariant rule:** `no-restricted-syntax` flags a literal `insert into` /
  `update` / `delete from` against `CadreControl.CadrePeer` outside `control-database.ts`. Every
  membership write must run through `ControlDatabase.mutateCadrePeer` (which refreshes the
  authorized-member snapshot the control-stream gate reads); raw SQL skips it silently, a mistake
  made twice before the writers were consolidated. Matches both plain-string and template SQL;
  SQL assembled from variables is out of reach by design. Exempt: `control-database.ts` (the
  destination) and the three constraint fixtures that drive raw SQL at a bare database
  (`control-authorization-domain-separation.spec.ts`, `control-revocation-replay.spec.ts`,
  `control-revocation-reap.spec.ts`).
- Rules at **`warn`**: none, deliberately. Every rule the config encodes is a hard `error` gate;
  there is no `warn` backlog to accumulate behind.
- **Not machine-enforceable** here (remain human-review-only): lowercase SQL reserved words (SQL lives in
  template literals), and the "no runtime inline `import()`" rule (no clean ESLint rule;
  `consistent-type-imports` only covers type-position imports). Tab indentation is left to `.editorconfig`,
  not linted, to avoid a formatter war.
- Scope notes: type-aware linting (`projectService`) is enabled only for the node/library `src` trees;
  the bundler/expo apps (`reference-app-web`, `reference-app-rn`, `cadre-host/ui`) get non-type-aware rules.
  `maestro/` (Maestro JS engine), `strand-proto` (deprecated), and non-package trees (`tess/`, `ops/`,
  `scripts/`) are ignored.

## Declared dependency range vs linked workspace (keep them equal)

Root `package.json` `resolutions` maps every `@optimystic/*` and `@quereus/quereus` import to the
**linked sibling workspace** (`link:../optimystic/...`, `link:../quereus/...`). So *nothing in this
repo ever exercises the version a consumer installs* — that comes from each package's declared
`dependencies` range. When the two drift, a regression on the published floor is invisible here.

That drift caused a real report: `@serfab/cadre-core` 0.9.0 declared `@optimystic/*: ^0.14.1` while
the workspace linked 0.16.x, so an embedding app installed a substrate two minors behind everything
this repo tests against, and hit a solo control-DB hang we could not reproduce.

- **Rule: bump the declared range in lockstep with the linked workspace version.** For a `0.x`
  version `^0.16.3` *excludes* 0.17.0, so a stale declared range can omit exactly the fixes this
  repo builds and tests against.
- **Gate: `yarn dep-check` runs `scripts/check-dep-ranges.mjs`** (`dep-check` is
  `knip && yarn check:dep-ranges`), so this drift can no longer recur silently — it landed twice
  before this existed. For every root `resolutions` entry that is a `link:` target, the script reads
  the linked sibling workspace's `package.json` version, then walks every `packages/*/package.json`'s
  `dependencies` / `peerDependencies` / `optionalDependencies` and fails if a declared range does not
  admit that version (`semver.satisfies`), printing the package, the field, the declared range, the
  linked version, which direction it drifted, and a suggested `^<linked version>` edit. It is generic
  over whatever `resolutions` contains — not hardcoded to `@optimystic/*` — so it also covers
  `@quereus/quereus`, and any future linked package for free. If a linked sibling workspace directory
  is absent (e.g. a clean CI clone with no `../optimystic` checkout), that entry is skipped with a
  logged notice rather than failing. Correctly treats the `0.x` vs `1.0+` caret boundary since it
  defers to `semver` rather than a naive floor comparison. `scripts/check-dep-ranges.test.mjs`
  (`yarn test:dep-ranges`, chained into root `yarn test`) covers both caret-boundary directions, the
  "declared newer than linked" direction, the absent-sibling skip, a clean pass, multiple drifted
  ranges reported in one run across all three dependency fields, a non-`link:` resolution being
  ignored, and the two unparseable-input cases (a non-semver declared range such as `workspace:^`,
  and a malformed sibling version) reported as readable failures rather than a crash — each against a
  throwaway fixture workspace (not this repo's own packages) via `DEP_RANGE_CHECK_ROOT`.
- NOTE (tripwire, noticed 2026-08-03): `@optimystic/db-p2p-storage-fs` is the one optimystic package
  *not* in root `resolutions`, so it resolves from npm while its eight siblings resolve to
  `../optimystic` — and because the gate only checks `link:` targets, its declared range is
  ungated. Benign while the registry version is the same commit we link, but local edits to that
  package are invisible to `cadre-cli` / `quereus-plugin-sereus`, and the moment the sibling checkout
  carries an unpublished version it runs an older build against newer `db-core`/`db-p2p`. If
  fs-storage behaviour ever needs testing against local optimystic, or that mix ever produces a
  confusing failure, add a `link:` entry for it.
- `yarn upgrade:optimystic` / `yarn upgrade:quereus` (npm-check-updates) rewrite the declared ranges;
  run them when the sibling workspace is bumped, not only at release time.
- NOTE: the published packages declare `@quereus/quereus` as a regular `dependency`, not a
  `peerDependency` — including `quereus-plugin-sereus`, which is loaded *into* a Quereus host. Ranges
  agree today, so installers dedupe to one copy. If a consumer ever pins a Quereus major that our
  range does not admit, they get two Quereus instances and cross-instance `instanceof` checks start
  failing; move to `peerDependencies` at that point.

## Installing what a customer installs — `yarn smoke:published` (a release step, not a test)

The range gate above proves a declared range *admits* the version we build against. It never
installs anything, so it cannot prove the published artifact at that version actually works.
`scripts/smoke-published-install.mjs` closes that half.

- It packs every `pub:*` workspace (yarn rewrites `workspace:^` to the concrete `^<version>`, so the
  tarballs are what `yarn npm publish` would upload), installs them with **npm** into a scratch
  project under the OS temp dir, and lets everything else resolve from the public registry. The
  scratch project lives outside this repo so no `resolutions` or workspace inheritance can leak in;
  npm rather than yarn because yarn would walk upward looking for a workspace root.
- It prints the resolved version **and path** of every `@serfab/*` / `@optimystic/*` /
  `@quereus/quereus` package as hoisted into the consuming project, then every *nested* copy a
  package resolves instead — a report that would have made the "root sees `@quereus/quereus` 0.16.4
  while `cadre-core` loads a nested 4.6.0" split obvious at a glance.
- It then runs the solo control-DB scenario against the installed packages:
  `scripts/lib/published-smoke-scenario.mjs`, a port onto `node:assert/strict` of
  `packages/cadre-core/test/control-database-solo.spec.ts`'s assertions (three cadre-of-one cases)
  plus two of the six in `packages/cadre-core/test/control-database-solo-warm-start.spec.ts` —
  the vanished prior cohort and the cold boot in the embedder order. Those two are the ones carrying
  the shape an embedding app actually reported, so they are the ones worth running against a registry
  install; the other four stay spec-only because the smoke is a release step, not a suite, and every
  case costs wall clock in a scratch install. The port keeps the labelled per-operation deadlines, so
  a regression reads as `HANG: solo control op <label> timed out after <n>ms` rather than a silent
  stall, and `addStrand` gets its own wider 60 s budget because it brings a second libp2p node up.
  Import failure, hang, and assertion failure each print a distinct block. Keep the three in step —
  when a spec's assertions change, change the port rather than inventing new ones. Nothing enforces
  that; all three files carry a comment pointing at the others, and that is the whole mechanism.
- The warm-start half needs two things the cadre-of-one half did not, both added to
  `SCENARIO_DIRECT_DEPS` so the scratch project declares them: `@optimystic/db-p2p-storage-fs` (the
  `FileRawStorage` that makes the restart cross real files rather than a shared heap object — and,
  per the tripwire above, the one `@optimystic/*` with no root `resolutions` entry, so it is the one
  package here that *always* comes from the registry), and `@libp2p/crypto` + `@libp2p/peer-id` for
  the throwaway sibling identity whose signed `CadrePeer` row puts the device in a cadre it is the
  last member of. The alternative — harvesting a peerId off a throwaway second node and recording it
  with `authorizePeer` — needs no new dependencies but writes a row with `Sig: null`, which
  `resolvePeerAddrs` cannot resolve, so the port would lose the spec's anti-vacuity check that the
  sibling row is real. The dependencies were the cheaper trade.
- It fails if npm satisfied one of our own packages from the registry instead of from the packed
  tarball (checked against `package-lock.json`). The versions look identical in the report either
  way, so without that check the smoke could silently exercise the *previous* release.
- **Deliberately not in `yarn test`.** It needs the network and takes ~40 s; as a default gate it
  would break offline runs. `--skip-build` reuses whatever is in each package's `dist/`; `--keep`
  keeps the scratch project. A failing run always keeps it and prints its path. An unrecognised flag
  is refused rather than ignored, so a typo cannot silently start a full monorepo build.
- **`--skip-build` is refused when any `dist/` is missing or older than its `src/`.** `pack` does not
  build, so the tarballs would carry the previous build and a pass would mean nothing — the same
  false green `test-harness/build-freshness.ts` guards the suites against. That module is TypeScript
  with no build step, so a plain node script cannot import it; the rule (newest source mtime versus
  newest output mtime) is re-derived in `scripts/lib/published-smoke-support.mjs`, and both copies
  should change together.
- **The decisions are unit-tested even though the run itself is not.** The script only executes at
  release time, and there its guards only ever fire in the *passing* direction — a guard never seen
  to fail is not a guard. Everything that is a pure function of the repo or of an installed
  `node_modules` tree lives in `scripts/lib/published-smoke-support.mjs` and is pinned in both
  directions against fixtures by `scripts/smoke-published-install.test.mjs` (`yarn
  test:published-smoke-support`, in `yarn test`; no network, under a second). What remains unproven
  is the orchestration around them: the on-success cleanup, the `yarn build` branch, and the POSIX
  half of the `spawnSync` shim have never executed.
- **Never install a missing transitive dependency into the scratch project to get a green run.** It
  hides the exact class of defect the script exists to catch. This is not hypothetical: an upstream
  testing-barrel export chain once made merely importing `@serfab/cadre-core` from a registry install
  throw `ERR_MODULE_NOT_FOUND: Cannot find package 'chai'`, and the correct response was to leave the
  smoke red and fix it upstream (`tickets/complete/optimystic-testing-barrel-breaks-consumer-install`).
  When the smoke is red for a reason like that, verify the scenario body out-of-band instead — run
  `node scripts/lib/published-smoke-scenario.mjs` from anywhere inside this repo, which resolves
  `@serfab/*` through the workspace symlinks — and be explicit that doing so proves the scenario,
  not the registry substrate.
