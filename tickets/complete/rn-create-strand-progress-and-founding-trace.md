description: Creating a strand in the React Native reference app now shows progress, cannot be started twice, reports how long it took, and logs each founding step, so a device run can show where a slow or stuck strand creation spends its time.
files:
  - packages/cadre-core/src/timed-step.ts (timedStep, moved out of cadre-node.ts in review)
  - packages/cadre-core/src/cadre-node.ts (foundStrand and startOrFoundStrand wrap each awaited step in timedStep)
  - packages/cadre-core/test/timed-step.spec.ts, packages/cadre-core/test/capture-debug-log.ts (added in review)
  - packages/cadre-core/test/control-read-retry.spec.ts, control-write-retry.spec.ts, enrolled-machine-store.spec.ts (use the shared capture helper)
  - packages/reference-app-rn/src/phone-node-config.ts (buildPhoneNodeConfig, runOwnerGenesis, PhoneNodeOptions)
  - packages/reference-app-rn/src/cadre-phone.ts (native wiring; calls phone-node-config)
  - packages/reference-app-rn/src/founding-progress.ts (traceFounding, pendingLabel, isSlowFounding, foundingDetail)
  - packages/reference-app-rn/app/settings.tsx (runFounding, both create handlers, useFoundingClock, SlowFoundingHint, modal detail line)
  - packages/reference-app-rn/src/use-cadre.ts (createClosedStrandWithInvite takes the strand id)
  - packages/reference-app-rn/src/test-ids.ts (modalDetail)
  - packages/reference-app-rn/polyfills/hermes.js (development-only DEBUG switch)
  - packages/reference-app-rn/test/solo-founding.spec.ts, test/fake-rn-leveldb.ts, test/founding-progress.spec.ts
  - packages/reference-app-rn/maestro/flows/4-solo-create-strand.yaml
  - docs/reference-app-rn.md, docs/reference-app-ns.md, packages/reference-app-rn/README.md
  - tickets/backlog/bug-rn-debug-placeholders-printed-raw.md (filed by implement), tickets/backlog/debt-ns-maestro-flow-parity-gaps.md (flow 4 arm added in review)
----

# Strand founding on the phone: progress, no double founding, and a step trace

## Why

On 2026-09-14 a phone running the reference app alone showed nothing for minutes after "Create Chat Strand" was tapped, and logged nothing either, so a stuck founding looked the same as a tap that never registered. This ticket added the feedback and logs needed to find the cause. The fix ticket `rn-solo-founding-stall-on-device` has since found it on the device: a Quereus lock left held when `for await` exits early, which only happens in Metro's Babel-compiled bundle.

## What landed

- **Step trace in cadre-core.** `timedStep(scope, id, step, op)` (now `src/timed-step.ts`) logs `[<scope>:<id>] <step>: start` under `sereus:cadre:timing`, then `<step>: <n>ms` or `<step>: failed after <n>ms`. It wraps every awaited step of `foundStrand` (plus a `total` line) and of `startOrFoundStrand`. It builds its text before calling `debug`, because React Native's console prints `%s`/`%d` placeholders unfilled.
- **Native-free phone config.** `buildPhoneNodeConfig` and `runOwnerGenesis` live in `src/phone-node-config.ts`, so a Node test builds the node the phone runs.
- **Settings.** One founding at a time: both create buttons are disabled, and a ref catches a same-frame double tap. The pressed button reads `Creating… N s`; after 30 s a hint says creation is slow but still running. Nothing aborts (accepted-tradeoff `NOTE:` on `runFounding`). The result modal has an elapsed-time line (`modal-detail`).
- **Handler logs in every build.** `[settings] create strand <id8> pressed`, then `succeeded in <n> ms` or a warning `failed after <n> ms:` with the error.
- **Development-only DEBUG switch.** The first statement of `polyfills/hermes.js` sets `process.env.DEBUG = 'sereus:cadre:timing'`.
- **Headless guard.** `test/solo-founding.spec.ts` founds an open and a closed chat strand on the app's own config over the rn-leveldb adapter with a fake native module, each within 10 s.
- **Device guard.** Maestro flow 4 connects alone, creates a strand and waits up to 60 s for `Strand created`.

## Review findings

### Checked

- Read the implement diff (`037fc35`) before the handoff, then every touched file, the docs, and code the change should have touched: the NativeScript app's use of the same Maestro flows, cadre-core's other debug-capturing specs, `run-e2e.mjs`, `_setup.yaml`.
- **Load order of the DEBUG switch:** correct. `index.js` imports `polyfills/hermes.js` first, and that file uses `require`, not `import`, so no library module is hoisted above the assignment.
- **Settings logic:**
  - The ref and the `disabled` prop together allow one founding.
  - The clock's interval is cleared when founding settles and on unmount.
  - `Math.max(0, …)` covers the first render's stale clock.
  - Errors are logged, then shown.
  - No `any` was added.
