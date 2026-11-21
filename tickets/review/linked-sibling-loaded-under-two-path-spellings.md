description: On Windows, when a linked sibling repository's folder is spelled with different capital letters than this repo's links use, tests load a second copy of the storage library and fail in ways that look like real bugs. A new test-setup check now refuses such a run and says how to fix it, as the setup already does for a lowercase drive letter.
architecture: docs/contributing/testing.md#windows-one-sibling-under-two-path-spellings
files: test-harness/linked-package-spellings.ts (new), test-harness/linked-package-spellings.spec.ts (new), test-harness/build-freshness.ts, test-harness/build-freshness.spec.ts, packages/cadre-core/test/global-setup.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-host/src/__tests__/global-setup.ts, packages/cadre-provider/test/global-setup.ts, packages/cadre-rn/test/global-setup.ts, packages/integration-tests/test/global-setup.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/reference-app-ns/test/global-setup.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-web/test/global-setup.ts, docs/contributing/testing.md
difficulty: medium
----

# Review: a linked sibling loaded under two path spellings

A **spelling** is the exact path string a junction stores for the directory it points at. Windows compares paths without regard to case, so two junctions can point at one directory and store different strings for it. Node keys its module cache by the resolved string and keeps whichever spelling the junction stored, so a package reached under both is loaded twice and every `instanceof` across the two copies is false. That is what made `isCohortUnreachableRead` stop recognising a `BlockUnavailableError` the plugin had just thrown.

## What was built

**`test-harness/linked-package-spellings.ts`** (new, 300 lines). Reads only `lstat`, `readlink`, `realpath` and `package.json`; writes nothing, here or in a sibling.

- `findSpellingDisagreements(targets, setupUrl)` returns one `SpellingDisagreement` per linked package name that resolves to two or more path strings, each carrying its `resolved` string, the directory's `onDisk` spelling (`realpathSync.native`) and every junction (`via`) that produced it.
- `assertOneSpellingPerLinkedPackage(targets, setupUrl)` throws with that listing plus the consequence and a two-branch remedy.
- The walk is over **loading contexts** — a directory an `import '<pkg>'` resolves from — seeded with the setup module's own directory and the root of every `workspace` target, then extended breadth-first through each linked root it discovers, bounded by a seen-set of context path strings. Candidate names for the suite directory are every `linked` target; for every other context they are narrowed to what that context's own manifest declares across `dependencies`, `peerDependencies` and `optionalDependencies`.
- No platform branch: on a case-sensitive filesystem the spellings simply agree. Passes trivially when `resolutions` carries no `link:` entries (`yarn check:published`), because then nothing resolves as `linked`.

**`test-harness/build-freshness.ts`** — `workspacePackageRoots` is now exported; the `linked` variant of `LinkedPackage` carries the `junction` path that produced its `root`; `readPackageJson` and its `PackageManifest` are exported, widened with the three dependency maps, so the new module does not add a third manifest reader to `test-harness/` (`build-targets.ts` keeps its own, which throws by design).

**Wiring** — all ten `globalSetup` modules call it between `assertUppercaseDriveLetter()` and `assertBuildFresh(...)`. Before the freshness check for a reason, not just cost: with two spellings live the freshness walk judges two roots for one package, so its verdict may be about a copy that is not the one that runs.

**Docs** — new section "Windows: one sibling under two path spellings" in `docs/contributing/testing.md`, immediately after the uppercase-drive-letter rule and opening by tying the two together.

**This machine** — the eight `packages/reference-app-{web,rn,ns}/node_modules/@optimystic/*` junctions that stored `C:\Projects\optimystic\...` were repointed to `C:\Projects\Optimystic\...`, matching the root junctions and the sibling's own nested links. Each was deleted non-recursively (`[System.IO.Directory]::Delete($link, $false)`) and recreated with `New-Item -ItemType Junction`; no recursive delete was used anywhere, and `../Optimystic` is intact with a clean `git status`.

## Validating and using it

**The check fires where it should.** Before the repointing, `yarn workspace @serfab/reference-app-web test` refused with the full message, naming `@optimystic/db-core`, `db-p2p` and `db-p2p-storage-web` — exactly the three the fix ticket measured for that suite. Note vitest also prints "No test files found, exiting with code 1" above the error: that is what vitest does when `globalSetup` throws before collection, not a second problem.

**It stays silent where it should.** All ten guarded suites now pass the check. The seven non-reference-app suites were each confirmed with a setup-only run (`vitest run __no_such_spec__`, which still executes `globalSetup`); the three reference apps by running their suites.

**`@quereus/quereus` is still spelled `C:\Projects\quereus\...` by all four of this repository's junctions while the directory is `C:\Projects\Quereus` on disk, and the check is silent about it — correctly.** Uniformly odd is one module instance, so refusing it would stop every suite on this machine for no reason. A reviewer who "fixes" that will not change any behaviour and should not; the check compares spellings against each other, never against the disk.

**To see the refusal by hand** without disturbing the install, build a temp fixture the way the spec does: two junctions onto one directory whose stored targets differ only in case, one of them reachable from a package that declares the name.

