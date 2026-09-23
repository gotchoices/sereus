# Testing, gates, and release checks

The rules and coverage guarantees behind this repo's four root gates — `yarn typecheck`,
`yarn dep-check`, `yarn lint`, `yarn test` — plus the one release-time check that is
deliberately *not* a gate (`yarn smoke:published`).

This document holds **policy and rationale**: what each gate covers, what it deliberately does
not, and why. It is not a status board. Current pass/fail state lives in the suites themselves;
in-flight defects live in [`tickets/`](../tickets) (see [`tess/agent-rules/tickets.md`](../tess/agent-rules/tickets.md)),
and known pre-existing failures in [`tickets/.pre-existing-known.md`](../tickets/.pre-existing-known.md).

## Where measurements live

Cost budgets are pinned in the specs that assert them, each carrying its own `MEASURED_ON` date
and the full history in its doc comment:

- `packages/cadre-core/test/control-start-storage-op-budget.spec.ts` — raw-storage operations of
  a control-database start, cold and warm.
- `packages/cadre-core/test/strand-solo-write-budget.spec.ts` — raw-storage operations of a solo
  strand launch/insert/select.
- `packages/cadre-core/test/control-founding-consult-budget.spec.ts` — the cost above the storage
  cache, which the two above cannot see: how often Optimystic's coordinator consults a block's
  cohort, and how many commits it issues, across a solo party's cold start, genesis,
  `foundStrand`, the per-request membership reads, and an idle reconcile pass; a second test
  pins the same reads before and after filing the `Revocation` ledger marker
  (`ControlDatabase.openRevocationLedger`), which is what that marker exists to save.

All three are two-sided (a ceiling as regression guard, a floor at half the measurement as
anti-vacuity guard). Two phases are pinned EXACTLY instead of bracketed, because their shape
rather than their size is the signal: the consult spec's per-call membership reads, and the
solo strand's select phase, which now reaches the backend zero times and so has no floor a
halved measurement could express — a phase pinned at zero fails on any operation in either
direction, and the phases before it carry that spec's anti-vacuity duty. For the
two storage budgets, the operative consequence — that a control start's duration is
(raw-storage operations) × (device cost per operation), so the *count* is the thing worth
pinning — is recorded as a `NOTE:` at `control-database.ts`'s `loadSchema` call site, which is
where someone debugging a slow launch actually lands. Do not copy those numbers here; a second
copy is a second thing to leave stale. The browser bundle's size caps are pinned the same way but
as ceilings only; see "Browser bundle checks" below.

Link latency is the one measurement with no spec to live in, so it lives here. `packages/integration-tests/src/harness/ws-latency.ts` replaces the global `WebSocket` constructor so every frame a node *dials out* is held for a set delay (the listening side is untouched, so the delay is one-way, not a round trip), and `blind-relay-phone-to-phone-e2e.integration.ts` commits one arm at 10 ms. **A delay figure means nothing without its mode**: `pipelined` releases each frame that long after it was written, so frames stay overlapped in flight — the honest model of latency, and of latency only, since bandwidth stays unlimited; `serial` queues a socket's frames one behind another, which is a per-socket frame-RATE cap (1000 / delay frames per second) and reaches delays an order of magnitude above the configured one. The two are not comparable, and reading a `serial` number as latency is what made gotchoices/sereus#13 report a 10 ms breaking point that does not exist. The sweep behind the committed 10 ms (MEASURED_ON 2026-09-20, one Windows machine, four nodes in one process over the loopback dedicated relay):

| per-frame delay | `pipelined` — constant one-way latency | `serial` — per-socket frame-rate cap |
| --- | --- | --- |
| none (counters only) | passes in 3.5 s; 4,735 outbound frames over 4 dialed sockets, busiest socket 2,192 | — |
| 1 ms | — | fails: joiner's membership rows miss the scenario's 20 s join gate |
| 2 ms | — | fails: `StrandAwaitingFirstSyncError`; worst observed send wait 2,358 ms |
| 5 ms | — | fails: `StrandAwaitingFirstSyncError` |
| 10 ms | passes in 9.3–12.4 s over four runs; worst observed send wait 131–315 ms | fails: `StrandAwaitingFirstSyncError`; worst observed send wait 2,274 ms |
| 50 ms | passes in 24.6–31.8 s over two runs; worst observed send wait 128–153 ms | — |
| 100 ms, 150 ms | first sync completes; joiner's membership rows miss the 20 s join gate | — |

