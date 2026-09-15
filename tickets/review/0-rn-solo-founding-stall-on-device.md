description: Creating a chat strand hung on a real Android phone because an outdated Babel helper cut async-generator cleanup short and left the database lock held. The helper upgrade was already in the tree; this ticket adds a test that compiles code the way the phone's bundler does and fails if the broken helper returns, plus docs.
files:
  - packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts (new guard)
  - packages/reference-app-rn/vitest.config.ts (new `metro-babel` project, excluded from `node`)
  - knip.ts (`@babel/core`, `@types/babel__core` removed from reference-app-rn `ignoreDependencies`)
  - docs/reference-app-rn.md (§ Key Dependencies: Babel helper floor; § Tracing a strand founding)
  - docs/testing.md (§ Lint coverage: Babel helper floor bullet)
  - packages/reference-app-rn/package.json, yarn.lock (the bump itself; landed earlier in `32879da`, unchanged here)
  - tickets/blocked/rn-solo-founding-device-run.md (device run, split out)
----

# Founding a strand on a solo phone hangs: Babel helper floor and guard

## Cause (unchanged from the implement ticket)

Hermes has no native async generators, so Metro's Babel output runs them on Babel's `wrapAsyncGenerator` helper. In `@babel/runtime` and `@babel/helpers` before 7.29.2, once the consumer calls `return()`, every later `await` resumption is sent as another `return`, so a `finally` stops at its first `await`. Quereus's `_evalGenerator` releases its execution lock after `await stmt.finalize()` in its `finally`; cadre-core's `strandTableCount` leaves its `for await` after the first row; the lock stayed held and `StrandDatabase.bootstrapFounder`'s insert waited forever.

## What was already in the tree

Commit `32879da` (a runner commit for another ticket, which swept in the working tree) contains the bump. `reference-app-rn` declares `@babel/runtime` `^7.29.2`, and `yarn.lock` resolves `@babel/runtime`, `@babel/helpers` and `@babel/core` to 7.29.7. Verified this run: `yarn why @babel/runtime` and `yarn why @babel/helpers` list only 7.29.7. `yarn.lock` has no 7.28.x resolution of either package. No manifest names a `^8` Babel range. On disk, the only `@babel/runtime` copy across `sereus`, `../quereus`, `../optimystic` and `../Fret` is `packages/reference-app-rn/node_modules/@babel/runtime` (7.29.7). The `@babel/helpers` copies (app, `reference-app-ns`, `../quereus` root) are all 7.29.7.

**Deviation:** the ticket's TODO said to declare `^7.29.7`. I kept `^7.29.2`, the first fixed release, which `docs/testing.md` already names as the floor. The lockfile resolves 7.29.7 either way. Change it if you prefer the manifest to match the lock.

## Guard: rung 1, a behaviour test through the app's own Babel config

`packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts`, in a new Vitest project `metro-babel`.

- It loads the app's `metro.config.js` and calls the transformer at `transformer.babelTransformerPath` (Expo's `@expo/metro-config` babel transformer). With no `babel.config.js`, that transformer loads `babel-preset-expo` exactly as Metro does. The spec passes the options Expo CLI sends for an Android Hermes development bundle: `platform: 'android'`, `dev`, `hot`, `unstable_transformProfile: 'hermes-stable'`, `customTransformOptions.engine: 'hermes'`. Output is generated from the returned AST and evaluated in Node.
- The probe has the failing shape: a generator takes a lock, yields rows, and in `finally` does `await Promise.resolve()` then releases the lock; the reader `return`s on the first row. Expected outcome: `{ row: 1, held: false }`.
- Three tests:
  - **Native control.** The uncompiled probe in Node must release the lock, proving the expectation is the language's behaviour.
  - **Modules.** The output must import `@babel/runtime/helpers/wrapAsyncGenerator`, and it is run against every `@babel/runtime` install on the app's Metro `resolver.nodeModulesPaths`.
  - **Scripts.** Metro `type: 'script'` disables the runtime import, so the output must inline `_wrapAsyncGenerator` from `@babel/helpers` and must not `require` anything.
- The "is the helper actually used" assertions keep the test from passing vacuously if a future preset stops lowering async generators.
- Failure messages name the helper version and path, the defect, and the upgrade command inside Babel 7.
- Dev bundles compile with Fast Refresh, so the output calls `$RefreshReg$`/`$RefreshSig$`. The spec passes the same no-ops `metro-runtime/src/polyfills/require.js` defines. Without them the first run failed with `ReferenceError: $RefreshReg$ is not defined`.
- A separate project with no `globalSetup`, because it loads no compiled output from other packages. `node` excludes `test/metro-babel/**`.

### Proof the test is not vacuous

