description: The cadre library now asks an embedding app for one combined storage value per data set instead of a block store, and the operator's disk limit is passed through to every node so it finally means something. Review the new seam, the full-cohort write refusal, and the honest gaps listed below.
prereq: 1-optimystic-1-30-plugin-node-storage
architecture: docs/cadre/node.md#storage
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/node-storage-cache.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/edge-node/platform.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, docs/cadre/node.md, docs/cadre/node-storage.md
difficulty: hard
----

# Review: cadre-core takes one storage value per scope, and an allotment

Second of five tickets adopting Optimystic 1.30.0. The design was settled in the implement ticket and was followed; what follows is what landed, what to exercise, and where the gaps are.

## What changed

**The config seam.** `StorageConfig.provider: IRawStorage | ((scope) => IRawStorage)` and `quotaBytes` are gone. In their place: `open(scope: string): Promise<NodeStorage>` and `allotmentBytes?: number`. `RawStorageProvider` is deleted as a type, and the deprecated Node-only `getStrandStoragePath` went with it (plus its export and its two spec cases).

**One shared helper puts the read cache on.** `packages/cadre-core/src/node-storage-cache.ts` is new and small: `cachedNodeStorage(opened, scope)` returns `{ storage: { ...opened, blocks: cached }, lease }` using upstream's `withReadCache`, and `releaseReadCacheLease(lease, label, log)` releases one without throwing. Both seams — `CadreNode` for the control scope and `StrandInstanceManager` for each strand — go through it, so the shape they hand a node and the question of who releases what cannot drift. This is a departure from the ticket's "one place per seam": one shared module rather than two parallel sites, which is what keeps them identical.

**`CadreNode`.** `resolveControlStorage`, `controlBackfillStorage` and `buildControlNodeOptions` are `async`. The in-flight open is memoized in `controlStorageOpening` alongside the resolved value in `controlStorage`, so two concurrent first uses open once; the body is split out as `openControlStorage`. `cleanup()` releases the lease and drops the field. `PeerJoinBackfill` now reads `.blocks`. The storage-pressure tripwire `NOTE:` sits at the `storageAllotment` spread.

**`StrandInstanceManager`.** Storage is opened for **every** role, client included, and `backfillArms` now reads `servesBlocks && strandStorage !== undefined && config.backfill?.enabled !== false` — the storage term is kept deliberately, because a node with no `storage` block at all still must not arm a catch-up that reads a store. `disposeStrandStorage` is a lease release that closes nothing. Every comment claiming a client has no store is rewritten.

**A concurrency hazard the `await` introduced, and its fix.** Making the open asynchronous put an `await` between `startStrand`'s `instances.has` check and its `instances.set`, so two concurrent `addStrand` calls for one strand each built a whole runtime and the second overwrote the first's record — leaving a built runtime nothing could stop. `publish-strand.spec.ts`'s "an attach that finds the strand mid-launch resolves only once that launch has built it" caught it. Fixed with a `launches: Map<string, Promise<StrandInstance>>` memo: the first call registers its promise synchronously and a second joins it, which is the same answer the tracked-instance early return already gives. `startStrand`'s body moved to `launchStrandInstance`, and the founder-drop warning became `warnIfFounderRequestDropped` so both early returns share it. **This is the one behavioural addition beyond the ticket's design — worth a careful look.**

**A full cohort is never retried.** `reportsCohortOutOfSpace(links)` in `control-retry.ts`, beside `reportsUnreachableCohort`, checked in `matchesRetriableFailure` before any claim. A veto rather than an omission, because `isUncommittedTransactorAggregate` claims a promise-phase aggregate on the phase alone and would otherwise re-admit an out-of-space refusal carried inside one.

**The edge-node seam.** `EdgeNodeStorage.rawStorage` → `nodeStorage(scope): Promise<NodeStorage>`; `allotmentBytes?: number` is new; `offlineJournal`'s contract gained the sentence about returning the scope's own `kv`. `edge-node/lazy-raw-storage.ts`, its spec and its export are deleted, and `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES` (2 GiB) is exported from `edge-node/platform.ts`. `buildEdgeNodeConfig`'s input is `openStorage` plus `allotmentBytes`.

**The cache module is gone.** `packages/quereus-plugin-sereus/src/cached-storage.ts`, its spec and its root export are deleted. `cohortOutOfSpaceOf` and `CohortOutOfSpaceError` are re-exported from `@serfab/cadre-core`.