Reproduce any row with `WS_SEND_DELAY_MS=<ms> WS_SEND_DELAY_MODE=<mode> yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e`, or with `WS_FRAME_STATS=1` for the counters-only row. `WS_SEND_DELAY_MS` pins the whole process, so the committed 10 ms arm's own request is logged and ignored and both tests in that file run at the delay you asked for.

**Read the right line.** The environment path has no end-of-run hook — vitest recycles its forked workers rather than exiting them, so neither `exit` nor `beforeExit` output reaches the terminal — and the fixture therefore reports on a 5 s timer. Every one of those lines is a RUNNING SUBTOTAL, and a scenario that finishes inside one tick prints none at all. Exact totals come only from a boundary something in the process declares, and under `WS_FRAME_STATS=1` this file has one: the committed latency arm's `installWsLatency` prints the accumulated counters immediately before zeroing them, and its `restore()` prints that arm's closing line. So the first summary after the loopback test passes is the baseline total, and the last line of the run is the 10 ms arm's total. Do not filter the run down to one test with `-t` when you want a total — that removes the only boundary in the file.

Measured that way on 2026-09-21 (same machine, two runs), the baseline is 11,939 and 12,531 frames and the 10 ms `pipelined` arm 12,200 and 13,760 — so on this hardware the delay does NOT multiply the frame count. That does not match the 4,735-frame baseline in the row below, and the two windows are not the same (the boundary-declared one also covers the loopback arm's teardown), so treat any frames-vs-delay RATIO built on the older figure as unconfirmed until it is re-measured at a declared boundary. `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips` carries the ratio claim that depends on it.

Two things that table is not saying. The `pipelined` failures at 100 ms are not a broken strand: the strand becomes writable and the join is still climbing the membership reconciler's retry ladder (1 s doubling to the 30 s poll interval, `strand-membership-reconciler.ts`) when the scenario's deliberately tight 20 s gate expires — slow, and not observed through to completion either way. And the frame count is the multiplier on any per-frame cost, which is why the two modes diverge so sharply on the same scenario; how chatty relayed bring-up is in the first place is a separate question, owned by `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`.

Relay ROUND TRIPS — what one chat-shaped strand operation costs two people who reach each other only through a relay — are measured by `packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts`, which is committed but **opt-in**: without `RELAY_RRT_MEASURE=1` the whole suite is skipped, so `yarn test` never runs it. It exists because the same measurement was written from scratch three times, once per optimystic re-measure, and each copy was deleted afterwards; by the third, a change in the numbers could no longer be told apart from a difference between the throwaway scenarios. Results and their history live in `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`, not here.

```
RELAY_RRT_MEASURE=1 RELAY_RRT_CONFIG=control RELAY_RRT_RUNS=3 yarn workspace @serfab/integration-tests exec vitest run relay-round-trip-measure
```

`RELAY_RRT_CONFIG` selects one or more configurations (comma-separated; all four by default), `RELAY_RRT_RUNS` repeats each of them as separate runs — separate nodes, separate relay, which is the only way to see run-to-run spread — and `RELAY_RRT_REPS` / `RELAY_RRT_DELAY_MS` override a configuration's repetitions and its injected one-way delay. Each run prints one line per operation and then a per-operation table of ranges, which is the form the tickets quote.

| Configuration | Joiner's profile | A's link | What it measures |
| --- | --- | --- | --- |
| `config1` | `transaction` | counting proxy | The per-operation baseline: time, streams opened per protocol per side, and direction changes on A's link, for an insert from each side and four reads. |
| `delayed` | `transaction` | counting proxy, 150 ms each way | The same operations with a round trip that costs 300 ms — what a phone on a real link pays per consensus round. |
| `config2` | `storage` | direct | Concurrent insert pairs with a storage-profile joiner, the shape that used to produce `TornActionError`, plus a sequential pair as its yardstick. |
| `control` | `transaction` | direct | `config2`'s control: the same pairs with both parties `transaction`, so a difference can be attributed to the profile rather than to concurrency. |

Two instruments back it, both reusable from `src/harness/`. `counting-proxy.ts` is a TCP proxy in front of the relay's WebSocket port that counts direction changes ("exchanges") and can delay each chunk, together with the connection gater that refuses direct dials to the relay's real port — without that gater the measured party opens a second connection straight to the relay and the counters go quiet, which the scenario's one assertion checks for. Unlike `ws-latency.ts` it is per-link, so ONE party can be slow while the other is not. `stream-counter.ts` counts the streams each node opens, per protocol, leaving out libp2p's own upkeep and FRET's.

Nothing in that file asserts a count or a duration, deliberately: a budget would have to be re-pinned on every optimystic change, which is the opposite of what the file is for. Operation failures are recorded and printed rather than thrown, because an error rate is part of the measurement.

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

Both of those check what the guard *does*. What checks that it is switched **on** is
`scripts/check-stale-build-guard-wiring.mjs` (`yarn check:stale-build-guard-wiring`, chained into
root `yarn typecheck`). Deleting the one `globalSetup: ['./test/global-setup.ts']` line from a
package's vitest config used to switch the guard off silently: the setup file stays on disk, stays
type-checked, and stays imported by that package's `build-targets.spec.ts`, so no lint rule and no
test failed — the suite simply went back to reporting green about code it never ran, which is the
exact failure the guard exists to prevent. The gate walks each package for modules whose **import
specifier** names `build-freshness` (so a config or comment that merely mentions it is not mistaken
for a use), asks Vitest itself which `globalSetup`/`setupFiles` it would execute (`createVitest`, so
a computed or multi-project config is handled like a literal array rather than scraped as text), and
fails naming the package and the line to restore. Nine packages own such a module today.
`scripts/check-stale-build-guard-wiring.test.mjs` (`yarn test:stale-build-guard-wiring`, chained into
root `yarn test`) proves it catches the drift rather than merely passing today — the unwired case,
the never-used case, and the mentions-it-in-prose false positive.

**What that gate cannot catch:** a package that gains a `workspace:`/`link:` dependency and never
writes a setup module at all — `cadre-provider`'s case above. It is driven by the module existing,
so there is nothing for it to compare against when there is none.

### When it fires because a sibling's own runner is mid-ticket

`../optimystic` and `../quereus` run ticket automation of their own, and while it is working, their
`src` is newer than their `dist` continuously. The guard then aborts **every** guarded suite here —
7 of 9 packages — in global setup, so `yarn test` and `yarn check` fail without running a single
test. The message names the sibling and says to build it.

**Do not follow that remedy while the sibling's runner is active.** Building mid-ticket compiles a
half-finished change into the `dist` this repo measures against; for `../quereus` that is
`core/database.ts` and the planner, which is exactly what the control-database scenarios exercise.
A green or red result obtained that way describes nothing that will ever be published.

Check before building:

```bash
ls ../quereus/tickets/.in-progress ../optimystic/tickets/.in-progress   # absent = idle
git -C ../quereus status --short                                        # clean = between tickets
```

Only when a sibling is both idle and clean is its tree worth building. This matters most before a
release measurement, where the whole point is to describe code someone can install.

## Type-check coverage

`yarn typecheck` (root) fans out to **every** TS workspace. Each package defines a `typecheck`
script (`tsc --noEmit`) so type validation does not depend on the slower `yarn build`, and test
files are type-checked where possible (vitest itself never type-checks).

- Every TS package has a `typecheck` script; `yarn typecheck` validates all 9 workspaces.
- Every package that **has** a `vitest.config.ts` also has that file inside its `typecheck` program, so a
  Vitest option the installed version no longer recognizes fails `yarn typecheck` instead of sitting
  silently unused (this bit once: a `test.poolOptions.forks.singleFork` removal in Vitest 4 went
  unnoticed for a whole major-version upgrade — the setting was ignored and scenario files ran in
  parallel despite binding real network ports; now expressed as top-level `pool: 'forks'` +
  `fileParallelism: false`).
  Covered via `tsconfig.typecheck.json` (`cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`,
  `quereus-plugin-sereus`, `integration-tests`) or the package's main `tsconfig.json`
  (`reference-app-ns`, `reference-app-rn`, `reference-app-web`).
  Verified by injecting an unknown key into each of the nine configs and confirming `TS2769
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
  - The six `tsconfig.typecheck.json` files are near-identical (`extends ./tsconfig.json`, widen `rootDir`,
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
- **cadre-core's default entry must load in a browser and in React Native** (checked by app builds, not by lint or `yarn test`): Node-only code (`node:fs`, `node:crypto`, `node:http2`, …) lives behind the Node-only subpaths in cadre-core's `package.json` `exports` (`./key-store-file`, `./push-node`, …), never in the graph the `.` entry reaches, dependencies included. The only checks over that whole graph are `vite build` in `reference-app-web`, `yarn workspace @serfab/reference-app-rn test:bundle` and `yarn workspace @serfab/reference-app-ns test:bundle`; none of them runs under a root gate. NOTE: this broke once (a dependency's entry that read `fs` / `path` at load) and was caught only by the web build; if it breaks again, add a root-gate bundle check of cadre-core's `.` entry rather than another single-import lint rule.
- **Babel helper floor for React Native** (enforced by a test, not by lint): Metro compiles async generators with Babel's `wrapAsyncGenerator` helper. In `@babel/runtime` / `@babel/helpers` before 7.29.2, when a consumer stops early (`break` or `return` inside `for await`) the helper drops everything in the generator's `finally` after its first `await`; on the phone that left Quereus's execution lock held and strand founding hung. `reference-app-rn` declares `@babel/runtime` `^7.29.2`, and its `metro-babel` Vitest project (`test/metro-babel/async-generator-cleanup.spec.ts`) compiles an early-exit probe with the app's own Metro Babel transformer, runs it against every `@babel/runtime` on Metro's `nodeModulesPaths` and against the helper `@babel/core` inlines from `@babel/helpers`, and fails with the upgrade command if the cleanup is dropped. That project has no stale-build guard, so `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel` runs it while a linked sibling's `dist` is stale (a full `vitest run` stops at the `node` project's guard first). Quereus from `ac4b72bc8` on (not the published 4.19.0) also throws `UNSUPPORTED` naming the upgrade when the broken helper is loaded.
- **Hermes polyfills for React Native** (also a test, not lint): `reference-app-rn/polyfills/hermes.js` supplies the web APIs Hermes lacks that libp2p reads — `AbortSignal.timeout` / `any`, abort reasons, `WebSocket.prototype.bufferedAmount`, `Promise.withResolvers`, `TextDecoder`, `structuredClone` and the rest. Deleting any of them used to break nothing in the repo and everything on a phone, and the worst case was silent: no `bufferedAmount` means `@libp2p/websockets` reads `undefined`, decides the socket is full, and every dial dies on its timeout with no indication why. The `polyfills` Vitest project holds these two specs, plus `test/polyfills/reload-reason.spec.ts` for the development-only reload logger described in [`docs/reference-app-rn.md`](reference-app-rn.md) § Device test runs. `test/polyfills/hermes-polyfills.spec.ts` evaluates the polyfill file in a controlled scope against a fake Hermes + React Native global surface — including the real `abort-controller` classes React Native installs — and drives `@libp2p/websockets`' own `webSocketToMaConn` over a socket with no `bufferedAmount`. `test/polyfills/dependency-globals.spec.ts` is a drift guard: it reads a listed set of dependency `dist` trees as text and fails when a global that neither React Native nor `polyfills/` provides starts appearing; it is a substring search over a hand-listed set of packages, so it narrows the window rather than closing it (its header says what it cannot see). Like `metro-babel`, the project carries no stale-build guard, so `yarn workspace @serfab/reference-app-rn vitest run --project polyfills` runs while a linked sibling's `dist` is stale. What neither can do is see the real engine — `polyfills/audit.js` prints a `native` / `polyfilled` / `gap` / `MISSING` table at boot under `__DEV__` for that. See [`docs/reference-app-rn.md`](reference-app-rn.md) § Key Dependencies.
- Scope notes: type-aware linting (`projectService`) is enabled only for the node/library `src` trees;
  the bundler/expo apps (`reference-app-web`, `reference-app-rn`, `cadre-host/ui`) get non-type-aware rules.
  `maestro/` (Maestro JS engine) and non-package trees (`tess/`, `ops/`,
  `scripts/`) are ignored. The `scripts/` ignore is `**/scripts/**`, so it covers each package's own
  build and release scripts too (`quereus-plugin-sereus/scripts/build-browser.mjs`,
  `cadre-host/scripts/sign-manifest.mjs`, the app `run-e2e.mjs` runners): edits to those are
  human-reviewed, not linted.

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
- RESOLVED (tripwire opened 2026-08-03, closed 2026-09-08): `@optimystic/db-p2p-storage-fs` used to be
  the one optimystic package *not* in root `resolutions`, so it resolved from npm while its eight
  siblings resolved to `../optimystic`, and the gate — which only checks `link:` targets — said nothing
  about its declared range. The history says drift, not intent: fs entered the tree in `da5d105`, a
  25k-line commit, *before* the one-`link:`-per-new-dependency habit that added `storage-rn`, `-web`
  and `-ns` each in its own commit. It now has a `link:` entry like the rest, which makes 10 linked
  packages and puts its range under this gate. Two consequences to keep in mind: local edits to that
  package are now visible to `cadre-cli` / `cadre-core` / `quereus-plugin-sereus` (previously they ran
  the registry build), and it had to be added to those suites' stale-build `TARGETS` — `cadre-cli`'s
  `build-targets.spec.ts` failed on exactly that until it was. `yarn smoke:published` is unaffected: its
  scratch project lives under the OS temp dir and installs with npm, so root `resolutions` never reach it.
- `yarn upgrade:optimystic` / `yarn upgrade:quereus` (npm-check-updates) rewrite the declared ranges,
  then `yarn install` and re-run this gate; run them when the sibling workspace is bumped, not only at
  release time. The gate is chained on because `ncu` upgrades each dependency independently and reports
  nothing when it leaves one behind — a registry `latest` tag that has not propagated, or a transient
  fetch failure, silently yields a partial upgrade (2026-09-07: every `@optimystic/*` range moved to
  `^0.29.0` except `@optimystic/db-core`, which stayed `^0.28.0` in five packages). The gate turns that
  into a failure naming each stale range and its suggested edit, for every package with a `link:`
  resolution — which, since the entry above was closed, is every `@optimystic/*` this repo depends on.
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
  `FileRawStorage` that makes the restart cross real files rather than a shared heap object), and it
  comes from the registry here like every other scratch-project dependency — the scratch project is
  outside this repo and installs with npm, so the `link:` resolution fs gained on 2026-09-08 does not
  reach it — and `@libp2p/crypto` + `@libp2p/peer-id` for
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

## Browser bundle checks (`@serfab/quereus-plugin-sereus`)

Two specs in the package's `unit` project guard the prebuilt `dist/plugin-browser.js`, the file Quoomb-web's worker fetches and loads. Both build it on demand if it is missing.

- **`test/browser-bundle.spec.ts` reads the file as text**: it parses as ESM, carries no static import of `@libp2p/tcp` or of a listed set of Node-only modules (`node:fs`, `node:net`, …), has a source map beside it, and stays under a raw and a gzipped size cap.
- **`test/browser-shape.spec.ts` loads it** under jsdom with `fake-indexeddb`: the default export is a function, and calling it reaches the IndexedDB open before failing on libp2p. It does not touch the network, and nothing here loads the bundle in a real browser worker.
- **The size caps are ceilings only, set about 20% above the last measurement.** They carry no anti-vacuity floor of the kind the budget assertions above have, because a bundle that collapsed to a stub would fail the ESM parse and the shape test long before a floor saw it. The measured bytes, the date and the command live beside the constants in the spec; a copy here would go stale. A cap that sits far above the artifact cannot fire — the previous 8 MiB / 3 MiB caps let the unminified file grow from about 2.5 MiB to 4.66 MiB without a failure — so re-measure and tighten them when the bundle's size changes on purpose, rather than leaving the slack.
- **The bundle is built minified** (`minify: true` in `scripts/build-browser.mjs`) and the caps are set against that build, so turning minification off makes the file more than twice as large and fails both caps. The source map beside it embeds the original sources, so a minified bundle still resolves in devtools. Minification does not merge the duplicate copies of shared dependencies that the linked sibling checkouts pull in; that is a dependency-deduplication problem, not something a cap or a build flag here fixes.
- **The caps are the only guard on the published payload's size.** `scripts/publish-package.mjs` runs `yarn build` and ships that `dist/`, so the artifact the spec measures is the artifact users fetch. `yarn smoke:published` (above) installs the packed tarball and cannot see inside a bundle that was built before packing.
- **The shape test imports the bundle through Node, not through vitest's transform.** The `unit` project lists it under `server.deps.external` in `vitest.config.ts`. Left to vitest, the multi-megabyte file is run through Vite's transform on every run (and its much larger source map is read), which took 8-18 s on an idle machine, grew with the file's byte count, and timed out the test's 30 s budget under load. Externalized, the import is a plain Node load — a fraction of a second warm, a second or two on a cold file cache — and no longer scales with the file's size. If this test turns slow, check the externalization before raising the timeout.

## Topology coverage map

Which network shapes the integration suite (`packages/integration-tests/src/scenarios/`)
actually exercises, so a missing shape is visible instead of sitting unnoticed. A map, not a
status board — no pass/fail state here; that lives in the suites and in `tickets/` (see above).
Each line names one shape and a scenario that exercises it, not every scenario of that shape;
scenarios whose subject is a protocol or a service rather than a network shape are not listed.

- Single machine, control plane only — `control-write-while-alone-convergence.integration.ts`.
- Two-machine party, control plane (both write orderings) — `control-db-two-node-convergence.integration.ts`,
  `control-write-degraded-cohort-member.integration.ts`.
- Three-machine party, control plane — `control-cohort-three-node-isolation.integration.ts`,
  `harness-party-control-cohort.integration.ts` (the `TestParty` star world).
- One party, two machines, one strand — `websocket-chat.integration.ts`,
  `convergence-stress.integration.ts`, `strand-addr-seed-convergence.integration.ts`,
  `strand-late-cadre-join.integration.ts` (join-after-founding ordering).
- Cross-party strand, one machine per party (two and three parties) — `strand-formation-e2e.integration.ts`,
  `strand-membership-closed-strand-e2e.integration.ts`, `rbac-signed-write.integration.ts`,
  `multi-party-workflows.integration.ts`. All of those reach the strand mesh by dialing one
  party's strand node at the other **by hand**, because each forms through a mock provisioner
  on an unbound invitation and so has no live host strand to learn an address from. The one
  scenario that reaches it with **no hand-dial** is
  `strand-formation-cross-party-seed.integration.ts`: the host founds its strand before
  publishing an invitation bound to it, so the formation result carries the host's live
  strand addresses and the joiner's seed comes from the handshake alone. Loopback addresses
  there; the same no-hand-dial handshake over a RELAY is `blind-relay-phone-to-phone-e2e`
  (see the relay lines below).
- Cross-party, multi-machine parties, control plane only (two parties, each an owner plus a
  drone; no cross-party strand transport) — `multi-party-sync.integration.ts`. Same machine
  layout as the four-machine strand line below, stopping where that one starts.
- Two separate libp2p networks in one process (a party's network plus a standalone node,
  over TCP rather than the suite's usual WebSocket) — `deliver-seed-cross-network.integration.ts`.
- Cross-process nodes (real `@serfab/cadre-cli` child processes launched the way the installer
  and the provider launch them) — `cadre-host-node-donation.integration.ts` (a host donating a
  node into a second, externally-founded party), `cadre-host-owner-node.integration.ts`,
  `provider-seed-accepted.integration.ts` and `cadre-host-donation-phone-requester.integration.ts`
  (the bullet below); the identity/bootstrap/store fixtures the first three share
  live in `child-node-fixtures.ts`.
- Node donation to a requester that **cannot be dialed** (the phone direction) —
  `cadre-host-donation-phone-requester.integration.ts`. Same host-side machinery as
  `cadre-host-node-donation.integration.ts`, but the requester is an in-process `CadreNode`
  in the shape `reference-app-rn` runs: `listenAddrs: []`, WebSocket and circuit-relay
  transports only, no TCP, its own party owner. It provisions with `bootstrapNodes: []`,
  dials the lent node's `/ws` address itself, and keeps that connection across a node
  respawn (same WebSocket port) and across its own restart (same identity key, control
  storage and node-local dial-target store, and no second donation request). It is the only
  scenario that proves the dial-in direction end-to-end; the two prerequisite halves are
  unit-tested in `cadre-host` and `cadre-core`. Strand replication onto a lent node is
  deliberately not asserted — see
  `tickets/blocked/always-on-nodes-host-strands-of-apps-they-do-not-run.md`.
- Relayed control plane (a control node with no inbound reachability of its own, reserving a
  circuit-relay slot on a sibling and being dialed through it) —
  `relay-only-control-addr.integration.ts`. The control plane only; the strand plane is the
  line below.
- Relayed strand plane, one party, both machines relay-only (neither `CadreNode` listens at
  all; a dedicated ungated relay — `harness/dedicated-relay.ts`, the loopback stand-in for the
  `ops/docker/libp2p-infra` container — carries the control mesh, the strand-addr RPC, and the
  strand mesh, with App rows replicating both ways over the circuit) —
  `strand-circuit-same-party-e2e.integration.ts`. It also measures the relay-slot cost (one
  reservation per node per network) and characterizes relay restart: control reservations
  recover, strand reservations do not (ticket
  `bug-strand-relay-reservation-not-resupervised`). Every connection here is loopback-instant:
  the LINK CONDITION is covered only on the cross-party line below. Same party; the
  cross-party half is that line.
- Relayed strand plane ACROSS parties (two parties, each a single relay-only machine,
  sharing one CLOSED strand through the same dedicated relay: the bound invitation carries a
  `/p2p-circuit` bootstrap address, the stranger-open formation protocol runs over the
  circuit and hands back a relay-routed strand address plus the membership secret, the
  joiner meshes from that seed with no hand-dial, rows replicate both ways, and every
  cross-party connection — control and strand — classifies `relayed` and unlimited) —
  `blind-relay-phone-to-phone-e2e.integration.ts`. It runs the whole journey TWICE from one
  body: once on bare loopback, and once with 10 ms of one-way per-frame link latency
  (`harness/ws-latency.ts`, `pipelined` mode — see "Where measurements live" above for what
  that mode means and why a number quoted without it is misleading). That second arm is the
  suite's ONLY relayed coverage of a link that is not instant; every other line on this map,
  relayed or direct, runs at loopback speed. The injected delay is process-wide, so both
  parties are equally slow — the asymmetric shape (a slow phone talking to a fast desktop) is
  uncovered, ticket `debt-relay-scenarios-never-see-link-latency`. One SHARED relay only; the
  two-relay shape (each party reserved on a different relay) is not covered.
- Harness self-coverage of the topology builder — `harness-topology.integration.ts`.
- Cross-party strand with multi-machine parties (two parties × two machines: four machines,
  the strand replication breadth — a write still commits with one machine off, and the
  machine catches up when it returns) — `strand-two-party-two-machine.integration.ts`. It
  asserts the commit, not the cohort width: whether the surviving three approved as 3-of-4
  or as a downsized 3-of-3 is not distinguished there.
- Membership actions issued from a party's second machine on that shape (a closed strand's
  invite consumed, both of a party's machines registered as devices of ONE member, and a
  promoted manager issuing/admitting — all authored on a machine that neither founded the
  strand nor owns its party) — `strand-membership-second-machine.integration.ts`. Visibility
  claims only; the physical story for the shape stays with the line above.
- Removal ENFORCED at the network layer (a closed strand's removed party is hung up by the
  remaining machines, both of its machines at once; a machine that has not yet processed the
  removal deliberately keeps serving it; the remaining cohort still commits and the removed
  party can neither read that write nor push one back; a removed node learns from its own
  poll that it was removed; an open strand on the same two nodes is untouched) —
  `strand-removal-cuts-network.integration.ts`. Every connection there is DIRECT: the
  relay-mediated variant — a removed party reached over `/p2p-circuit`, where `hangUp` must
  also drop the relay reservation riding the connection — is **uncovered**, and would need
  the relay-only two-party fixture of `blind-relay-phone-to-phone-e2e.integration.ts` rather
  than an option on this topology. That file also registers its `Strand.MemberPeer` rows by
  hand — written before production wrote any; every machine now registers its own
  automatically at bring-up (`strand-membership-reconciler.ts`), so the hand registrations
  there stand in for machines, not for a missing mechanism. The same claims on rows
  production wrote are the line below.
- The whole journey on production-written rows (two real parties meet over the formation
  handshake; the runtime issues, redeems and seats the joining party's membership and binds
  each of its machines with no `issueInvite` / `consumeInvite` / `registerMemberPeer` call in
  the test; removing that party then cuts both of its machines, the remaining cohort still
  commits, and the removed party can neither read that write nor push one back) —
  `strand-party-removal-via-formation-e2e.integration.ts`. Its second test covers re-joining
  after a removal: a fresh formation still succeeds (it runs on the control network) and
  reuses the party's identity, but the invitation is never spent — the joiner's membership
  reconciler latched `done` during the first join and nothing re-arms it, so no pass even
  attempts the redemption. Read the comment at that test's negative assertion before citing
  it: it pins that outcome and the stopped-loop cause, and deliberately does NOT show the
  denial-of-the-strand-write cause sitting behind it. Re-admission has to be authored by a
  remaining manager — `backlog/bug-removed-party-cannot-redeem-its-way-back`. Connections here are DIRECT too;
  the relay-mediated variant stays uncovered, as above.
- **Uncovered**: medium private network — ticket `feat-scenario-medium-private-network`.
- **Uncovered**: public open strand network — ticket `feat-scenario-public-open-strand-network`.
- **Uncovered**: the two-relay circuit shape — each party holding its reservation on a
  DIFFERENT relay, so the path between them crosses relay boundaries. Both relay scenarios
  above share one relay. Ticket `feat-scenario-two-relay-circuit`.

All scenario paths above are relative to `packages/integration-tests/src/scenarios/`
(harness fixtures live in `packages/integration-tests/src/harness/`). Sizing a new topology
scenario's hook timeouts (bring-up cost is roughly linear in machine count, and every strand
member is a second libp2p node) — see the `TIME BUDGET` note at the top of
`packages/integration-tests/src/harness/topology.ts`.

NOTE: this map is hand-maintained; nothing checks its scenario paths or ticket slugs, so a
renamed scenario or a landed ticket leaves a stale line until someone next touches the section.
Fine while it is a few dozen scenarios and a reader checks the path they care about; if it
starts being read as authoritative, or the stale lines outnumber the live ones, generate the
covered half from the scenario directory instead.
