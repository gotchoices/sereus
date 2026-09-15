description: Creating a strand in the React Native reference app now shows progress, cannot be started twice, reports how long it took, and logs each founding step, so a device run can show where a slow or stuck strand creation spends its time. Review the change and the checks behind it.
files:
  - packages/cadre-core/src/cadre-node.ts (timedStep helper near the top; foundStrand; startOrFoundStrand)
  - packages/reference-app-rn/src/phone-node-config.ts (new: buildPhoneNodeConfig, runOwnerGenesis, PhoneNodeOptions)
  - packages/reference-app-rn/src/cadre-phone.ts (now calls phone-node-config; re-exports PhoneNodeOptions)
  - packages/reference-app-rn/src/founding-progress.ts (new: traceFounding, pendingLabel, isSlowFounding, foundingDetail)
  - packages/reference-app-rn/app/settings.tsx (runFounding, both create handlers, useFoundingClock, SlowFoundingHint, modal detail line)
  - packages/reference-app-rn/src/use-cadre.ts (createClosedStrandWithInvite now takes the strand id)
  - packages/reference-app-rn/src/test-ids.ts (modalDetail)
  - packages/reference-app-rn/src/chat-strand.ts (comment pointers only)
  - packages/reference-app-rn/polyfills/hermes.js (dev-only DEBUG switch at the top)
  - packages/reference-app-rn/test/solo-founding.spec.ts, test/fake-rn-leveldb.ts, test/founding-progress.spec.ts (new)
  - packages/reference-app-rn/test/react/use-cadre.spec.ts (new call signature)
  - packages/reference-app-rn/maestro/flows/4-solo-create-strand.yaml (new)
  - docs/reference-app-rn.md ("Tracing a strand founding", flows table, polyfill table), packages/reference-app-rn/README.md (flow inventory)
  - tickets/backlog/bug-rn-debug-placeholders-printed-raw.md (filed from this work)
difficulty: medium
----

# Strand founding on the phone: progress, no double founding, and a step trace

## Why

On 2026-09-14 a phone running the reference app alone showed nothing for minutes after "Create Chat Strand" was tapped, and logged nothing either, so a stuck founding looked the same as a tap that never registered. The fix ticket `rn-solo-founding-stall-on-device` (prereq on this one) needs a device trace to find the cause. This ticket adds the UI feedback, the handler logs, the cadre-core step trace, and a headless regression guard.

## What landed

**cadre-core step trace.** `timedStep(scope, id, step, op)` in `cadre-node.ts` logs `[<scope>:<id>] <step>: start` under `sereus:cadre:timing`, then `<step>: <n>ms` or `<step>: failed after <n>ms`. It wraps every awaited step of `foundStrand` (`queryStrand`, `publishStrand`, `addStrand`, plus a `total` line) and of `startOrFoundStrand`: the fresh-launch path's `resolveStrandPartyKey` (closed strands only), `strandTransportKey`, `resolveCohortSeed`, `strandManager.startStrand` and `mergeStrandPeerAddrs`, and the already-tracked founder path's `foundExistingStrand`, `wakeStrand` and `ensureFounderBootstrap`. Adopting an already-published row is synchronous and has no line of its own: it shows as `queryStrand` followed directly by `addStrand`.

**Native-free phone config.** The `CadreNodeConfig` assembly, `runOwnerGenesis` and `PhoneNodeOptions` moved from `cadre-phone.ts` into `src/phone-node-config.ts`. `cadre-phone.ts` keeps the native wiring (secure store, rn-leveldb, ICE, WebRTC) and calls `buildPhoneNodeConfig`. Behaviour is unchanged apart from the genesis-failure warning's prefix, now `[phone-node-config]`.

**Settings.** One `founding` state (`'open' | 'closed'` plus start time) disables both create buttons while either runs. A ref also catches a second tap in the same frame, before `disabled` re-renders; a refused tap logs `<label> ignored: another strand creation is still running`. The pressed button reads `Creating… N s`, updated by a one-second interval that is cleared on settle and unmount. After 30 s a hint says creation is slow but still running. Nothing aborts (accepted-tradeoff `NOTE:` on `runFounding`). The result modal gains a detail line under its title (`Created in 1.4 s` / `Failed after 3.2 s`, testID `modal-detail`). A `NOTE:` on the state records that it relies on the tab navigator keeping Settings mounted.

**Handler logs, all builds.** `traceFounding` in `src/founding-progress.ts` logs `[settings] create strand <id8> pressed` (info) on entry, then `succeeded in <n> ms` (info) or `failed after <n> ms:` plus the error (warn). The closed-strand handler logs `[settings] create closed strand <id8> …`.