Metro was running for another session (`expo start --dev-client --port 8081`, serving from the app's `node_modules`), so I did not swap old copies into the shared tree or revert the lockfile. Instead:

- Downloaded 7.28.6 into a scratch directory: `npm pack @babel/runtime@7.28.6 @babel/helpers@7.28.6`, extracted to `runtime/` and `helpers/`.
- Wrote a scratch preload (not committed) patching `Module._resolveFilename`:
  - `@babel/helpers[/…]` → `<scratch>/helpers[/…]`;
  - `@babel/runtime/…` → `<scratch>/runtime/…`;
  - bare requests from files under `<scratch>` → resolved with `paths: [packages/reference-app-rn/node_modules]`.
- Ran the unmodified spec: `NODE_OPTIONS="--require <scratch>/redirect.cjs" yarn workspace @serfab/reference-app-rn vitest run --project metro-babel`.

Result: the native control passed and both compiled cases failed with `{ row: 1, held: true }`:
- `@babel/runtime 7.28.6 in C:\projects\sereus\packages\reference-app-rn\node_modules: after an early exit from \`for await\`, the compiled generator skipped the code after the first \`await\` in its \`finally\`…`
- `@babel/helpers 7.28.6 inlined by @babel/core 7.29.7: …` (same message)

Without the preload: 3 passed.

## Validation run

| command | result |
| --- | --- |
| `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel` | 3 passed |
| `yarn workspace @serfab/reference-app-rn vitest run --project react` | 8 passed |
| `yarn workspace @serfab/reference-app-rn typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-web typecheck` | exit 0 |
| `yarn lint` | exit 0 |
| `yarn dep-check` | exit 0, no configuration hints (after the `knip.ts` change) |
| `yarn check:vitest-typecheck-coverage`, `check:test-file-typecheck-coverage`, `check:stale-build-guard-wiring` | all OK (336 test files across 9 packages, 0 allowlisted) |

**Not run green:**
- **RN `node` project** (`yarn workspace @serfab/reference-app-rn test`). The stale-build guard aborts: `dist` older than `src` for `@serfab/cadre-core`, `@optimystic/db-core`, `@optimystic/db-p2p` and `@quereus/quereus`.
- **`yarn workspace @serfab/reference-app-web test`**. Aborts the same way on `@serfab/cadre-core`.

I did not rebuild, for two reasons:
- `../optimystic` has uncommitted source edits from another session, and building would bake them into `dist`.
- Metro, live for another session, watches all of these directories, so a rebuild would push reloads to that session's phone.

This ticket changes no production code and no lockfile entry; the `node` project does not collect the new spec. A reviewer should rebuild once those sessions are idle and run both suites.

## Known gaps and tripwires

- **Copies Metro could reach that the spec doesn't probe.** It probes `@babel/runtime` installs on `nodeModulesPaths` only. Metro first looks in `node_modules` directories above the importing file, so a copy nested inside a sibling package (e.g. `../quereus/packages/quereus/node_modules/@babel/runtime`) would serve that package and is not probed. None exists today. A `NOTE:` sits at `runtimeInstalls` in the spec.
- **Emulated options.** The Metro options are hand-written to match Expo CLI 0.24 / `@expo/metro-config` 0.20.18. If Expo changes how it signals Hermes, the compiled probe could differ from the phone's bundle. The helper-usage assertions catch the case where lowering stops, not every drift. Only the development profile is compiled; release bundles use the same helpers.
- **No manifest floor for `@babel/helpers`.** Nothing declares it directly; it comes through `@babel/core` `^7.29.0`. The lockfile resolves 7.29.7, and the guard's script case covers it.
- **Only the Quereus lock-release shape is modelled.** Other `finally` cleanups (statement finalize, cursor close) are the same helper path, so they are covered by class, not by shape.
- **No device verification.** It is in `blocked/rn-solo-founding-device-run`.

## Board changes

- The same slug also sat in `blocked/`, a copy rewritten by the session that made the bump (it said "fix landed, needs a device run") and committed in `32879da` alongside the garden's move to `implement/`. I moved its device-run checklist and phone-driving lessons, merged with this ticket's checklist, into `blocked/rn-solo-founding-device-run` (distinct slug, no prereq: the bump is already in the tree), then deleted the duplicate.
- Updated the pointer in `implement/rn-request-node-from-cadre-host`, which told its agent to check the old `blocked/` path.

## Review checklist

- Is a separate Vitest project the right home, versus the `node` project with its stale-build guard?
- Do `hermesAndroidDevOptions` match what Expo CLI sends for the phone's bundle? Compare with `@expo/cli`'s Metro bundle options for `engine`/`unstable_transformProfile`.
- Re-run the 7.28.6 proof above, or an equivalent, and confirm both compiled cases fail.
- `docs/reference-app-rn.md` (Key Dependencies paragraph) and `docs/testing.md` (Lint coverage bullet): check wording and accuracy, including the claim that Quereus's `UNSUPPORTED` check is in `ac4b72bc8` and not in published 4.19.0.
