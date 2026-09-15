description: On a real Android phone the reference app cannot create a chat strand, because the Quereus SQL engine, as compiled for React Native, never releases its database lock when a query is stopped after its first row. The fix belongs to the Quereus project; this ticket waits for it to land, then needs someone with the phone to confirm strand creation works.
files:
  - ../quereus/tickets/implement/async-generator-finally-await-leaks-under-babel.md (the engine fix this waits on)
  - ../quereus/tickets/implement/lint-async-generator-finally-tail-await.md (Quereus's lint rule for the same code shape)
  - packages/cadre-core/src/strand-membership-writer.ts:256-283 (`strandTableCount`, `strandHasManagerRevocation` — the early-exit reads that trigger the hang)
  - packages/cadre-core/src/strand-database.ts:142 (`bootstrapFounder`, whose insert waits forever)
  - packages/reference-app-rn/app/settings.tsx (Create Chat Strand handler)
  - packages/reference-app-rn/metro.config.js (Metro reads the sibling `../quereus` checkout)
  - docs/testing.md (§ Lint coverage — the tripwire recorded by this ticket)
repro: verified
----

# Founding a strand on a solo phone hangs — waiting on the Quereus engine fix

## Why this is blocked

The defect is in `../quereus`, a separate repository, and confirming the fix needs a physical Android device. Nothing in this repo needs to change.

**Unblock when** `../quereus` ticket `async-generator-finally-await-leaks-under-babel` has reached its `complete/` folder, or is listed in `../quereus/tickets/.pruned-tickets.jsonl`, **and** someone can drive the phone.

## Root cause (found 2026-09-15, on the device)

- **The stuck step.** Strand founding runs `StrandDatabase.bootstrapFounder`, whose `db.exec('insert into Strand.Header …')` waits forever for Quereus's execution lock (`Database._acquireExecMutex`). The read just before it, `strandTableCount`, leaves its `for await (… of db.eval(…))` loop after the first row, and that early exit never released the lock.
- **Why only on the phone.** Hermes has no native async generators, so Metro's Babel compiles them. With that compiled form, when a consumer stops iterating, the generator's `finally` block skips everything after an `await` that is not the block's last action. Quereus's `_evalGenerator` ends with `finally { if (stmt) { await stmt.finalize(); } releaseMutex(); }`, so `releaseMutex()` never runs. Node runs generators natively and releases normally, which is why every headless run finished.
- **Evidence.** On the device: `execMutexDepth: 1`, with the pending chain `initialize` → `bootstrapFounder` → `exec` → `_withMutex` → `_acquireExecMutex`. A fresh in-memory Quereus database leaked the same way. Patching `Database.prototype.eval` in the live app so an early exit drains the iterator made a founding that always hung finish in 2.7 s (strand `active`, lock depth 0). Quereus's implement ticket adds a behaviour table measured with the Babel plugin alone, plus end-to-end runs of the engine under that compilation.
- **Earlier hypotheses, all ruled out:** the tap never reaching the handler, slow CPU on Hermes (the JS thread idled at about 5 %), a stuck WebRTC, LevelDB or `AbortSignal` wait, and a swallowed error.

## Checked in the fix stage (2026-09-15)

- **Quereus has the fix designed.** Its fix stage produced two implement tickets, uncommitted in `../quereus` at `e2efeb2a4`:
  - `async-generator-finally-await-leaks-under-babel`: rewrites the four unsafe `finally` blocks and adds a regression test that runs the engine compiled by Babel.
  - `lint-async-generator-finally-tail-await`: a lint rule for the code shape. It lists this ticket's slug as a consumer, so keep the slug unchanged.
- **`Database.get` does not hang, but it is not clean either.** `Statement.get` holds the lock in `_runWithMutex`, a regular async function, and only `break`s out of the row generator. A Babel model of that shape (the same `babel-preset-expo` 13.2.5 and `@babel/core` 7.29.0 that the RN app resolves, Node 24) showed:

  | shape | native | Babel |
  |---|---|---|
  | `get`-style: lock held by a regular async function, `break` out of a generator whose `finally` awaits before clearing `busy` | lock released, both disconnects run, `busy` cleared | lock released; **no disconnects, `busy` stays true** |
  | `eval`-style: the generator holds the lock and releases it after an `await` | lock released | **lock held** |

  So rewriting Sereus reads to use `db.get` would avoid the hang, but still leak the statement's inner-scan connections. Quereus's ticket fixes that site (`statement.ts` `_iterateRowsRawInternal`) too.
- **Sereus has no unsafe code of its own.** Its only async generator in shipping code is `scanMemberPeers` (`strand-membership-writer.ts:1154`), which has no `try/finally`. The RN app's own `db.eval` loops (`chat-operations.ts` `queryMembers`, `queryMessages`) read every row and never stop early.

## Decisions

- **No Sereus-side workaround.** The early-exit reads in cadre-core are all affected: founding, a second founding, manager resign, and the manager checks at `strand-membership-writer.ts:295, 330, 372, 376, 1597, 1680, 1686, 1759`. Draining each loop, or switching to `db.get`, touches every one of them for a problem the engine fix removes completely, and the `db.get` route still leaks as shown above.
- **No lint guard copied into Sereus now.** With one async generator and no `try/finally` in shipping code, a copy of Quereus's rule (a custom rule plus rule tests) would guard nothing that exists here. Recorded instead as a tripwire bullet in `docs/testing.md` § Lint coverage, with the revisit condition: adopt Quereus's rule once Sereus code that runs on React Native gains an async generator with a `try/finally`.
- **No Sereus regression test for the engine behaviour.** Quereus's Babel-compiled regression test owns it.

## When unblocked

- Build Quereus so Metro sees the fix: `yarn workspace @quereus/quereus build` in `../quereus` (Metro reads the sibling checkout's `dist` through the root `resolutions` link and `metro.config.js`; the Quereus root `build` also builds UI, VS Code and web targets, which are not needed). Record `git -C ../quereus log -1 --oneline` and `git -C ../optimystic log -1 --oneline`, and whether each tree was dirty.
- On the phone: Connect with an empty party id, then Create Chat Strand. Expect a `[settings] create strand <id8> pressed` line, then `succeeded in <n> ms` in logcat. Development builds also print `sereus:cadre:timing` start and end lines for every founding step. The runtime-patched run took 2.7 s. Any step with a start line but no end line is a new stall; name it.
- Exercise the other early-exit reads: create a second strand, send a message in the first, then force-stop, relaunch and Connect again and check that any strand the app brings back still accepts writes. This ticket did not check whether the app restores strands after a restart.
- If a hang remains, read lock depth and pending calls through the debugger (see below) before guessing.
- Once Quereus publishes a release containing the fix, raise the `@quereus/quereus` range in every Sereus package to it. `yarn dep-check` (`scripts/check-dep-ranges.mjs`) requires the declared range to match the linked version, and `yarn upgrade:quereus` does the bump. Without the bump, an app installing `@serfab/cadre-core` from npm can still get an unfixed Quereus.

## Doing the device run — lessons from 2026-09-15

- **Make sure nobody else is driving the phone.** Check `adb logcat -d | grep "Force stopping org.gotchoices"` and the list of local Claude sessions before tapping anything. On 2026-09-15 two sessions drove the device at once.
- **Metro's inspector proxy admits one debugger client per device.** A second WebSocket closes the first (close code 1005). With a single client on a clean launch, page 1 (the app runtime) answered `Runtime.evaluate` in 3–35 ms.
- **`__r.getModules()` does not exist in this Metro/Expo dev client, and `__r(<id>)` crashes the app** with a fatal "Requiring unknown module". To reach the node, walk React's fiber tree from `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots(rendererId)` to the context provider whose `memoizedProps.value` has `node` and `createStrand`.
- Hermes's `eval` rejects `async` syntax, and RN's `Promise` polyfill is invisible to CDP `awaitPromise`. Park async results on a global and poll it.
- Find buttons by text via `adb shell uiautomator dump` rather than fixed coordinates, and let a scroll settle before tapping.
- Take screenshots from bash (`adb exec-out screencap -p > file`); PowerShell `>` corrupts the PNG.

## Device and build used for the original observation

Galaxy Note 9 (SM-N960U), Android 10, debug build of `reference-app-rn` (Expo SDK 53, RN 0.79.6, Hermes), JS from Metro over `adb reverse`. On 2026-09-14 a tap on Create Chat Strand produced no dialog, `Strands 0`, and no JS log line for about 2 minutes. Solo Connect to node-up took about 6 s.
