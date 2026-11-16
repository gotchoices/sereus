# Gates

What each automated check in this repository covers, what it cannot catch, where its exemptions are kept, and the script that implements it. For contributors deciding whether a check protects a change, and for anyone adding or loosening one. The mechanics of each check are documented in the header of its script.

Related: [testing.md](testing.md) (how to run the checks and what a ticket owes), [releasing.md](releasing.md) (the checks that install published packages), [topology-coverage.md](topology-coverage.md).

| Root command | Checks it runs |
|---|---|
| `yarn lint` | [Lint coverage](#lint-coverage), [Documentation](#documentation) |
| `yarn typecheck` | [Type-check coverage](#type-check-coverage), and the wiring half of the [Stale-build guard](#stale-build-guard) |
| `yarn dep-check` | [Dependency-check coverage](#dependency-check-coverage), [Declared dependency ranges](#declared-dependency-ranges) |
| `yarn test` | [Stale-build guard](#stale-build-guard), [Tests that did not run](#tests-that-did-not-run), [Browser bundle checks](#browser-bundle-checks), [Checks that run as tests](#checks-that-run-as-tests), and the unit tests of every script named here |

Each script in `scripts/` that implements a check has a companion `*.test.mjs` beside it, run by `yarn test`, that points the check at fixture workspaces and confirms it fails when it should.

## Lint coverage

**What it checks.** `yarn lint` runs ESLint from the repository root against one flat config, `eslint.config.mjs`, over the TypeScript sources, the JavaScript tooling files and the Svelte UIs of every workspace. Every rule the config sets is at `error`. There is no `warn` level, so no backlog of ignored warnings can build up. `yarn lint:fix` applies the automatic fixes.

The config encodes the style rules of `AGENTS.md`:

| Project rule | ESLint rule | Limit |
|---|---|---|
| Avoid `any` | `@typescript-eslint/no-explicit-any` | |
| Prefix an unused promise call with `void` | `@typescript-eslint/no-floating-promises` | Needs type information, so it covers the `src` trees of seven packages only. |
| Prefix unused arguments with `_` | `@typescript-eslint/no-unused-vars` | |
| Brace a `case` block that declares | `no-case-declarations` | |
| ES modules | `@typescript-eslint/no-require-imports` | TypeScript files only; the JavaScript tooling files may use `require`. |
| No inline `import()` | `@typescript-eslint/consistent-type-imports` | Type positions only. |
| Do not swallow exceptions | `no-empty` | Catches an empty `catch` block only. |

It also enforces four rules from ESLint's recommended set (`prefer-const`, `preserve-caught-error`, `no-useless-assignment`, `no-control-regex`) and two Svelte rules (`svelte/no-at-html-tags`, `svelte/prefer-svelte-reactivity`).

**What it cannot catch.**

- **Trees the config ignores.** `ops/`, `tess/`, the root `scripts/` and every package's own `scripts/` directory (build, signing and end-to-end runner scripts), and the Maestro flow helpers of `reference-app-rn`. Edits there are reviewed by a person (ticket `debt-tooling-scripts-unlinted-and-unchecked`).
- **Floating promises outside the type-aware scope.** The rule runs on the `src` trees of `cadre-core`, `cadre-cli`, `cadre-host`, `cadre-provider`, `config-check`, `quereus-plugin-sereus` and `integration-tests`. `cadre-rn`, the three reference apps, `cadre-host/ui`, every package's `test/` tree and `test-harness/` get only the rules that need no type information.
- **Indentation.** Tabs are left to `.editorconfig`, so that ESLint and an editor's formatter never apply conflicting indentation.
- **Two style rules**, described under [Rules left to human review](#rules-left-to-human-review).

**Where exemptions live.** At the site, as an `eslint-disable-next-line` comment that states its reason. `reportUnusedDisableDirectives` is set to `error`, so a directive that no longer disables anything fails the gate. The few file-level exemptions are the last `no-restricted-syntax` entries in `eslint.config.mjs`.

**Script.** `eslint.config.mjs`; the root `lint` script.

### Project guards

One `no-restricted-syntax` rule carries four sets of selectors that protect invariants of this codebase. Each is a constant in `eslint.config.mjs`, whose comment gives the full reasoning.

| Constant | Where it applies | What it flags | What to write instead |
|---|---|---|---|
| `CADRE_PEER_WRITE_GUARD` | All TypeScript | Literal SQL that inserts into, updates or deletes from `CadreControl.CadrePeer` | The `ControlDatabase` writers, which refresh the membership snapshot a node admits control traffic by |
| `PHONE_RUNTIME_GUARD` | Package `src` trees, the phone apps' `app/` routes, `cadre-host/ui/src` | `AbortSignal.timeout`, `AbortSignal.any`, `Promise.withResolvers`, `new DOMException` | An `AbortController` with a timer, an explicit signal relay, a hand-built promise triple, a named `Error` |
| `THROWN_DESCRIPTION_GUARD` | `src` and `app/` of the packages that depend on cadre-core | `x instanceof Error ? … : String(x)` and `new Error(String(x))` | `describeThrown`, or `toError` inside cadre-core |
| `LINK_DEADLINE_GUARD` | `packages/cadre-core/src` | A value named `…TIMEOUT_MS`, `…BUDGET_MS` or `…DEADLINE_MS` (any case) set to a number or to arithmetic over numbers | A deadline derived from `link-budget.ts`, or a classified exemption |

The reasons, in the table's order: a raw `CadrePeer` write skips the snapshot refresh, and the node then refuses control traffic from the member it just approved. Hermes and NativeScript's V8 lack or mis-implement the four web APIs, and the polyfills exist for dependencies. `String()` turns a thrown value that is not an `Error`, such as a React Native WebSocket error event, into `[object Object]`. A relayed exchange costs a fixed number of round trips, so a deadline fixed in milliseconds fails on a slow enough link ([deadlines.md](../network/deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds)).

What the guards miss:

- **`CADRE_PEER_WRITE_GUARD`:** SQL assembled from variables, and a statement that omits the schema name.
- **`PHONE_RUNTIME_GUARD`:** the script blocks of `.svelte` components. `AbortSignal.prototype.throwIfAborted()` is deliberately allowed, because libp2p requires it on every runtime.
- **`THROWN_DESCRIPTION_GUARD`:** `${err}`, `'' + err`, a bare `String(err)` outside a conditional, the packages' `test/` trees, and `cadre-host/ui`.
- **`LINK_DEADLINE_GUARD`:** a deadline under another name (`…_WAIT_MS`), an inline `setTimeout(…, 5000)`, and every package other than cadre-core.

A flat-config entry that sets `no-restricted-syntax` replaces the selectors of earlier entries for the files it matches. A new selector set must therefore be added to every scope that should carry it, and a single allowed use is exempted at its site: a config-level exemption would remove the other guards from that file too.

### Link-deadline directive grammar

A deadline in cadre-core that stays a number carries a disable directive whose reason starts with one of four fixed phrases. The phrases make each class one search.

```ts
// eslint-disable-next-line no-restricted-syntax -- link-independent: <why>
// eslint-disable-next-line no-restricted-syntax -- link-bound, not yet derived: <ticket slug>
// eslint-disable-next-line no-restricted-syntax -- cuts off by design: <why>; see <doc section>
// eslint-disable-next-line no-restricted-syntax -- measured, not derived: <where the measurement is>
```

- **`link-independent`:** the deadline never waits on another machine.
- **`link-bound, not yet derived`:** it does wait on the link, and the named open ticket owns converting it. Converting the site means deleting the directive too, which the unused-directive check enforces.
- **`cuts off by design`:** it waits on the link through an Optimystic read or commit, but its value is what its caller can tolerate, so it must not grow with the link. The sites are listed in [deadlines.md](../network/deadlines.md#deadlines-over-optimystics-reads-and-commits).
- **`measured, not derived`:** it waits on the link but bounds a whole phase of many exchanges, with no round-trip count to derive from. It is sized from the measurement the directive names, and is measured again, not recomputed, when a number under it changes.

### Rules left to human review

Two `AGENTS.md` rules have no machine check. A reviewer enforces them.

- **Lowercase SQL reserved words.** SQL in this codebase lives inside string and template literals, often with interpolated parts. ESLint sees a literal as opaque text, and checking keyword case would need a SQL parser run over fragments that are not complete statements.
- **No runtime inline `import()` unless the module is loaded dynamically.** No ESLint rule separates a deliberate dynamic load from an inline import written for convenience. `consistent-type-imports` covers the type-position form only.

## Type-check coverage

**What it checks.** `yarn typecheck` runs every workspace's `typecheck` script (`tsc --noEmit`), test files included. It then runs three coverage checks, because Vitest strips types and never type-checks what it executes:

- **Every `vitest.config.*` is inside its package's type-check program.** Vitest silently ignores an option it does not recognise, so a setting removed by a Vitest upgrade would otherwise stop applying without any failure.
- **Every test file Vitest collects, and every `setupFiles` or `globalSetup` module it executes, is inside that program.** The file list comes from Vitest itself, so nested `projects` and a spec collected from outside the package are handled.
- **Every stale-build guard module is wired in**, described under [Stale-build guard](#stale-build-guard).

Two packages have a wider or narrower program than the rest. `config-check` compiles with `"types": []` and no DOM library, so a `node:` import or a `NodeJS.*` type fails: the package must run on every runtime. `cadre-host` runs a second `tsc` pass over `ui/tsconfig.json`, which covers the UI's TypeScript test files.

**What it cannot catch.**

- **`.svelte` files.** `tsc` cannot check them. `yarn check:svelte` runs `svelte-check` in `cadre-host` and `reference-app-web`, and no gate runs that command.
- **`reference-app-web`'s Playwright specs.** They are checked by that package's `typecheck:e2e` script, which is chained into its `build`. `yarn build` covers them; `yarn typecheck` does not.
- **JavaScript test files.** The test-file check looks only at TypeScript extensions, because a `.js` file cannot be inside a `tsc` program without `allowJs`. A `.js` test would pass unchecked.
- **Setup modules inside `node_modules`.** They are a dependency's code.

Each package's `tsconfig.typecheck.json` is a near copy of the others, and there is no shared base config. If a compiler option has to change in all of them at once, introduce a root base config then.

**Where exemptions live.** `scripts/test-typecheck-allowlist.json`, keyed by package name. Each entry carries a written `reason` and exact file paths, without globs. The check validates the list: an entry for a file that is no longer collected, or that is already inside the program, fails the gate, so a fixed package fails until its entry is deleted.

**Script.** `scripts/check-vitest-typecheck-coverage.mjs`, `scripts/check-test-file-typecheck-coverage.mjs`, and their shared `scripts/lib/typecheck-programs.mjs`.

## Dependency-check coverage

**What it checks.** `yarn dep-check` runs [knip](https://knip.dev) from the root against `knip.ts`, then the range check in the next section. Knip reports unused dependencies, imports of packages a workspace does not declare, and unresolved imports and binaries, in every workspace. Those classes fail the gate.

- **Dead code does not fail it.** Unused files, exports and types are set to `warn` in the `rules` block of `knip.ts`: they are printed and the gate stays green (ticket `dead-code-cleanup-and-knip-gate`).
- **The three reference apps must declare everything they import.** They set `installConfig.hoistingLimits: "workspaces"`, which gives each its own `node_modules`, so an import that works elsewhere through root hoisting does not resolve there.
- **Knip should print no configuration hints.** A hint means `knip.ts` carries an exemption that is no longer needed. Remove the exemption.

**What it cannot catch.** Anything reached by a string instead of an import. NativeScript resolves pages by name, the integration harness spawns child scripts by path, and several packages resolve a dependency at run time. Each case is declared in `knip.ts` as an `entry` or an `ignoreDependencies` item. The NativeScript entry is the glob `app/**/*-page.ts`: a page file named differently falls outside it, and knip then analyses less of that app without failing. The root workspace ignores `tess/`, `ops/`, `docs/` and `scripts/`.

**Where exemptions live.** `knip.ts`, each with a comment giving its reason.

**Script.** `knip.ts`; the root `dep-check` script.

## Declared dependency ranges

The root `package.json` `resolutions` block links every `@optimystic/*` package and `@quereus/quereus` to a sibling checkout. No suite in this repository therefore runs the version a consumer installs; that version is chosen by the range each package declares. If a declared range falls behind the linked version, consumers install a sibling release older than anything tested here.

**What it checks.** For every `resolutions` entry that is a `link:` target, `yarn check:dep-ranges` reads the linked package's version and fails if a `dependencies`, `peerDependencies` or `optionalDependencies` range in any `packages/*/package.json` does not admit it. The failure names the package, the range, the linked version and a suggested edit. The rule it enforces: raise the declared range in the same change that adopts a newer sibling.

`yarn upgrade:optimystic` and `yarn upgrade:quereus` rewrite the declared ranges with npm-check-updates, install, and run this check. The check is chained on because npm-check-updates upgrades each dependency independently and reports nothing when it leaves one behind.

**What it cannot catch.**

- **Whether the published package works.** The check installs nothing. The [published-package checks](releasing.md#published-package-checks) do.
- **Packages that are not linked.** `libp2p`, `@libp2p/*`, `@multiformats/multiaddr`, `datastore-core` and `uint8arrays` are checked against nothing. Keep them on the versions `../optimystic/packages/db-p2p/package.json` declares, exact pins included; the upgrade scripts do not move them. When they drift, two copies of `@libp2p/interface` appear and `yarn typecheck` fails with TS2322 or TS2345 messages that name both paths.
- **A sibling checkout that is absent.** Its entries are skipped with a printed notice.
- **A second copy of Quereus in a consumer.** The published packages declare `@quereus/quereus` as a regular dependency, including `quereus-plugin-sereus`, which is loaded into a Quereus host. A consumer that pins a Quereus major outside the declared range gets two instances, and `instanceof` checks across them fail. Move the declaration to `peerDependencies` if that happens.

**Where exemptions live.** There are none.

**Script.** `scripts/check-dep-ranges.mjs`.

## Stale-build guard

Suites in this repository run compiled output: a spawned `cadre-cli` child, or an import that resolves to another package's `dist`. That includes the linked siblings, which reach `node_modules` as links to working copies. A source edit that is not followed by a build is invisible to such a suite, which then reports on the previous build.

**What it checks.** Three parts:

- **Freshness.** `assertBuildFresh(targets, setupUrl)` in `test-harness/build-freshness.ts` runs from a package's Vitest `globalSetup` and aborts the run, before any test, when a target's `src` is newer than its build output or its entry file is missing.
- **Target lists.** Each package writes its own list of targets. `test-harness/build-targets.ts` derives from the package manifest which dependencies run from a build that can be redone (`workspace:` ranges and `link:` resolutions), and the package's `build-targets.spec.ts` fails when the list misses one.
- **Wiring.** `scripts/check-stale-build-guard-wiring.mjs`, part of `yarn typecheck`, fails when a module that imports the freshness harness is not among the setup files Vitest will execute for its package. Removing the `globalSetup` line would otherwise switch the guard off with nothing else failing.

Every package that has a Vitest config owns a guard module: ten of the eleven. `config-check` has no suite and is tested through the suites of `cadre-cli` and `cadre-provider`, which guard its `dist`.

Properties to keep when changing the guard:

- **`test-harness/` is not a workspace and is never built.** A compiled shared package would be consumed from its own `dist`, and could be defeated by the staleness it exists to catch. Packages import it by relative path.
- **A dependency that is a real directory, not a link, is skipped.** It was installed from the registry, where file times are packing artifacts and would always read as stale.
- **`assertBuildFresh` requires the caller's `import.meta.url`.** The three reference apps keep their own `node_modules`, and that copy is what their suites load. A default location would check the wrong one.
- **Test files are not build inputs.** Editing a spec does not trip the guard.

**What it cannot catch.** A package that gains a `workspace:` or `link:` dependency and has no setup module at all: the wiring check starts from modules that exist. Each target's entry file is written by hand, so a sibling that renames its entry reads as "not built".

**Where exemptions live.** There is no allowlist. A Vitest project that loads no other package's compiled output is configured without the guard, and can run while a sibling is stale; [Checks that run as tests](#checks-that-run-as-tests) names them.

**Script.** `test-harness/build-freshness.ts`, `test-harness/build-targets.ts`, `test-harness/build-targets-spec.ts`, `scripts/check-stale-build-guard-wiring.mjs`. What to do when the guard aborts a run is in [testing.md](testing.md#a-stale-build-abort-means-stop).

## Tests that did not run

Vitest marks every test under a failed `beforeAll` as skipped. A scenario file whose shared startup throws adds one to `Test Files … failed` and nothing to the failed count on the `Tests` line, where its tests are mixed with the ones skipped on purpose.

**What it checks.** `test-harness/setup-failure-reporter.ts` is a Vitest reporter. After the summary it prints the tests a failed setup hook kept from running, grouped by the suite or file whose hook threw, with the first line of the error. It prints nothing when no setup failed and does not change the exit code.

```
 NOT RUN  7 tests did not run because a setup hook (beforeAll) failed. Count as failed, not skipped.
   src/scenarios/<file>.integration.ts > <suite name> — 7 tests
     Error: <first line of the hook's error>
```

Tests skipped on purpose (`it.skip`, `todo`, a `-t` filter) are not counted, and neither are the tests of a suite whose `afterAll` failed, because those ran. How to record the count is in [testing.md](testing.md#counting-not-run).

**What it cannot catch.**

- **A file that fails to import.** It has no collected tests to name.
- **Which hook threw.** Vitest's reporter interface does not say. A suite in which every test skips itself at run time and whose `afterAll` then throws is reported as not run.
- **A run started with `--reporter`.** The flag replaces the config's `reporters` list, so the block is not printed.
- **Suites other than `integration-tests`.** Only that package lists the reporter. Another package adopts it by adding the file's relative path to its `reporters` after the reporter that prints the summary, and by removing any `--reporter` flag from its scripts.

**Where exemptions live.** There are none.

**Script.** `test-harness/setup-failure-reporter.ts`, listed in `packages/integration-tests/vitest.config.ts`.

## Browser bundle checks

`@serfab/quereus-plugin-sereus` ships a prebuilt browser bundle, `dist/plugin-browser.js`, that a browser host fetches and loads in a worker.

**What it checks.** Two specs in the package's `unit` project; both build the bundle if it is missing.

- **`test/browser-bundle.spec.ts` reads the file as text.** It must parse as an ES module, contain no static import of `@libp2p/tcp` or of a listed set of Node-only modules, have a source map beside it, and stay under a raw and a gzipped size cap.
- **`test/browser-shape.spec.ts` loads it** under jsdom with a fake IndexedDB. The default export must be a function, and calling it must reach the IndexedDB open.

The size caps are ceilings set about 20% above the measured size, and the measurement is recorded beside the constants in the spec. A cap far above the real size never fails, so measure again and tighten the caps whenever the bundle's size changes on purpose. The bundle is built minified and the caps assume that. The caps are the only check on the size of what users download.

If the shape spec becomes slow, check the `server.deps.external` entry in the package's `vitest.config.ts` before raising the timeout. It makes Node load the bundle directly; without it Vitest transforms the whole file on every run.

**What it cannot catch.** Whether the bundle works in a real browser worker or on a network: nothing loads it there. Duplicate copies of a shared dependency inside the bundle show up only as size.

**Where exemptions live.** There are none. The caps are `MAX_RAW_BYTES` and `MAX_GZIPPED_BYTES` in the bundle spec.

**Script.** The two specs; the bundle is produced by `packages/quereus-plugin-sereus/scripts/build-browser.mjs`.

### cadre-core's default entry in app bundles

The `.` entry of `@serfab/cadre-core` must load in a browser and in React Native. Node-only code (`node:fs`, `node:crypto`, `@libp2p/tcp`, …) is kept behind the Node-only subpaths in the package's `exports`, and must not be reachable from the default entry, dependencies included. No lint rule or unit test checks that whole import graph. Three app builds do: `vite build` in `reference-app-web`, which `yarn build` runs, and `yarn workspace @serfab/reference-app-rn test:bundle` and `yarn workspace @serfab/reference-app-ns test:bundle`, which no root command runs. If the graph breaks in a way only a phone bundle shows, add a root check that bundles the default entry; a lint rule against one import would not cover the next one.

## Checks that run as tests

These protect something that fails only on a phone, in a published document or under a slow start, and are enforced by a spec under `yarn test`. The header of each spec states what it cannot see.

| What is protected | Spec | Runs while a sibling is stale |
|---|---|---|
| Babel's async-generator helper runs a generator's `finally` when a `for await` exits early; older `@babel/runtime` versions do not, which hangs strand founding on React Native | `packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts` | Yes: `--project metro-babel` |
| The Hermes polyfills in `@serfab/cadre-rn` supply the web APIs libp2p reads | `packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts` | Yes: `--project polyfills` |
| The Metro resolver rules `@serfab/cadre-rn/metro` installs | `packages/cadre-rn/test/metro/with-cadre-metro.spec.ts` | Yes: `--project polyfills` |
| No installed dependency of the React Native app starts reading a global that neither React Native nor the kit provides | `packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts` | Yes: `--project polyfills` |
| Every fenced block in [schema-guide.md](../schema-guide.md) applies, plans or runs | `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` | No |
| The hand copies of `schemas/chat-simple.qsql` in the three reference apps match the file | each app's `test/chat-schema-drift.spec.ts` | No |
| Storage operations of a control-database start and of a lone strand's launch, insert and select; cluster consultations and commits of a lone party's start and founding | `control-start-storage-op-budget`, `strand-solo-write-budget` and `control-founding-consult-budget` specs in `packages/cadre-core/test` | No |

Notes on reading them:

- **None of the phone checks sees the real engine.** The polyfill spec runs against a simulated Hermes global surface, and the dependency-globals spec is a text search over a listed set of packages. On a device, the kit's boot check prints which globals are native, polyfilled or missing ([react-native.md](../platforms/react-native.md#polyfills)).
- **The schema-guide spec requires a fence label on every block:** `sql schema [name]`, `sql query <name>`, `sql script` or `sql fragment`. It plans writes against every table, which proves each `check` constraint compiles, not that it accepts a sensible row.
- **The chat-schema comparison ignores comments, line endings, indentation and blank lines only.** The copies inside test fixtures are not compared (ticket `debt-test-fixtures-hand-copy-the-chat-schema`).
- **The cost budgets are two-sided.** A ceiling catches a regression, and a floor at half the measured value catches a test that stopped measuring anything. The numbers and their measurement notes are beside the constants in each spec; do not copy them into a document.

## Documentation

**What it checks.** `yarn check:docs` runs `scripts/check-docs.mjs`, and `yarn lint` runs it after ESLint. It reads every Markdown file that git tracks, or would track because it is not ignored, except the files under `tickets/` and `tess/` and the generated `.release-notes.pending.md`. It checks three things.

- **Links resolve.** A relative link must name a file or directory that exists. A `#fragment` on a Markdown target must match a heading in that file, or an explicit `<a id>`. Fragments follow GitHub's rule: lowercase, punctuation removed, spaces to hyphens, and `-1`, `-2` appended to a repeated heading. Links inside fenced code are not checked.
- **Size budgets hold.** Fenced code is not counted. Headings and table rows count toward the document total.
- **Directory indexes are complete.** A document listed in `INDEXES` in the script promises one entry for each file in a directory. Every file there must be named in the document, and every such name in the document must be a file there.

| Unit | Word limit |
|---|---|
| A document | 6,000 |
| A paragraph or list item | 120 |
| A table cell | 50 |

A link of the form `https://github.com/gotchoices/sereus/blob/master/…` (or `tree/master`) is checked as a local path. Package READMEs are published to npm, where relative links out of the package are dead, so they link to `docs/` by that URL.

The budgets exist because a document read at the start of every task is paid for on every task, and because a list item that carries ten claims hides nine of them. A document over its limit is split by topic. A paragraph over its limit becomes several, or a headed section.

The one directory index is [topology-coverage.md](topology-coverage.md), over the `*.integration.ts` files of `packages/integration-tests/src/scenarios`. An agent reads that document to decide whether a network shape is already tested, so a scenario with no row would read as a missing test. Adding, renaming or removing a scenario file therefore fails `yarn lint` until its row is updated.

With file arguments, given relative to the repository root, the script checks only those files, including a file the full run excludes. `--budgets-only` skips the link check and the index check, for a document whose link targets are still being written:

```bash
node scripts/check-docs.mjs docs/contributing/gates.md
node scripts/check-docs.mjs --budgets-only docs/contributing/gates.md
```

The index check runs whenever its document is among the files checked: on a full run, and when the document is named as an argument.

**What it cannot catch.**

- **Meaning.** A link that resolves to the wrong section, a claim that no longer matches the code, and a document that is under budget and still badly organised.
- **Links it does not read.** It does not fetch external URLs, including a GitHub URL of this repository on a branch other than `master`. It does not read reference-style links (`[text][label]`), and does not check a path written in code font without a link.
- **What an index entry says.** The index check compares file names only. A scenario named in a sentence instead of a table row passes, as does one named in two rows, and nothing checks that a row describes its scenario correctly.

**Where exemptions live.** There is no allowlist of documents that may exceed a limit, carry a dead link or omit an index entry. The excluded directories are `EXCLUDED_ROOTS` in the script, the excluded file is in `EXCLUDED_FILES`, the limits are `BUDGET`, and the indexed directories are `INDEXES`.

**Script.** `scripts/check-docs.mjs`; its unit test is the root `test:check-docs` script, part of `yarn test`.

## Opt-in measurements

Some integration scenarios measure a cost instead of asserting a behaviour. They are committed, so that a later measurement is comparable with an earlier one, and they are skipped unless an environment variable is set, so `yarn test` does not pay for them. They assert no count and no duration: a budget would have to be reset on every Optimystic change.

Results are kept beside the constant they justify, in the source file the table names, or in the scenario's own header. They are not copied into documents.

| Scenario (`packages/integration-tests/src/scenarios`) | Switch | What it measures |
|---|---|---|
| any scenario that dials through `harness/ws-latency.ts` | `WS_SEND_DELAY_MS=<ms>`, `WS_SEND_DELAY_MODE=pipelined\|serial`, `WS_FRAME_STATS=1` | The scenario with every outbound WebSocket frame in the process delayed, or with frames only counted |
| `strand-reattach-first-sync-measure` | `REATTACH_SYNC_MEASURE=1` | Time for a fresh join, and for a re-attach over an empty and over a kept store, to connect, become writable and read a missed row on a delayed relay link |
| `strand-workload-on-a-phone-link` | `STRAND_WORKLOAD_PHONE=1` for the phone-shaped arm | Deadline events, frames and streams over rounds of one side writing and the other reading |
| `strand-read-cost-over-relay` | `READ_COST_PHONE=1` for the phone-shaped arm | How long each read of an `App` or `Strand` table takes on a two-party relayed strand |
| `relayed-dial-cost-by-latency` | `RELAY_DIAL_COST=1` | What one relayed libp2p connection costs at a given one-way delay, without cadre or Optimystic above it |
| `relay-round-trip-measure` | `RELAY_RRT_MEASURE=1` | Time, streams per protocol and direction changes on the link for single strand operations between two parties that reach each other only through a relay |
| `message-cost-accounting` | `MESSAGE_COST_MEASURE=1` | Streams opened per protocol and block reads per caller while a two-party strand or a two-machine cadre forms and idles |
| `strand-relay-only-restart-reconverges` | `RESTART_NEGATIVE_CONTROL=1`, `RESTART_TWO_PROCESS=1` | Two extra arms of a default scenario: a restart that must fail to converge without saved network state, and the same restart across two operating-system processes |
| `joiner-first-commit-over-slow-relay` | `EVENT_LOOP_BUSY=<fraction>` | Any arm of a default scenario with the event loop kept busy |

Each scenario's header lists its further variables (which arms, how many runs, which delay). Run one with the variable set for the command:

```bash
RELAY_DIAL_COST=1 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency
```

```powershell
$env:RELAY_DIAL_COST = '1'; yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency
```

Three things to know before quoting a number:

- **A delay figure means nothing without its mode.** `pipelined` holds each frame for the delay and keeps frames overlapped, which models latency. `serial` queues a socket's frames one behind another, which is a cap on frame rate and produces waits far above the configured delay. The two are not comparable. The header of `harness/ws-latency.ts` explains both.
- **The delay from `ws-latency.ts` applies to every node in the process, and only to frames a node dials out.** To slow one party and not the other, use `harness/counting-proxy.ts`, a per-link proxy that also counts direction changes. `harness/stream-counter.ts` counts the streams each node opens per protocol.
- **A measurement is the reason for a constant, so run it again before changing the constant.** `relayed-dial-cost-by-latency` supplies the round-trip counts in `packages/cadre-core/src/link-budget.ts`. `strand-reattach-first-sync-measure` sizes `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` and informs `COHORT_READ_DEADLINE_MS`.