## Tests

One new spec, `test-harness/linked-package-spellings.spec.ts`, over temp-dir fixtures (`mkdtempSync` + `symlinkSync(..., 'junction')`, with `realpathSync` on the temp root because macOS hands out a symlinked one). It runs in the integration suite, whose vitest `include` already carries `../../test-harness/**/*.spec.ts`. Each case is one of the detector's real branches:

- *reports a package two junctions resolve to different paths, and names both in the refusal* — the positive direction, plus that the thrown message carries both spellings, both junction paths, the sibling-checkout clause and the "`yarn install` is not the fix" line.
- *does not report a package every junction spells the same way* — the uniformly-odd case that must not stop a run.
- *does not report a registry-installed copy beside a linked one* — a real directory cannot disagree about a sibling's spelling.
- *does not report a package reachable only under a name its holder never imports* — the declared-dependency filter. Without it the real `@quereus/quereus` resolves to the Quereus checkout's own spelling and every suite reports a disagreement for an import nothing performs.
- *follows nested node_modules past the first linked package it finds* — two hops, so the walk is pinned as transitive rather than one level deep.
- *reports two junctions onto one directory whose spellings differ only in case* (`it.runIf(process.platform === 'win32')`) — the bug's reproduction at the lowest layer that has it, and the only case exercising the `realpathSync` versus `realpathSync.native` difference.

`test-harness/build-freshness.spec.ts` gained no cases: three assertions that compare whole `LinkedPackage` values now also assert the new `junction` field, via a small `junctionIn(nodeModulesDir)` helper beside the existing `link` fixture helper.

## Known gaps

- **The "every junction is ours" arm of the remedy is not covered by a test.** Case 1 covers the sibling arm, which is the one that fires on this machine. The uncovered arm is prose selection on `foreignCheckouts(...).length === 0` — a fixture for it would put the second junction inside the fixture's own repo root. Worth a reviewer's judgement on whether that earns a test.
- **The walk's start-up cost was not timed in isolation.** A setup-only `reference-app-web` run — vitest boot, config load, both setup checks and the freshness walk together — took 2.86 s, 2.72 s, 2.81 s over three runs. There is a `NOTE:` in the module saying what to cache if start-up ever shows up; it makes no magnitude claim.
- **The wiring tripwire lives in the module comment, not at a call site.** The fix ticket asked for a `NOTE:` at one call site; it went into the new module's own doc instead, beside the paragraph that states the wiring requirement, so there is one copy rather than ten and every call site reaches it through its import. The content is as specified: `scripts/check-stale-build-guard-wiring.mjs` keys on the `build-freshness` import specifier, so deleting only the `assertOneSpellingPerLinkedPackage` line from one setup module fails nothing — equally true of `assertUppercaseDriveLetter` today; if a third such setup check appears, gate the set rather than that one import.
- **`foreignCheckouts` reports sibling *checkouts* rather than the sibling junctions themselves.** The first draft listed every foreign junction in the remedy and produced an eight-path sentence on this machine; the junctions are already listed per package above, so the remedy now names the deduped, `realpathSync.native`-canonicalised checkout roots instead. No test pins that choice.

## Gates

- `yarn lint` (ESLint plus `check:docs`, 66 Markdown files OK): pass.
- `yarn typecheck` (every workspace, plus `check:vitest-typecheck-coverage`, `check:test-file-typecheck-coverage` — 474 files across 10 packages, 0 allowlisted — and `check:stale-build-guard-wiring`): pass.
- `test-harness/` specs through the integration suite: 3 files, 45 passed.
- `@serfab/cadre-core`: 200 files, 2681 passed, 1 skipped. `@serfab/reference-app-web`: 4 / 11. `@serfab/reference-app-rn`: 20 / 180. `@serfab/reference-app-ns`: 7 / 72.
- `yarn dep-check` exits 1, **pre-existing and not this change's**: `ERROR: Error loading packages/reference-app-rn/app.config.ts (app.json must set expo.name)`, `Unused dependencies (6)` in `packages/cadre-rn` and `packages/reference-app-ns`, and `Unused devDependencies (1)` in `packages/reference-app-web`. Byte-identical to the report in `tickets/.logs/4-node-hosts-carry-webrtc.implement.2026-11-21T11-36-40-612Z.log`, and `tickets/complete/4-node-hosts-carry-webrtc.md` already records knip as failing at HEAD on a pre-existing backlog. No `package.json` or `app.config.ts` is in this diff. This change adds exactly one new knip entry, at `warn` level and so not gate-failing: `PackageSpelling` under "Unused exported types", alongside 77 others — it is part of the module's documented return shape.
- No pre-existing *test* failure surfaced; `tickets/.pre-existing-error.md` was neither present nor written.
- Nothing in `../Optimystic`, `../quereus` or `../Fret` was built, installed into or edited. `yarn install` was not run.

A run log is at `tickets/.logs/linked-sibling-loaded-under-two-path-spellings.cadre-core.log`.