- **cadre-core trace:** every awaited step in both methods is wrapped, and a failure rethrows the original error.
- **Solo spec:** `within` clears its timer; `afterAll` stops the node; `vi.restoreAllMocks` runs after each test.

### Found and fixed in this pass

- **Flow 4 would fail on the NativeScript app.** `reference-app-ns/scripts/run-e2e.mjs` runs the React Native app's `maestro/flows/` unchanged, and its result modal has no `modal-detail`. Flow 4 is otherwise the one shared flow that uses only ids both apps expose, so the elapsed-time assertion was removed, with a comment in the flow saying why.
  - Added the case to `backlog/debt-ns-maestro-flow-parity-gaps`, the open ticket for the class.
  - Added flow 4 to the NativeScript doc's flow table.
  - Reworded the React Native README row so it no longer mentions elapsed time.
- **The solo spec's warning check could pass without checking anything.** It used `not.toHaveBeenCalledWith(stringContaining('[chat-strand]'), anything())`, and `chat-strand.ts`'s "no peerId; skipping role assignment" warning has a single argument, so it could never match. The spec now filters `warn.mock.calls` on the first argument and expects none.
- **The solo spec and docs claimed more than the spec can show.** They called it the regression guard for the device stall, but the cause found since only occurs in the Babel-compiled bundle, which Node never runs. Its header comment and the "Tracing a strand founding" doc section now say so and point to Maestro flow 4 for the device.
- **Docs wording.** "Both create buttons show elapsed seconds" was inaccurate: only the pressed one does. Corrected.
- **Modularity:** `timedStep` moved from `cadre-node.ts` (6,860 lines by `wc -l`; size tracked in `backlog/debt-cadre-node-single-file-size`) into `src/timed-step.ts`.
- **Test coverage and DRY:**
  - `timedStep` had no test; `test/timed-step.spec.ts` now pins the start line (logged before the step runs), both end lines, the returned value and the rethrown error.
  - Writing that spec would have made a fourth copy of the capture-debug-output helper, so the three existing copies now call one shared `test/capture-debug-log.ts`.

### Considered, left as is

- **Start lines inside `strandManager.startStrand`** (`buildStrandRuntime`, the synchronous per-strand LevelDB open). The handoff offered to add them. Not done: the device stall's cause has been found, so a follow-up trace no longer needs them. The placeholder-style lines there are covered by `backlog/bug-rn-debug-placeholders-printed-raw`.
- **An ignored double tap logs a strand id that is never founded,** because `uuid()` runs before the guard. Harmless, since the line says "ignored", and moving it would complicate both handlers.
- **Accepted tradeoffs:** the `NOTE:` on `runFounding` (no deadline or abort) and the `NOTE:` on the founding state (depends on the tab navigator keeping Settings mounted). Both were already recorded by implement; no revisit condition has tripped.
- **Tripwires:** none new.
- **New tickets:** none. The two classes this review touched already have open tickets: NativeScript flow parity and raw debug placeholders.

### Checks run (review pass)

- `yarn workspace @serfab/cadre-core build`: exit 0.
- Typechecks for `@serfab/cadre-core` and `@serfab/reference-app-rn`: exit 0.
- `yarn workspace sereus-workspace run lint` (whole repo): exit 0. `check:test-file-typecheck-coverage`: pass (330 files).
- The first React Native suite run, before any review edits: 12 files, 203 tests, with the stale-build guard passing.
- **Later runs were refused by the stale-build guard.** `../optimystic` held another runner's uncommitted edits to db-core and db-p2p source. Rebuilding its `dist` would have put that unfinished work under test, so the affected specs ran through a scratch vitest config identical to each package's except that it omits the guard's global setup (the setup files contain nothing else). They ran against the existing optimystic `dist`:
  - cadre-core `timed-step`, `control-read-retry`, `control-write-retry`, `enrolled-machine-store`, `publish-strand` and `cadre-node-strand-launch-key`: 6 files, 141 tests passed.
  - React Native `node` project: 11 files, 195 tests passed. `react` project (real config, which has no guard): 1 file, 8 tests passed.
  - `DEBUG=sereus:cadre:timing` solo spec: start and end lines for `queryStrand`, `publishStrand`, `addStrand` and `total` appear for both strands, now emitted from `timed-step.ts`.
- **Not re-run:** the full cadre-core suite (123 files). Only `cadre-node.ts`'s import of `timedStep` changed there, plus the three test-helper swaps, which were run.

### Not verified (unchanged from implement)

- No device run and no Maestro run: flow 4's YAML is unvalidated by Maestro.
- The Settings UI was never seen rendered.
- Handler logs in a release bundle were not checked.
- `backlog/debt-rn-cadre-phone-lifecycle-untested` can reuse the `phone-node-config.ts` seam; its lifecycle tests are still unclaimed.
