description: An app that restarts and reconnects to a party it already had strands in now gets those strands back, instead of showing nothing because the node announced them a fraction of a second before the app was listening.
files:
  - packages/cadre-core/src/cadre-node.ts (`discoveredStrands` field ~395; `getDiscoveredStrands()` ~881; `handleStrandAdded` ~3931; `cleanup` ~4070; `addStrand` ~4390; `stopStrand` doc ~5670; `detachStrand` ~5706)
  - packages/cadre-core/src/types.ts (`'strand:discovered'` doc ~1118-1142)
  - packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts (four regression arms + the shared bare-watcher harness)
  - packages/cadre-core/test/control-db-node-helpers.ts (`memoryStorageProvider` hoisted here, ~173)
  - packages/reference-app-rn/src/use-cadre.ts (`claimDiscovered` + in-flight guard ~196, drain ~229)
  - packages/reference-app-rn/test/react/use-cadre.spec.ts (`MockNode.getDiscoveredStrands`, payload-carrying `emit`, `discovered-strand backlog` block)
  - docs/architecture.md (Cadre Node bullet 3; the `stopStrand` vs `unpublishStrand` paragraph ~614)
  - packages/reference-app-rn/README.md (Key Concepts → Control network)
----

# Unclaimed strand discoveries are claimable after the announcement — landed

## What was wrong

`CadreNode` polls the control database's `Strand` table. A row it holds no sApp config for was announced once as `strand:discovered` and then forgotten — the watcher keeps the id in its `knownStrands` and no later poll re-offers it. sApp configs are in-memory only and `stop()` clears them, so after a restart *every* stored strand took that branch, and the announcement fired from the watcher's first poll while the embedding app was still inside its own `start()`. Every discovery went into an empty listener list. On a phone, reconnecting to a party you already had strands in showed `0 strand(s)`, permanently.

## What landed

The unclaimed set is node state rather than a one-shot notification: a private `discoveredStrands: Map<string, StrandRow>` maintained in `handleStrandAdded` (recorded before the emit), `addStrand` (claimed → removed), `detachStrand` (stopped, or control row gone → removed) and `cleanup` (cleared), read through `getDiscoveredStrands()`, which returns a snapshot. The `strand:discovered` event is unchanged.

The contract — fired once per strand per session, can fire before your listener exists, so subscribe **then** drain, and make the join idempotent — is now stated in the `'strand:discovered'` doc in `types.ts` and in prose in `docs/architecture.md`.

The React Native app factors its join into one `claimDiscovered` used by both the event and a catch-up drain, subscribes before draining, and guards with a set of ids whose claim is in flight (the `getStrands().has(id)` check alone is not enough — the strand manager tracks an instance only once `addStrand` resolves). Closed strands (`Type:'c'`) are still left for the invite handshake.

`memoryStorageProvider()` moved out of `control-founding-consult-budget.spec.ts` into `control-db-node-helpers.ts` beside `fileStorageProvider`, since the restart arm needs the same "same blocks, new node" provider.

## Review findings

