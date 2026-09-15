description: Confirmed on the Android test phone that creating a chat strand on a phone with no other devices now finishes in about 3 seconds (it used to hang) after the build-tool helper upgrade. The run also found two new bugs, filed as fix tickets (strands not re-attached after a restart; control storage shared across party ids), and fixed two small app bugs in place (message times 6 hours off; first Connect tap swallowed by the keyboard).
files:
  - packages/reference-app-rn/app/settings.tsx (Create Chat Strand handler; ScrollView `keyboardShouldPersistTaps`)
  - packages/reference-app-rn/app/index.tsx (message time label)
  - packages/reference-app-rn/src/chat-operations.ts (`parseStoredDatetime`)
  - packages/reference-app-rn/test/chat-operations.spec.ts (new)
  - packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts (headless guard for the cause)
repro: verified
----

# Founding a strand on a solo phone: confirmed on the device

Run by an agent driving the phone over adb and Metro's inspector, 2026-09-15 16:29–16:56.

## Setup

- Galaxy Note 9 (SM-N960U), Android 10, debug `reference-app-rn` dev client, JS from Metro over `adb reverse`.
- `@babel/runtime` / `@babel/helpers` 7.29.7. `vitest run --project metro-babel`: 3/3 pass.
- Quereus `ff1c619c6`, dist rebuilt 16:29 so the bundle carries the async-generator startup check. Its `UNSUPPORTED` error never appeared.
- Optimystic `6897710c`, with that runner mid-ticket (`index-integrity-check`, uncommitted edits in `quereus-plugin-optimystic`).
- Sereus `eeec81d` plus this session's working-tree edits.
- Metro restarted with `--clear`. No other session drove the phone: no foreign `Force stopping org.gotchoices` in logcat.

## Results

| Step | Result |
|---|---|
| Connect, empty party id | Connected in ~9 s. Node start 5231 ms, of which `controlDatabase.initialize` 4753 ms |
| Create Chat Strand #1 (`82dc7f6b`) | **succeeded in 3257 ms**. `queryStrand` 155, `publishStrand` 1363, `addStrand` 1730 (`startStrand` 1617, of which `strandDatabase.initialize` 1461, of which `connectToStrand` 1265) |
| Create Chat Strand #2 (`7b228868`) | **succeeded in 2970 ms** |
| Send a message in #1 | Shown 2 s after Send |
| Fixed party id `11111111-…-555555555555`: Connect, create (`c7160779`) | **succeeded in 3322 ms** |
| Force-stop, relaunch, same party id, Connect | Connected in ~5 s (node start 3027 ms), but **0 strands** after 25 s: see below |
| Re-attach `c7160779` by hand (debugger), check writes | Active in 2157 ms. The pre-restart message was present. A new message row (`e30d19cb`, 4:53 PM) was written and shown. Its text was missing from the UI dump, but Send refuses empty text (`handleSend` trims and returns; the button is disabled), so the row carried text |

Every `sereus:cadre:timing` start line had a matching end line, and nothing stalled.

## Found during the run

- **Filed `fix/rn-restart-leaves-stored-strands-dormant`.** After a restart, stored strands are announced (`strand:discovered`) before the app subscribes, and never again, so the "strands the app brings back" step had nothing to check until they were re-attached by hand. Cause confirmed live.
- **Filed `fix/phone-control-storage-shared-across-parties`.** The control store is keyed by the literal `'control'`, so a new party id on the phone saw 10 strands from earlier party ids.
- **Fixed in place: message times 6 hours off.** A `datetime` column reads back without a zone, and `new Date()` parsed it as local time ("10:34 PM" for a 16:34 MDT message). Added `parseStoredDatetime` (treat zone-less values as UTC) plus a spec. On the device the label then read "4:47 PM" at 16:47. Hermes' own `toLocaleTimeString` was verified correct.
- **Fixed in place: first Connect tap swallowed.** With the keyboard up, Settings' ScrollView only dismissed the keyboard. Added `keyboardShouldPersistTaps="handled"`; on the device one tap now starts the node with the keyboard shown.
- **Dev-environment hazard, not a product bug.** An optimystic rebuild at 16:39:43 briefly deleted `quereus-plugin-optimystic/dist/plugin.js`. Metro cached the failed resolution, so strand code (lazy-loaded at Connect) kept failing with `UnableToResolveError … /plugin` after the file came back, until Metro restarted with `--clear`. Pause the optimystic runner too before a device run, or restart Metro after its builds.

Tests after the edits: `yarn workspace @serfab/reference-app-rn test` 14 files / 209 tests pass, `typecheck` clean, `eslint` clean on the changed files.

## Driving the phone: lessons

The lessons from the blocked version still hold: one inspector client per device; walk the fiber tree, never `__r(id)`; no `async` in Hermes eval; park promises on a global. New ones:

- Git Bash rewrites `/sdcard/...` paths: set `MSYS_NO_PATHCONV=1` for `adb shell screencap` / `uiautomator dump`.
- Metro serves from the monorepo root: the bundle path is `packages/reference-app-rn/index.bundle`, not `index.bundle`.
- The party id lives only in React state and is never logged. To test a restart, type a fixed party id on both launches.
- The watcher's private state (`node.strandWatcher.knownStrands`, `forcePoll()`) and the control database (`node.getControlDatabase()`, find the object with `_acquireExecMutex`) are reachable from the fiber-found node. Consume every row of `eval` in probes.
