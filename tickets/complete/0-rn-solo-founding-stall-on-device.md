description: Creating a chat strand hung on a real Android phone because an outdated Babel helper cut async-generator cleanup short and left the database lock held. The helper upgrade was already in the tree; this ticket added a test that compiles code the way the phone's bundler does and fails if the broken helper returns, plus docs.
files:
  - packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts (guard)
  - packages/reference-app-rn/vitest.config.ts (`metro-babel` project, excluded from `node`)
  - packages/reference-app-rn/test/solo-founding.spec.ts (header comment)
  - knip.ts (`@babel/core`, `@types/babel__core` no longer ignored for reference-app-rn)
  - docs/reference-app-rn.md (§ Key Dependencies: Babel helper floor; § Tracing a strand founding)
  - docs/testing.md (§ Lint coverage: Babel helper floor bullet)
  - packages/reference-app-rn/package.json, yarn.lock (the bump; landed in `32879da`)
  - tickets/blocked/rn-solo-founding-device-run.md (device run, split out)
----

# Founding a strand on a solo phone hangs: Babel helper floor and guard

## Cause

Hermes has no native async generators, so Metro's Babel output runs them on Babel's `wrapAsyncGenerator` helper. In `@babel/runtime` and `@babel/helpers` before 7.29.2, once the consumer calls `return()`, every later `await` resumption inside the generator is sent as another `return`, so a `finally` stops at its first `await`. Quereus's `_evalGenerator` releases its execution lock after `await stmt.finalize()` in its `finally`. cadre-core's `strandTableCount` leaves its `for await` after the first row. The lock stayed held, and `StrandDatabase.bootstrapFounder`'s insert waited forever.

## What landed

- **The bump** (commit `32879da`, swept in by another ticket's runner commit): `reference-app-rn` declares `@babel/runtime` `^7.29.2`; `yarn.lock` resolves `@babel/runtime`, `@babel/helpers` and `@babel/core` to 7.29.7. The manifest keeps the first fixed release, 7.29.2, as its floor, the same floor the docs name.
- **Guard.** `test/metro-babel/async-generator-cleanup.spec.ts`, in its own Vitest project `metro-babel`, which has no stale-build guard. It loads the app's `metro.config.js`, compiles an early-exit probe with `transformer.babelTransformerPath` (Expo's Babel transformer, which loads `babel-preset-expo`) using Android Hermes development options, and runs the output in Node. The probe is a generator that holds a lock and releases it after an `await` in `finally`, read by a loop that returns on the first row. There are three cases:
  - native control (the uncompiled probe);
  - module output, run against every `@babel/runtime` install on Metro's `nodeModulesPaths`;
  - script output, which inlines the helper from `@babel/helpers`.
  Each compiled case also asserts that the helper is actually used, so the test cannot pass vacuously.
- **Docs**: the helper floor and the guard in `docs/reference-app-rn.md` and `docs/testing.md`.
- **Board**: the device confirmation moved to `blocked/rn-solo-founding-device-run`.

## Review findings

