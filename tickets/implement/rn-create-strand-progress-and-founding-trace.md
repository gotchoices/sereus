description: In the reference phone app, "Create Chat Strand" shows no sign it is working and can be tapped twice. It also logs nothing, so a slow or stuck strand creation looks exactly like a tap that never registered. Make the button show progress and report the outcome with elapsed time, and log each founding step so a device run shows where the time goes.
files:
  - packages/reference-app-rn/app/settings.tsx (handleCreateStrand, handleCreateClosedStrand, Btn)
  - packages/reference-app-rn/src/use-cadre.ts (createStrand, createClosedStrandWithInvite)
  - packages/reference-app-rn/src/cadre-phone.ts (config assembly + runOwnerGenesis to move out; lines 229-285, 342-356)
  - packages/reference-app-rn/src/phone-node-config.ts (new — native-free config builder)
  - packages/reference-app-rn/polyfills/hermes.js (dev-only debug namespace switch)
  - packages/reference-app-rn/test/solo-founding.spec.ts (new)
  - packages/reference-app-rn/maestro/flows/4-solo-create-strand.yaml (new)
  - packages/cadre-core/src/cadre-node.ts:4371-4391 (foundStrand), 4827-4958 (startOrFoundStrand) — add timing lines
  - packages/cadre-core/src/strand-instance-manager.ts:405-640 (existing `sereus:cadre:timing` lines, for reference)
  - ../optimystic/packages/db-p2p-storage-rn/src/rn-opener.ts (the rn-leveldb adapter the new spec drives; read-only — do not edit ../optimystic)
difficulty: medium
----

# Make strand founding on the phone visible, bounded in the UI, and traceable

## Why

On 2026-09-14 a Galaxy Note 9 running the reference app alone showed nothing for over two minutes after "Create Chat Strand" was tapped: no dialog, strand count still 0, nothing in logcat. The follow-up fix ticket `rn-solo-founding-stall-on-device` has to find out why, and it cannot with the app as it is now:

- `handleCreateStrand` (`app/settings.tsx:97`) logs nothing when it starts. A tap swallowed by scroll momentum (the tap in that report came right after scrolling to the button) looks the same as a founding that hangs.
- The only feedback is a modal shown when the promise settles. Nothing shows while it runs, and the button stays enabled, so a second tap founds a second strand if the first ever finishes.
- cadre-core already writes phase timings under the `debug` namespace `sereus:cadre:timing` (`strand-instance-manager.ts`: `createLibp2pNode`, `strandDatabase.initialize`, `total`). The RN app never turns that namespace on, and the steps before `startStrand` (control-row read and publish, strand transport key derivation, cohort seed resolution) have no timing line at all.

Headless measurements on 2026-09-15 (Node 24, dev PC) used the phone's node shape: `profile: 'transaction'`, `listenAddrs: []`, `webSockets()` + `circuitRelayTransport()`, strand filter `all`, hibernation off, unsigned schemas allowed. Owner genesis ran as `runOwnerGenesis` does it, then `foundStrand` with the chat sApp config. Build state: cadre-core `dist` built 09:19 from current source; `../optimystic` at `1ae87282` with an uncommitted block-transfer change included in db-p2p's `dist`.

| storage | start | genesis done | `foundStrand` alone | storage calls during founding |
|---|---|---|---|---|
| `LevelDBRawStorage` over the real `wrapRNLevelDB` adapter, with a synchronous in-memory fake of rn-leveldb's native module | 73 ms | 127 ms | **63 ms** | 117 put, 40 get, 17 delete, 17 batch writes, 16 range scans |
| `MemoryRawStorage` | 69 ms | 122 ms | **58 ms** | — |

So the RN storage adapter's logic does not slow founding. What remains is device-only, and only a trace from the device can separate the candidates.

## Design

### 1. Settings: progress, no double founding, outcome with elapsed time

- One piece of screen state records which founding action is pending (`'open' | 'closed' | null`) and when it started. Both "Create Chat Strand" and "Create Closed Strand + Invite" found a strand, so **both** buttons are disabled while either is pending. That rules out two concurrent foundings from one screen.
- While pending, the pressed button's label shows elapsed seconds (`Creating… 12 s`), updated by a one-second interval that is cleared on settle and on unmount.
- After 30 s still pending, a hint under the button says founding is taking longer than expected and is still running. **Do not reject or abort at the timeout.** `foundStrand` keeps running and is resumable (`cadre-node.ts:4333-4370`). A UI that reports "failed" would leave a strand the user believes was never created, and would re-enable the button for a second founding. Accepted tradeoff: the UI bounds how long the user waits without an explanation, not how long founding takes. Put a `NOTE:` at the site saying so.
- On settle, the existing modal includes elapsed time (`Strand created in 1.4 s`, `Strand creation failed after 3.2 s: <reason>`).
- Keep `testID`s stable (`btn-create-strand`, `modal-title`). The Maestro setup flow (`maestro/_setup.yaml:62-69`) depends on them.

### 2. Logs that separate "never fired" from "hung"

- `handleCreateStrand` logs `console.info('[settings] create strand <id8> pressed')` on entry. On settle it logs `console.info` with elapsed ms, or `console.warn` with elapsed ms and the error. Same for the closed-strand handler. These always log, not only in dev: they are the only evidence a user report can carry.