**Docs.** `docs/cadre/node.md` was at 5,959 words of its 6,000-word budget, so the storage material could not grow in place. `## Storage` stays in `node.md` — keeping `#storage` resolvable for its six inbound doc links, the cadre-core README link and tickets 3/4/5's `architecture:` anchors — and states the option, the three parts and the allotment headline; everything else moved to the new **`docs/cadre/node-storage.md`** (scope keys, when the scope is opened, who closes it, the read cache, the five openers, the allotment, and the three accepted tradeoffs that replaced "Storage quotas are not enforced"). `docs/README.md` indexes it. Also updated: `getting-started.md`, `strands/lifecycle.md`, `strands/writes.md`, `packages/cadre-core/README.md`, and the dead `src/cached-storage.ts` link in the plugin README.

## Use cases to exercise

- **A `server`-class node over the filesystem.** `storage: { open: async (scope) => fileNodeStorage(`${dir}/${scope}`), allotmentBytes: N }`. The control node and every strand node should each receive `storageAllotment: { bytes: N }` — unchanged, not divided. Confirm the node's own free-space figure still bounds it.
- **A node with no `storage` block.** Optimystic must log its `node-wiring` `WARN:` naming what memory storage loses. cadre-core passes no `storage` key at all (conditional spread), which is what keeps that warning alive; passing `memoryNodeStorage()` would suppress it. Pinned by `cadre-node-control-node-options.spec.ts` → "leaves storage undefined when no storage config is supplied".
- **A client strand node** (`roles.strandCohortMember: false`). Storage IS opened and passed; `backfillArms` is false; `arachnode` and `rebalance` stay off; `strandStoreEmpty` is unreachable because a client's node builds no `storageRepo` (confirmed by inspection, noted at both sites).
- **Two concurrent `addStrand` calls for one strand** → one instance, one open. **Two concurrent first uses of the control scope** → one open (pinned: "opens the scope once even when two callers ask before the first open settles").
- **Hibernate and wake.** `quiesceStrand` then `resumeStrand` must not re-enter `open` and must not release the lease. Pinned in `strand-instance-manager-storage-ownership.spec.ts` → "opens the scope once per strand id across quiesce -> resume, and keeps the lease", which now asserts the pool count across the whole cycle.
- **`stop()` then `start()` on one `CadreNode`, and `stopStrand` then relaunch.** The scope is re-opened and a fresh lease taken; a lease held past the stop would leave the cache claimed and unreleasable.
- **An opener that rejects.** `startStrand` must leave nothing tracked, and `InvalidStrandIdError` must still precede the open (`assertStrandScopeKey` runs first; `strand-scope-key-validation.spec.ts` asserts the opener is never reached).
- **A write to a full cohort.** `isRetriableControlWriteFailure` answers `false`, bare and inside a promise-phase aggregate.

## Tests

Added — three behaviours with real branching and no type behind them:

| Test | What it verifies |
|---|---|
| `control-write-retry.spec.ts` → "never retries a cohort with no room, even inside a pend aggregate" | The out-of-space veto, bare and wrapped in the promise-phase aggregate that `isUncommittedTransactorAggregate` claims on the phase alone. Two arms in one `it`, since it is one behaviour and the second arm is the one that needs the veto rather than an omission. |
| `cadre-node-control-node-options.spec.ts` → "opens the scope once even when two callers ask before the first open settles" | The in-flight memo: `buildControlNodeOptions` and `startControlBackfill` both reach the resolver, and LevelDB throws on a second open over one handle. |
| `cadre-node-control-node-options.spec.ts` → "passes the operator allotment through unchanged, and states none when there is none" | The allotment reaches the node unchanged and is absent when unset. Arguably wiring; kept because "unchanged, not divided" is the decision this ticket made and the one a future edit would quietly undo. |

Retyped rather than extended, as instructed: `control-storage-scope.spec.ts`, `strand-instance-manager-storage-ownership.spec.ts` (whose quiesce/resume case gained the provider call count and the lease assertion), and the ~30 other spec and helper files. `control-db-node-helpers.ts`'s two providers became scope-memoized `open` functions over `fileNodeStorage` / `memoryNodeStorage`. `CountingRawStorage` gained `deleteBlock`; so did `peer-join-backfill.spec.ts`'s `makeStorage`. `edge-node/lazy-raw-storage.spec.ts` and `quereus-plugin-sereus/test/cached-storage.spec.ts` are deleted with their modules. Two assertions in `control-storage-scope.spec.ts` now compare `blocks`/`kv`/`pieces` rather than the wrapper object, because `cachedNodeStorage` builds a fresh `{ ...opened, blocks }` per open.

## Validation