**Checked and confirmed**
- **Lockfile and installs.** `yarn.lock` has one `@babel/runtime` entry and one `@babel/helpers` entry, both at 7.29.7. A `find` over `sereus`, `../quereus`, `../optimystic` and `../Fret` shows the only `@babel/runtime` install is in `packages/reference-app-rn/node_modules`. The only `@babel/helpers` installs are in `reference-app-rn`, `reference-app-ns` and the `../quereus` root. All are 7.29.7.
- **Transform options match Expo.** In `@expo/cli` 0.24.24, `build/src/start/server/middleware/metroOptions.js` sets `engine: 'hermes'` and `unstable_transformProfile: 'hermes-stable'` for Hermes, which matches the spec. The app's Metro `getTransformOptions` returns `experimentalImportSupport: false`, which also matches.
- **The guard is not vacuous (proof re-run).** I downloaded `@babel/runtime` and `@babel/helpers` 7.28.6 into the scratchpad and served them through a `Module._resolveFilename` preload (`NODE_OPTIONS=--require …`), then ran the unmodified spec. The native control passed. Both compiled cases failed with `{ row: 1, held: true }`, and the messages named `@babel/runtime 7.28.6 in …reference-app-rn\node_modules` and `@babel/helpers 7.28.6 inlined by @babel/core 7.29.7`. Without the preload all 3 pass. I deleted the scratch copies afterwards.
- **Doc claim about Quereus.** Quereus's `UNSUPPORTED` startup check (`src/util/async-generator-support.ts`) arrived in `ac4b72bc8`. The `chore: release v4.19.0` commit (`c5bb6bf23`) is an ancestor of it, and no release has been cut since, so "from `ac4b72bc8` on (not the published 4.19.0)" is accurate.
- **Docs.** I read both doc paragraphs, the `vitest.config.ts` header, the `solo-founding.spec.ts` comment, and the pointer updated in `implement/rn-request-node-from-cadre-host`; all describe the current state. The RN doc's Testing Strategy section covers Maestro only and does not list Vitest projects, so it needs no change.
- **Dependency config (`knip.ts`).** Removing `@babel/core` and `@types/babel__core` from `ignoreDependencies` is correct, because the spec now imports `@babel/core` and its types. `yarn dep-check` exits 0 with no configuration hints.
- **Board.** Only the `blocked/rn-solo-founding-device-run` ticket remains, and it references this slug by name only.

**Found and fixed inline**
- **Tripwire, not yet parked at its site.** The hand-copied Expo transform options were listed as a gap in the handoff but had no `NOTE:` in the code. I added a doc comment and a `NOTE:` at `hermesAndroidDevOptions`. It names the Expo CLI file the options mirror and says to re-check them on Expo upgrades.

**Tripwires (already parked, no ticket)**
- A nested `@babel/runtime` inside a sibling package would be found by Metro's hierarchical lookup but not probed. None exists today (checked, above). `NOTE:` at `runtimeInstalls` in the spec.
- The Expo options drift described above. `NOTE:` at `hermesAndroidDevOptions`.

**Major findings / new tickets**
- None. Nothing in the diff has a defect or a class of problem needing follow-up. The one open risk, device behaviour, already has its own ticket, `blocked/rn-solo-founding-device-run`.

**Considered and accepted**
- **Separate Vitest project.** Keeping `metro-babel` separate from `node` is right: it loads no other package's `dist`, so the stale-build guard would only stop it for no reason.
- **Manifest floor `^7.29.2` rather than `^7.29.7`.** It states the real minimum; the lockfile pins 7.29.7.
- **Probe shape.** Only the lock-release shape is modelled. Other `finally` cleanups go through the same helper, so they are covered by the same class of check.

**Validation (this pass)**

| command | result |
| --- | --- |
| `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel` | 3 passed (before and after the edit) |
| same, with the 7.28.6 preload | 2 failed / 1 passed, as expected |
| `yarn workspace @serfab/reference-app-rn vitest run --project react` | 8 passed |
| `yarn workspace @serfab/reference-app-rn typecheck` | exit 0 (after the edit) |
| `yarn lint` | exit 0; `eslint` on the edited spec also exit 0 |
| `yarn dep-check` | exit 0 |
| `yarn check:vitest-typecheck-coverage`, `check:test-file-typecheck-coverage`, `check:stale-build-guard-wiring` | all OK |

**Not run**
- **RN `node` project** (`yarn workspace @serfab/reference-app-rn test`). It still stops at the stale-build guard (`@serfab/cadre-core: dist is stale`).
- **`reference-app-web` tests.** Same guard.

I did not rebuild, for two reasons: Metro is still listening on port 8081 for another session and watches these directories, and `../optimystic` has uncommitted source edits that a build would bake into `dist`. This change touches no production code and no code those suites run, and the `node` project excludes `test/metro-babel/**`. Neither is a test failure, so no `.pre-existing-error.md` was written.
