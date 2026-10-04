description: The shared React Native kit now carries the reference app's background/foreground handling, so every Sereus phone app can hibernate its strands in the background and resume cleanly, which sereus-chat and health do not do today.
prereq: rn-kit-phone-node
architecture: docs/architecture.md
files: packages/cadre-rn/src/lifecycle/, packages/cadre-rn/test/lifecycle/, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/cadre-rn/vitest.config.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/app-state.ts, packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, docs/architecture.md, docs/reference-app-rn.md
----
# Lifecycle runner (`@serfab/cadre-rn/lifecycle`)

Third of the kit's bring-up tickets, after `rn-kit-key-store` and `rn-kit-phone-node`. The implementation landed as `feat(cadre-rn): share the lifecycle runner` (merged in PR #31).

## What landed

- The reference app's AppState-driven background runner moved to `packages/cadre-rn/src/lifecycle/background-runner.ts`, exported as `@serfab/cadre-rn/lifecycle`, with its spec. Behaviour and API are unchanged. On `background` it hibernates the node's strands and drops to `background-hibernating` on the control network's real disconnect; on `active` it cold-starts the node if needed and waits, bounded, for the control network, reporting `degraded` if it does not come back.
- `phoneNodeLifecycle(phone)` builds the runner's `getNode` and `ensureNode` hooks from a `PhoneNode`. Its cold start uses the saved start and only while `autoStart` is set, so a node the user stopped stays stopped.
- The reference app imports the runner from the kit. `src/app-state.ts` returns react-native's `AppState` itself, which proves by typecheck that `AppState` is assignable to `AppStateLike`; the file stays as the seam `use-cadre.ts`'s spec fakes. The app keeps its own `ensureNode` because it also refreshes React state from the new node.
- The kit README has a "Lifecycle" section; `docs/architecture.md` (imperative lifecycle, mechanism 4) and `docs/reference-app-rn.md` point at the kit.

The plan had the runner take a `PhoneNode` directly. It keeps the two hooks instead so an app can do more on cold start, and so the runner moved unchanged.

## Review findings

Read the diff of `feat(cadre-rn): share the lifecycle runner` first, then the handoff.

**Checked, no defect:**
- `phoneNodeLifecycle` against `PhoneNode` semantics (`packages/cadre-rn/src/phone-node/node.ts`). `phone.node` is null whenever status is not `running`, so the runner's cold start runs while a start or restart is in flight and `start` joins it rather than building a second node. A cold start during a Disconnect reads `autoStart: false`, because `loadSavedStart` waits for the stop. A saved-start read fault is caught and logged by the runner's `runEnsureNode`.
- The runner's `node && !node.running` branch can't be reached through `phoneNodeLifecycle`. A `CadreNode` only stops through `stop()` or a failed start, and `PhoneNode` clears `current` before either, so `phone.node` is never a stopped node. That matters because `PhoneNode.start` over a stopped `current` would build without closing the old databases first.
- `AppState` is assignable to `AppStateLike`: the reference app typechecks with `return AppState`.
- Resource cleanup in the runner (settle listeners, timers, AppState subscription), error handling (listener and `hibernateAll` failures logged), and type safety: unchanged code, already covered by its 13-case spec.
- Docs: kit README, `docs/architecture.md` and `docs/reference-app-rn.md` (file tree; the saved-start section's statement about the runner's cold start) match the code. The kit paragraph in `docs/architecture.md` ("`@serfab/cadre-rn`") doesn't list the lifecycle subpath, and it doesn't list `phone-node` or `key-store` either. Each of those is covered by the section that owns its topic, so I left it alone.

**Minor, fixed in this pass:**
- The moved runner and its spec kept the reference app's 2-space indentation; every other file in `cadre-rn` uses tabs. Reindented both. A whitespace-ignoring diff shows no change beyond the doc-comment fix below.
- The `ensureNode` doc comment in `background-runner.ts` had a `{@link phoneNodeLifecycle}` that can't resolve (that function isn't in scope in this module) on an overlong line. Replaced it with a plain reference to `./index.ts` and rewrapped it.
- Comments that still named the reference app's `background-runner.ts` / `test/background-runner.spec.ts` were stale after the move. Fixed them in `packages/reference-app-rn/vitest.config.ts`, `src/push-wake.ts` and `test/react/use-cadre.spec.ts`.
- `packages/cadre-rn/vitest.config.ts` described the `node` test project as "the Noise crypto adapter" only. It now says the project holds every other spec, and why it carries the stale-build guard.
- `docs/architecture.md` mechanism 4 had nested parentheses around the kit path. Flattened them.

**Tests:** cut `reports the phone node's running node` from `phone-node-lifecycle.spec.ts`. It tested the one-line getter `() => phone.node`, and the tests-must-pay bar excludes getters. Kept the two cold-start cases, because they pin the `autoStart` rule. Added no tests: I found no defect that needed a reproduction.

**Major / tickets filed:** none. No finding reached the filing bar.

**Tripwires:** none. Nothing I found is conditional on a future change.

**Considered and left:** the reference app's `ensureNode` and `phoneNodeLifecycle`'s cold start use different sources: the last options passed to `start` versus the saved record gated on `autoStart`. They behave the same, because the reference app tears the runner down when Disconnect nulls the node. The implementer kept the app's own hook on purpose, so it can refresh React state.

**Verification (after review edits):**
- `yarn workspace @serfab/cadre-rn typecheck`: clean. `test`: 140 pass. The handoff's 157 came before the `rn-kit-phone-node` review trimmed tests, and this pass cut one.
- I rebuilt `@serfab/cadre-rn` (an in-repo package) so the reference app's stale-build guard passes. `yarn workspace @serfab/reference-app-rn typecheck`: clean. `test`: 168 pass.
- `yarn lint`: exit 0. knip reports nothing in the lifecycle code; the findings it lists in `cadre-rn` and `reference-app-rn` were there before this change.
- **Not run:** an Expo device build of the reference app.