**Verified first.** Read the implement diff (`0234f1a`) before the handoff, then read `StrandWatcher` end-to-end, every `discoveredStrands` site, and every claim/teardown path that could strand an entry (`addStrand`, `foundStrand` → `addStrand`, `stopStrand`, `handleStrandRemoved`, `unpublishStrand`, the watcher's provisional-reject path, `cleanup`). The state machine is closed: every path that claims or tears down a strand removes it, and a node that never started can still run both watcher callbacks.

**Fixed in this pass (minor).**

- `CadreNode.addStrand`'s doc claimed a failed launch "keeps being re-attempted in the background … until it succeeds". That is true only for a launch the **watcher** drove. A strand claimed after being discovered is already in `knownStrands`, so no poll re-offers it, and `addStrand` has already dropped it from the backlog — there is no background retry at all. Doc corrected to say what happens, and to point at the ticket below.
- `docs/architecture.md` (the `stopStrand` vs `unpublishStrand` paragraph) still said a locally stopped strand is "rediscovered on the next restart or poll" — the same half-truth the implementer corrected in the `stopStrand` code comment but did not carry into the doc. Corrected there too.
- `packages/reference-app-rn/README.md` → Key Concepts described auto-join as purely event-driven. Added the relaunch half (subscribe, then drain `getDiscoveredStrands()`), since that is the user-visible behavior this ticket bought.
- The RN spec's in-flight-guard test set a never-settling `joinChatStrand` with `mockReturnValue`. `resetHarness` calls `vi.clearAllMocks()`, which clears calls but **not** implementations, so that never-settling join leaked into every later test in the file — harmless today only because nothing later awaits it. Changed to `mockImplementationOnce`.

**Test gap closed (minor).** The docs assert that an entry leaves the backlog when its control row disappears, and nothing covered it — only the claim path was asserted. Added a fourth arm to `discovered-strands-late-subscriber.spec.ts`: the row vanishes between two polls and the backlog empties. Confirmed it fails without the fix (removing `discoveredStrands.delete` from `detachStrand` reproduces `expected [ 'unpublished-…' ] to deeply equal []`), and the three existing arms' setup was folded into one shared `bareWatcher` helper rather than copied. Whole file: 4 tests, ~690 ms.

**Filed (major).** `backlog/bug-discovered-strand-lost-when-claim-fails` — a claim that *fails* retires the strand for the rest of the session. `addStrand` removes it from the backlog before the launch that can fail, the watcher will not re-offer a strand it knows, and its retry backoff only covers launches it drove itself; the RN app warns and gives up. Same user-visible symptom this ticket fixed, reached by a transient launch failure instead of by timing. Pre-existing (the one-shot event had the same dead end), not a regression, and it needs a decision about what the unclaimed map means while a claim is in flight — which is why it is a ticket and not an inline fix. `repro: static`; the ticket names the arm that would confirm it and the harness to write it against.

**Reviewed and left alone.**

- The tripwire `NOTE:` in `use-cadre.ts` (the in-flight set is per effect run, so `StrictMode` or a new effect dep would need a `useRef`) is the right disposition: `startPhoneNode` mints a **new** `CadreNode` whenever the old one is not running, so the OS-kill/foreground-resume path genuinely re-runs the effect against a different node and drains its backlog. Verified in `cadre-phone.ts`; `StrictMode` is not in use.
- `getDiscoveredStrands()` returning a copy while `getStrands()` returns the live map: the copy is the safer half of the asymmetry and matches `StrandWatcher.getKnownStrands()`. The live-map accessor is the pre-existing wart; not worth churning here.
- No cap on the backlog: bounded by this party's strands that this node does not run, and party-scoped control storage keeps that small. Arm 2 is what notices if the party scoping regresses.
- Other tests' private memoised storage providers (`strand-solo-write-budget.spec.ts`, `control-storage-scope.spec.ts`) are deliberately different objects (a counting wrapper; bare non-`MemoryRawStorage` objects), so the hoisted `memoryStorageProvider` does not subsume them.
- `cadre-node.ts` size: already tracked by `backlog/debt-cadre-node-single-file-size`; this change adds a field, an accessor and four one-line deletes.
- `reference-app-web` / `reference-app-ns` still do not subscribe to `strand:discovered` or call `getDiscoveredStrands()`, re-confirmed by grep across all packages, so neither needed the drain.

**No security or resource-cleanup findings**, and no correctness finding in the new code itself: the map is per-node state cleared in the single `cleanup()` teardown, holds only rows already replicated into this party's control database, and adds no listener, timer or handle to release.

**Still unverified: the device scenario.** No phone was available in either session, so "create a strand, send a message, force-stop, relaunch into the same party, confirm the strand and its history return" remains unrun against the fix, and the ticket's 2157 ms hand-forced re-attach figure has no post-fix counterpart. Arm 1 runs the same sequence against a real `CadreNode` in process, which is the closest thing here.

## Validation

All run from a clean tree after the review edits, all green:

```
yarn lint
yarn typecheck                                 # repo-wide; includes the test-file/vitest coverage guards
yarn workspace @serfab/cadre-core test         # 130 files, 2129 passed | 1 skipped
yarn workspace @serfab/reference-app-rn test   # 14 files, 213 passed
```

The one skip is the pre-existing `it.skipIf(process.platform === 'win32')` in `key-store.spec.ts`. Nothing was skipped, disabled or loosened. The RN suite's stale-build guard required `yarn workspace @serfab/cadre-core build` after the source doc edit — expected, not a defect. No `tickets/.pre-existing-error.md` was written: no test failed.