### 3. Founding phase trace

- **cadre-core:** add `timing(...)` lines, using the existing `sereus:cadre:timing` logger in `cadre-node.ts:130`, around each awaited step of `foundStrand` (`queryStrand`, `publishStrand`/adopt, `addStrand`) and of `startOrFoundStrand` (`strandTransportKey`, `resolveCohortSeed`, `strandManager.startStrand`, `mergeStrandPeerAddrs`). Follow the existing `[startStrand:%s] …: %dms` format. Log a line when each step **starts** as well as when it ends, so a step that never finishes shows up as a start with no matching end.
- **RN app, dev builds only:** turn the namespace on before any library module loads. `debug`'s browser build (`node_modules/debug/src/browser.js`, `load()`) reads `process.env.DEBUG` when each copy of the module initializes. The bundle holds several copies of `debug` (root, `packages/reference-app-rn/node_modules`, `../optimystic/node_modules`), so calling `enable()` on one copy would miss the others. Setting the environment variable reaches every copy. Put it at the top of `polyfills/hermes.js`, guarded by `__DEV__` and by "not already set". Verify that `__DEV__` and `process.env` exist that early. Output goes to `console.debug`, which appears in logcat as `D/ReactNativeJS`.
- **Verification:** on a device (if available), or by reasoning from module order if not, confirm a `sereus:cadre:timing` line appears during Connect. If you cannot verify on a device, say so in the review handoff.

### 4. Headless regression guard, built from the app's real config

- Move the `CadreNodeConfig` assembly out of `startPhoneNode` (`cadre-phone.ts:229-271`) into a new native-free module, `src/phone-node-config.ts`. Its function takes the key store, storage provider, transports, the three node-local stores, the party id and bootstrap addresses, and returns the config. Move `runOwnerGenesis` (`cadre-phone.ts:342-356`) there too. `cadre-phone.ts` keeps the native wiring (secure store, rn-leveldb, ICE, WebRTC) and calls both. The test can then run the app's own config and genesis instead of a copy that could drift.
- New `test/solo-founding.spec.ts`:
  - build the node from `phone-node-config.ts` with `InMemoryKeyStore`, `webSockets()` + `circuitRelayTransport()` (leave out `webRTC()`: its Node variant needs `node-datachannel`), and in-memory versions of the node-local stores;
  - use `LevelDBRawStorage(wrapRNLevelDB(fakeNative, FakeWriteBatch))`, where `fakeNative` is a synchronous in-memory sorted key-value fake of rn-leveldb's `LevelDB` (`getBuf` returns `null` for a missing key, the iterator takes a snapshot, `seek` lands on the first key ≥ target). The fake used for the numbers above was about 70 lines;
  - run genesis, then `createChatStrand(node, id)`, and assert the instance is `active` and `founded` is `true`, with founding under a **10 s** deadline. Headless founding measured 63 ms (190 ms including start); 10 s leaves room for CI contention and still catches a stall;
  - also found a **closed** strand over the same storage. It touches the `StrandPartyKey` path, which the open strand skips.
- This also gives the rn-leveldb adapter (`RNLevelDBAdapter`) its first Node coverage: optimystic's own tests use `classic-level` and never run it. Test only through founding here; adapter unit tests belong in `../optimystic`.
- Overlaps backlog `debt-rn-cadre-phone-lifecycle-untested`: that ticket needs an injection seam in `cadre-phone.ts`, and the extraction here provides half of one. Don't take on its lifecycle-ordering tests.

### 5. Device guard (not agent-runnable without a device)

- New `maestro/flows/4-solo-create-strand.yaml`: `launchApp` with `clearState`, then Settings, Connect with empty party id and bootstrap, wait for `btn-disconnect`, tap `btn-create-strand`, then `extendedWaitUntil` `modal-title` with text `Strand created`, timeout 60000. It does not use `_setup.yaml`, which needs a drone. Record in the review handoff whether it was run.

## TODO

- Add `timing` start/end lines around each awaited step of `CadreNode.foundStrand` and `startOrFoundStrand`; rebuild cadre-core.
- Extract `src/phone-node-config.ts` (config builder + `runOwnerGenesis`) and have `cadre-phone.ts` call it; behaviour unchanged.
- Settings: shared founding pending state, both founding buttons disabled while pending, elapsed-seconds label, 30 s "still running" hint with an accepted-tradeoff `NOTE:`, elapsed time in the result modal; clear the interval on settle and unmount.
- Entry and settle `console.info`/`console.warn` logs in both founding handlers.
- Dev-only `process.env.DEBUG = 'sereus:cadre:timing'` at the top of `polyfills/hermes.js`, guarded; verify it takes effect before library modules load.
- `test/solo-founding.spec.ts`: open and closed founding over `wrapRNLevelDB` + synchronous fake native, 10 s deadline.
- `maestro/flows/4-solo-create-strand.yaml`.
- Run `yarn test` in `packages/reference-app-rn`, cadre-core's tests for the touched files, `yarn lint`, and the typecheck.
- Review handoff: state whether anything was verified on a device, and the `git -C ../optimystic log -1 --oneline` plus dirty/clean state of the build you tested against.