**Dev-only DEBUG switch.** The first statement of `polyfills/hermes.js` sets `process.env.DEBUG = 'sereus:cadre:timing'` when `__DEV__` is true and `DEBUG` is unset.

**Headless guard.** `test/solo-founding.spec.ts` builds the node with the app's own `buildPhoneNodeConfig` and `runOwnerGenesis` (`InMemoryKeyStore`, memory node-local stores, `webSockets()` + `circuitRelayTransport()`). Storage is `LevelDBRawStorage` over `openOptimysticRNDb`, which calls `wrapRNLevelDB`, with `test/fake-rn-leveldb.ts` standing in for the native module. The spec founds an open and a closed chat strand, each within 10 s, and asserts `status: 'active'` and `founded: true`, read from the `foundStrand` call through a spy. The closed case also asserts that no `[chat-strand]` warning appears, which would mean the owner-role insert failed. `test/founding-progress.spec.ts` pins the log lines, their order and the label, hint and detail text.

**Device guard.** `maestro/flows/4-solo-create-strand.yaml`: clear state, Settings, Connect with empty fields, scroll to the button, wait for animations, tap, wait up to 60 s for `modal-title` = `Strand created`, assert `modal-detail` matches `Created in .* s`. It does not use `_setup.yaml`. `run-e2e.mjs` runs every file in `maestro/flows/`, so flow 4 now runs in `yarn test:e2e` too; it ignores the drone environment variables.

## Deviations from the ticket, and why

- **Modal titles are unchanged; elapsed time is a separate line.** `_setup.yaml` and flow 4 match `modal-title` text exactly as `Strand created`, and the closed-strand message is the invitation, which users select and copy whole.
- **`createClosedStrandWithInvite(strandId)`.** Settings now generates the closed strand's id, so its log line names the same strand as the cadre-core trace.
- **`timedStep` builds its text before calling `debug`**, unlike the older `%dms`-style lines. A passive logcat read showed that RN's console prints `%s`/`%d` placeholders unfilled (see "Device status"), so placeholder-style lines from this helper would have read `[%s:%s] %s: start` on the device. Node output is identical either way. Filed the class problem as `backlog/bug-rn-debug-placeholders-printed-raw`.
- **More steps timed than the ticket listed:** the closed strand's `resolveStrandPartyKey` and the three already-tracked founder-path steps. They are awaited steps of the same method.

## Checks run (all passed)

Run from the repo root in `yarn workspace` form. A plain `cd` in parallel tool calls is unsafe in this environment, because the tool tracks one working directory across calls.

- `yarn workspace @serfab/cadre-core build`.
- `yarn workspace @serfab/reference-app-rn test`: 12 files, 203 tests, run before and after the final `timedStep` text change.
- `DEBUG=sereus:cadre:timing yarn workspace @serfab/reference-app-rn vitest run test/solo-founding.spec.ts --reporter=verbose`: every step's start and end line appears, correctly nested. Founding totals were 71–79 ms (open) and 107 ms (closed). Trace in `tickets/.logs/rn-create-strand-progress-and-founding-trace.solo-trace.log` until pruned.
- `yarn workspace @serfab/cadre-core vitest run test/publish-strand.spec.ts`: 39 tests, twice.
- cadre-core full suite: 123 files, 2051 passed, 1 skipped. This ran by accident after the first `cadre-node.ts` edit and was **not** re-run after the final change, which only altered the text passed to `debug`.
- Typecheck (`@serfab/reference-app-rn`, `@serfab/cadre-core`): exit 0 after the final edits.
- `yarn workspace sereus-workspace run lint` (whole repo): exit 0 before the final edits to `cadre-node.ts` and a `hermes.js` comment; ESLint on those two files afterwards: exit 0.
- `check:test-file-typecheck-coverage`, `check:vitest-typecheck-coverage`, `check:stale-build-guard-wiring`: pass.
- **Load order of the DEBUG switch, checked on a real bundle** (`expo export --platform android --dev --no-bytecode`, output since deleted):
  - No `debug` module is reachable from the modules that run before `index.js` (InitializeCore, expo winter, metro-runtime; 684 modules in total).
  - `index.js`'s first dependency is `polyfills/hermes.js`.
  - In the transformed `hermes.js`, the `process.env.DEBUG` assignment comes before every library require; only two Babel class helpers are hoisted above it.
  - The bundle holds seven copies of `debug`.

## Device status

