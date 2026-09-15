description: On a real Android phone running the reference app alone, creating a chat strand showed no result for minutes, while the same founding on a desktop finishes in well under a second. Once the app logs its founding steps, find out on the device which step stalls or crawls, then file the fix.
prereq: rn-create-strand-progress-and-founding-trace
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

- **Make sure nobody else is driving the phone.** On 2026-09-15 another process was using it over adb: a touch at 09:27:41 that was not this session's, then `am force-stop` plus a relaunch of the dev client at 09:31:47 from the shell user. Check `adb logcat -d | grep "Force stopping org.gotchoices"` and the list of local sessions before tapping anything.
- **Metro's inspector proxy stopped answering.** After the app reloaded, both pages listed at `http://localhost:8081/json/list` accepted a WebSocket but never answered `Runtime.enable` or `Runtime.evaluate("1+1")`, even after 45 s, while the JS thread was idle. Rely on logcat. If you do evaluate, read modules through `__r.getModules()` (`isInitialized` + `publicModule.exports`), never `__r(<id>)`, which crashed the app on 2026-09-15.
- Find buttons by text via `adb shell uiautomator dump` rather than fixed coordinates, and let a scroll settle before tapping.
- Take screenshots from bash (`adb exec-out screencap -p > file`). PowerShell `>` re-encodes the bytes and corrupts the PNG.

## Expected outcome

- The stalled or slow step is named, with its device timing.
- An implement ticket for the fix, filed at the highest applicable level of the ticket rules' architecture ladder (type change, then general test, then boundary check, then point fix), with the regression guard that level implies. For example: a founding wall-clock budget if it is cost, a missing-API boundary check in the Hermes polyfills if it is an absent `AbortSignal` static, or a transport-start deadline if it is WebRTC.
- If the step is inside `../optimystic` or a native module, file the upstream-facing part as that repo's work or as `blocked/`, not as a sereus implement ticket.

## Working note — `../optimystic` state

`../optimystic` has uncommitted, unreviewed edits (`packages/db-p2p/src/cluster/block-transfer-service.ts` and block-transfer specs) left by its interrupted runner, and db-p2p's `dist` was rebuilt at 2026-09-14 23:57 with them included. Do not edit or revert `../optimystic`. Record `git -C ../optimystic log -1 --oneline` and whether its tree was dirty for every measurement.