`@serfab/cadre-core`: typecheck clean, `build` clean, **199 files / 2,709 tests passed, 1 skipped**. `@serfab/quereus-plugin-sereus`: 14 files / 148 passed. `yarn lint` (ESLint + `check:docs`) clean across 67 Markdown files. Integration tests were not run — ticket 4 owns that harness and it does not compile yet.

**Budget figures, measured on 2026-11-25 at optimystic `a7b1595e` (clean sibling tree), and fully attributed:**

| Phase | Was | Now | Why |
|---|---|---|---|
| Control cold start | 63 / 38 blocks | **66** / 38 | +1 the storage account's one start-up `getApproximateBytesUsed` (1.30.0); +2 the commit-proofs store from Optimystic 1.28.0 (`f53e7990`, 2026-11-17), which these figures had never been re-measured for |
| Control warm restart | 13 / 3 | **14** / 3 | the same start-up scan; a warm restart commits nothing |
| Control genesis | 1010 / 105 | **1010** / 105 — unchanged, not touched | — |
| Strand launch | 423 / 42 | **424** / 42 | the same start-up scan |
| Strand insert | 88 / 2 | **88** / 2 — unchanged | — |
| Strand select | 0 | **0** — unchanged | — |

Every figure stayed inside its existing ceiling, so neither spec failed; both provenance comments and their dates are updated, and the unchanged phases were left alone. The planning ticket's guess that the block-store counts would need re-baselining was right for a reason it did not name — the agreement state 1.30 persists does go to `kv`, which `CountingRawStorage` does not see, and the deltas above are the account's scan plus a 1.28.0 change nobody had re-measured.

**Downstream reds, as expected** (tickets 3 and 4): `@serfab/cadre-cli` 3, `@serfab/cadre-rn` 2, `@serfab/reference-app-web` 3, `@serfab/reference-app-ns` 3, `@serfab/reference-app-rn` 2, `@serfab/integration-tests` 10. `@serfab/cadre-host`, `@serfab/cadre-provider` and `@serfab/config-check` are **0** — they never named the storage seam.

## Known gaps — treat this as a starting point

- **`control-database-solo-warm-start.spec.ts`'s stated property #1 is now stale, and was already shaky.** Its head comment claims "each run builds a fresh `FileRawStorage` over the same directory, so nothing but the bytes on disk crosses from one run to the next". That was already untrue for the way the spec is written — it shares ONE `fileStorageProvider` across restarts, whose per-scope memo hands back the same object — and `fileNodeStorage`'s own process-wide one-set-per-directory registry now makes a cold handle over warm bytes unobtainable through that helper at all. I corrected `fileStorageProvider`'s own doc to say what it really gives (the same directory and real bytes, not a fresh handle) and left the spec's prose alone, since the behaviour it exercises did not change. **The spec's claim #1 still needs rewording, or the spec needs to construct the three file stores itself to get the property back.** Judgment call either way; I did not want to weaken a reproduction case for `solo-warm-start-blocks-on-prior-cohort-peers` without a measurement.
- **The `launches` memo is not cleared by `stop()`.** An in-flight launch during a `stopAll` completes and records its instance after `stopping` is set. The entry self-clears in its own `finally`, and `isCurrentRuntime` already checks `!this.stopping`, so this is the pre-existing shape rather than something the memo adds — but the memo is new code on that path and deserves a second pair of eyes.
- **`fileStorageProvider` never closes its `OpenNodeStorage`s**, so a directory's write-ahead log is never checkpointed and its lock never released inside the process; the caller removes the directory instead. Unchanged in kind from before, but it is now three stores per scope rather than one block store. The Windows `rmSync` retry comment in the warm-start spec is the thing that would notice if a handle outlived a stop.
- **Only `getApproximateBytesUsed` was attributed in the budget deltas by reasoning plus one dated upstream commit, not by an A/B run.** If a reviewer wants it nailed down, the breakdown lines are printed by both specs on every run.
- **`docs/platforms/browser.md` and `docs/platforms/nativescript.md` still describe `EdgeNodeStorage.rawStorage` and `lazyRawStorage`, which no longer exist.** Deliberate: ticket 3 owns both files and both platforms' wiring, and its TODO names them. They are wrong in the tree until ticket 3 lands.
- **`packages/cadre-cli/README.md` still documents `storage.quotaBytes`.** Ticket 3's, same reasoning.
- **The allotment's live effects were not observed**, only reasoned from upstream's documented behaviour: no test drives a node to 0.95 of an allotment to watch a refusal, and none measures the cache budget tightening. The refusal's classification IS tested; its triggering is not reachable without filling a store.
