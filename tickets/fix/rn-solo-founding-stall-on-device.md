description: On a real Android phone running the reference app alone, creating a chat strand never finishes. The cause is now known and lives in the Quereus SQL engine as the phone runs it: stopping a query after its first row never releases the database's lock, so the strand's next write waits forever. What remains here is to track the Quereus fix, verify on the device, and decide whether Sereus needs a guard of its own.
files:
  - packages/reference-app-rn/app/settings.tsx:97-105 (handleCreateStrand)
  - packages/reference-app-rn/src/cadre-phone.ts:229-285 (phone node config, incl. webRTC transport)
  - packages/cadre-core/src/cadre-node.ts:4371-4391 (foundStrand), 4827-4958 (startOrFoundStrand), 4986-5061 (resolveCohortSeed)
  - packages/cadre-core/src/strand-instance-manager.ts:384-640 (startStrand / buildStrandRuntime)
  - packages/reference-app-rn/polyfills/hermes.js (Hermes gaps already patched)
  - packages/reference-app-rn/node_modules/abort-controller/dist/abort-controller.js (RN's AbortSignal — no `any`/`timeout`)
  - ../optimystic/packages/db-p2p/src/repo/client.ts:91, ../optimystic/packages/db-p2p/src/dispute/client.ts:32 (AbortSignal.any / AbortSignal.timeout callers)
  - ../optimystic/packages/db-p2p-storage-rn/src/rn-opener.ts (rn-leveldb adapter)
repro: verified
----

# Founding a strand on a solo phone: find the step that stalls

## Root cause (found 2026-09-15, live on the device)

- **The stuck step.** `StrandDatabase.bootstrapFounder` → `db.exec('insert into Strand.Header …')` waits forever on Quereus' execution mutex (`Database._acquireExecMutex`). The lock was left held by the read just before it: `strandTableCount` (`cadre-core/src/strand-membership-writer.ts:256-261`) leaves its `for await (… of db.eval(…))` loop after the first row.
- **Why only on the phone.** Metro compiles Quereus with Babel. Babel's lowering of async generators drops the rest of a generator's `finally` after its first `await` when the generator is closed by `return()`, which is what an early exit from `for await` does. Quereus' `_evalGenerator` releases the mutex *after* `await stmt.finalize()` in its `finally`, so the release never runs. Node runs the generator natively and releases normally, which is why every headless run finished.
- **Proof.**
  - Live runtime state: `execMutexDepth: 1`, and the pending-call trace was `initialize` → `bootstrapFounder` → `exec(insert into Strand.Header…)` → `_withMutex` → `_acquireExecMutex`. No Optimystic transaction was in flight, and no storage call or ≥ 1 s timer was pending.
  - A fresh in-memory Quereus `Database` on the device leaks the same way after `next()` + `return()`.
  - A headless Node reproduction with the Expo/Hermes Babel transform isolates the `finally`-with-`await` shape.
  - Patching `Database.prototype.eval` in the live app so an early `return()` drains the iterator made a founding that always hung **resolve in 2.7 s** (strand `active`, mutex depth 0).
- **Where the fix lives.** The full evidence, variant table and the **20 affected sites in Quereus** (a scan of all three repos found none in sereus or optimystic) are in `../quereus/tickets/fix/eval-early-exit-leaks-exec-mutex-under-babel.md`. This is a dependency outside this repo.
- **Hypotheses below are superseded.**
  - H0 (tap never reached the handler): no.
  - H1 (slow, CPU-bound): no — the JS thread idled at ~5 % throughout.
  - H2 (a wait that never settles): yes, but it is the Quereus mutex, not WebRTC, LevelDB or `AbortSignal`.
  - H3 (a swallowed error): no.
- **What remains in this repo:**
  - Once the Quereus fix is built into `../quereus/packages/quereus/dist`, re-run solo founding on the device.
  - Decide whether cadre-core should carry the same lint guard, since the pattern could be introduced here later.
  - Until the engine is fixed, other early-exit reads over `db.eval` in cadre-core (for example `strandHasManagerRevocation`, which returns on its first match) can hang other phone flows. A Sereus-side workaround (consume fully) is possible but is whack-a-mole next to the engine fix. Check whether `Database.get` → `Statement.get` is affected too before recommending it: `statement.ts:481` has the same shape.

## Observed

**2026-09-14:** Galaxy Note 9 (SM-N960U), Android 10, debug build of `reference-app-rn` (Expo SDK 53, RN 0.79.6, Hermes), JS from Metro over `adb reverse`, sereus `311fb47` with an optimystic build that included the `block-latch.ts` fix. Connect with empty party id and bootstrap reached `Connected` in about 12 s. "Create Chat Strand" was tapped right after scrolling to it. For about 2 minutes: no dialog, `Strands 0`, and no `ReactNativeJS` logcat line after the tap. Then the device dropped off USB, so it is **not known** whether founding ever finished.

**2026-09-15:** not reproduced; this session could not drive the device (see below). From logcat: a solo Connect at 09:21:58 finished at 09:22:04, about 6 s to node-up.

## Measured and ruled out (2026-09-15)

- **Founding cost in Node with the phone's node shape is small, including over the RN storage adapter.** Setup: transaction profile, `listenAddrs: []`, WebSockets + circuit relay transports, owner genesis exactly as `runOwnerGenesis`, chat sApp config. `foundStrand` took 63 ms over `LevelDBRawStorage(wrapRNLevelDB(...))` with a synchronous in-memory fake of rn-leveldb's native module, and 58 ms over `MemoryRawStorage`. Total from process start to founded: 190 ms. The founding made 117 puts, 40 gets, 17 deletes, 17 batch writes and 16 range scans against the fake. So the adapter's read, iterator and batch logic is not the cause. **Not measured:** the real native module's speed, and anything Hermes-specific. Build: cadre-core `dist` from current source; `../optimystic` at `1ae87282` with the uncommitted block-transfer change built into db-p2p's `dist`.
- **Strand nodes do not gain a listener on the phone.** An explicitly empty `listenAddrs` stays empty in the strand-node view (`cadre-core/src/strand-network-config.ts:134-139`), so no WebSocket server is started on RN, where `net` is an empty shim.
- **The genesis-failure path is excluded:** it throws `no owner signing key available` straight away, which would have shown the failure modal.

## Hypotheses, cheapest to confirm first

The trace from `rn-create-strand-progress-and-founding-trace` (a log line when the handler starts and settles, `sereus:cadre:timing` start/end lines for every founding step) should settle H0 immediately and name the stalled step for the rest.

- **H0 — the tap never reached the handler.** A tap during scroll momentum only stops the scroll. The 2026-09-14 report tapped right after scrolling, and the app logged nothing either way. Confirmed if no `[settings] create strand … pressed` line appears.
- **H1 — slow, not stalled (CPU on Hermes).** A debug build runs JS through Hermes from source with no JIT. Connect took about 6–12 s on the device against about 190 ms for start + genesis headless, a ratio of roughly 30–60. Founding has a similar per-operation mix, which projects to seconds, not minutes, unless something scales worse on the device. To confirm: during founding, sample the JS thread (`adb shell top -b -n 1 -H -p <pid> | grep mqt_v_js`; compare `TIME+` against wall time). A pegged thread plus steadily progressing timing lines means H1. Before this ticket's tap, with the node connected and idle, the thread sat at about 3% CPU.
- **H2 — a wait that never settles.** Signature: an idle JS thread, and a timing step with a start line but no end line. Candidates the headless run could not cover:
  - the strand libp2p node starting with the phone's `webRTC()` transport (react-native-webrtc); the headless run left WebRTC out;
  - opening a fresh native LevelDB database per strand (`new LevelDB('sereus-<strandId>')` in `cadre-phone.ts:77-79`);
  - a missing `AbortSignal.any` / `AbortSignal.timeout`. RN's `abort-controller` polyfill defines neither, Hermes has no native one, and db-p2p calls both (`repo/client.ts:91`, `dispute/client.ts:32`). `polyfills/hermes.js` already patches `AbortSignal.prototype.throwIfAborted`, so this kind of gap has bitten before. A `TypeError` thrown inside a detached callback can leave an awaited promise pending without rejecting it. Those two call sites should be multi-peer paths only, but check `typeof AbortSignal.any` on the device anyway. `repro: static`.
- **H3 — an error swallowed below the modal.** Look for `strand:error` warnings (`use-cadre.ts:161`) and `W/ReactNativeJS` lines between the handler's start and settle lines.

## Doing the device run — lessons from 2026-09-15

- **Make sure nobody else is driving the phone.** On 2026-09-15 the touch at 09:27:41 and the `am force-stop` + dev-client relaunch at 09:31:47 were the interactive Claude session that filed the original ticket (it was debugging the same stall on the device at the same time), not an unknown process. The advice stands: check `adb logcat -d | grep "Force stopping org.gotchoices"` and the list of local sessions before tapping anything.
- **Metro's inspector proxy admits ONE debugger client per device.** Connecting a second WebSocket closes the first (close code 1005). The non-answers seen on 2026-09-15 came right after the app had been crashed by a `__r(<id>)` probe and while clients were being opened in parallel; on a clean launch with a single client, page 1 (the app runtime) answered `Runtime.enable` in ~160 ms and `Runtime.evaluate` in 3–35 ms throughout the stall. **`__r.getModules()` does not exist in this Metro/Expo dev client** (only `importDefault`, `importAll`, `context`, `resolveWeak`, `unpackModuleId`, `packModuleId`), and `__r(<id>)` with an id read from a downloaded bundle reports a fatal "Requiring unknown module" — never use it. What works: walk React's fiber tree from `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(rendererId)` to the context provider whose `memoizedProps.value` has `node` + `createStrand`. Hermes' eval rejects `async` syntax, and RN's `Promise` polyfill is invisible to CDP `awaitPromise` — park async results on a global and poll it.
- Find buttons by text via `adb shell uiautomator dump` rather than fixed coordinates, and let a scroll settle before tapping.
- Take screenshots from bash (`adb exec-out screencap -p > file`). PowerShell `>` re-encodes the bytes and corrupts the PNG.

## Expected outcome

- The stalled or slow step is named, with its device timing.
- An implement ticket for the fix, filed at the highest applicable level of the ticket rules' architecture ladder (type change, then general test, then boundary check, then point fix), with the regression guard that level implies. For example: a founding wall-clock budget if it is cost, a missing-API boundary check in the Hermes polyfills if it is an absent `AbortSignal` static, or a transport-start deadline if it is WebRTC.
- If the step is inside `../optimystic` or a native module, file the upstream-facing part as that repo's work or as `blocked/`, not as a sereus implement ticket.

## Working note — `../optimystic` state

`../optimystic` has uncommitted, unreviewed edits (`packages/db-p2p/src/cluster/block-transfer-service.ts` and block-transfer specs) left by its interrupted runner, and db-p2p's `dist` was rebuilt at 2026-09-14 23:57 with them included. Do not edit or revert `../optimystic`. Record `git -C ../optimystic log -1 --oneline` and whether its tree was dirty for every measurement.