- **Not driven by this session.** A Galaxy Note 9 (SM-N960U, adb id `26e2d245db217ece`) was attached, and a Metro server this session did not start was already answering on 8081. The logs show another session force-stopping and relaunching the app at 09:31:47 and 09:55:08. A device run needs Metro kept running in the background, which this runner does not allow, and it would have collided with that session.
- **Passive `adb logcat -d` read.** After the 09:55:08 relaunch, the app printed `D/ReactNativeJS` `sereus:cadre:timing [start] …` lines during Connect: `createControlNode` 368 ms, control DB `hydrate` 575 ms, `loadSchema` 3665 ms, `controlDatabase.initialize` 4270 ms, start `total` 4671 ms. This fits the new `hermes.js` switch being served by Metro from this working tree, since nothing else in the tree enables `DEBUG`. This session did not control that run, though. No `[settings] create strand` or `[foundStrand:` lines were in the buffer: no one tapped Create after the change loaded, and cadre-core's `dist` with the new steps was built later, at about 09:57.
- **Maestro flow 4 was not run**, so its YAML is not validated by Maestro (`scrollUntilVisible`, `waitForAnimationToEnd`, regex `text` on `modal-detail`).
- **The Settings UI was not seen rendered anywhere:** the ticking label, disabled buttons, 30 s hint and modal detail line. This package has no renderer test for screens (see `vitest.config.ts`); only the RN-free helpers are unit-tested.

## Build state tested against

- sereus `935ad58` plus this change.
- `../optimystic`:
  - First-round checks (typechecks, the first RN suite at 10:02, the cadre-core full suite at 09:58) used `dist` built 2026-09-14 23:57 from `1ae87282` plus its then-uncommitted block-transfer change (tree dirty).
  - Its runner then committed `235d266b`, `21d44376` and `3984d0ed` (10:05–10:10) and rebuilt the db-core, db-p2p and db-p2p-storage-rn `dist` at 10:07. The final RN suite, solo trace and `publish-strand` runs (about 10:10) used that build.
  - At handoff it is at `3984d0ed ticket(implement): block-transfer-uses-node-only-buffer-global`, with a clean tree. The stale-build guard passed on every run.

## Known gaps for the reviewer

- **Older timing lines print raw on the device.** For example: `'sereus:cadre:timing [buildStrandRuntime:%s] createLibp2pNode: %dms +4ms', '<id>', 4`. Tracked in `backlog/bug-rn-debug-placeholders-printed-raw`; the docs sample shows this form.
- **Inside `strandManager.startStrand` only completions are logged.** `buildStrandRuntime`'s lines (`createLibp2pNode`, `strandDatabase.initialize`, `relay first attempts`) have no start lines, and the synchronous per-strand storage open (`resolveStrandStorage` → `new LevelDB('sereus-<id>')`) has no line at all. So a trace ending at `[startOrFoundStrand:<id>] strandManager.startStrand: start` cannot say whether the native LevelDB open or libp2p node creation (WebRTC) stalled; both are candidates in the fix ticket. Settings tells them apart on the device: rn-leveldb calls are synchronous, so a stall inside the open blocks the JS thread and the `Creating… N s` label stops updating, while an awaited stall leaves it counting. Adding start lines there (moving `timedStep` into a module `strand-instance-manager.ts` can share) is a small, reasonable follow-up if the reviewer wants it before the device run.
- **Release-build logs not checked.** No console-stripping Babel config was found in the package, but the handler logs were not checked in a release bundle.
- **The closed-strand spec doesn't read the party key back.** It proves the party-key path only through `founded: true` on an active closed instance, plus the absence of the role-insert warning; a founder bootstrap without a party key throws.
- **Overlap with `backlog/debt-rn-cadre-phone-lifecycle-untested`:** the extraction gives half the injection seam that ticket needs; its lifecycle-ordering tests are still unclaimed.

## Use cases to validate

- **Headless:** the commands under "Checks run".
- **Device, solo:**
  - Connect with empty fields and tap Create Chat Strand. The button reads `Creating… N s` and both create buttons dim. The modal shows `Strand created` with `Created in X s`.
  - Logcat shows `I/ReactNativeJS [settings] create strand <id8> pressed`, then `… succeeded in <n> ms`, with `D/ReactNativeJS sereus:cadre:timing [foundStrand:<id>] …` start and end lines between.
- **Fast double tap:** one founding only; a second tap in the same frame logs `ignored`.
- **Closed strand with no reachable address:** fails at once with `Closed strand failed` and `Failed after 0.0 s`, plus a `W/ReactNativeJS … failed after <n> ms:` line.
- **Founding slower than 30 s:** the hint appears, nothing is cancelled, and the result modal still arrives.
- **Tab switch mid-founding:** the buttons are still disabled on return.
- **Maestro:** `maestro test -e MAESTRO_APP_ID=org.gotchoices.sereus.chat maestro/flows/4-solo-create-strand.yaml`; and `yarn test:e2e` should still pass flows 1–3, whose modal titles are unchanged.
