description: The cadre library hands the storage library one block store per data set, and the new release wants one combined value instead, measured against an amount of disk the operator gives the machine. Change how the library asks an embedding app for storage, and let the operator's disk limit finally mean something.
prereq: 1-optimystic-1-30-plugin-node-storage
architecture: docs/cadre/node.md#storage
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/edge-node/platform.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/edge-node/edge-node.ts, packages/cadre-core/src/edge-node/lazy-raw-storage.ts, packages/cadre-core/src/edge-node/index.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/test/storage-op-counter.ts, packages/quereus-plugin-sereus/src/cached-storage.ts, docs/cadre/node.md
difficulty: hard
----

# cadre-core takes one storage value per scope, and an allotment

Second of five tickets adopting Optimystic 1.30.0. Read ticket `1-optimystic-1-30-plugin-node-storage` first for the chain's state: the repository is already compiled against the linked 1.30.0 siblings, cadre-core has 13 typecheck errors at HEAD, and only ticket 5 can claim a green workspace. Read `../optimystic/.release-notes.pending.md` → "v1.30.0" and `../optimystic/packages/db-p2p/docs/storage.md` §8–§10 for the upstream contract.

This is one large ticket because `types.ts` cannot change without breaking every call site in the package at the same moment; there is no split that leaves an intermediate state building. The design below is settled — nothing here is left to the implementer to decide.

## The storage config

`StorageConfig.provider: IRawStorage | ((scope: string) => IRawStorage)` and `StorageConfig.quotaBytes` are replaced by:

```ts
export interface StorageConfig {
  /**
   * Open all of one scope's storage. Called once per scope per runtime lifetime, and
   * again for a scope whose runtime has stopped. Must hand back storage over the same
   * durable location on a second call, as the same object or a new one.
   */
  open(scope: string): Promise<NodeStorage>;
  /** How many bytes of this machine the operator gave each network this node serves. */
  allotmentBytes?: number;
}
```

Three decisions are in that shape, each with its reason.

**Asynchronous, so `lazyRawStorage` is deleted.** Every platform now has one call that opens all three stores, and IndexedDB's and SQLite's are asynchronous. `edge-node/lazy-raw-storage.ts` existed only because this seam was synchronous: it proxied one store, had to classify each optional `IRawStorage` member as forwarded or omitted at compile time, and had to omit `getStoreIdentity` (an accepted tradeoff recorded in its own `NOTE:`) because the real identity exists only after the open. Making the seam asynchronous deletes the module, its spec and that tradeoff, and lets the real identity reach `withReadCache`, which then dedupes by location rather than by object. It also lets each platform's `*NodeStorage()` factory run `assertOneMeasuredLocation`, so a key-value store or piece store placed outside what the block store measures fails loudly on IndexedDB and SQLite instead of quietly leaving those bytes out of every figure the node reports about itself.

`buildControlNodeOptions` and `resolveControlStorage` become `async`. The memo on `resolveControlStorage` becomes a memo on the in-flight promise as well as the resolved value, so two concurrent callers cannot open twice. `controlBackfillStorage` follows.

**`NodeStorage` and not `OpenNodeStorage`, because cadre-core still closes nothing.** That is today's rule (`RawStorageProvider`'s comment: "cadre-core disposes only its own cache wrapper — it never closes the store you returned"), and keeping it is what keeps hibernation and runtime rebuilds working: `levelDbNodeStorage` throws on a second call over one open handle, so a `close()` on strand stop followed by a reopen on relaunch would be a new ordering hazard for nothing. Stating the return type as `NodeStorage` puts the rule in the type — cadre-core cannot close what it cannot see a `close()` on. Embedders keep their `OpenNodeStorage` internally and close it themselves (the CLI at process exit, the edge node in `EdgeNodeStorage.close()`).

A hibernated strand therefore **keeps** its storage handle, and a resume reuses it; the provider is not re-entered. That answers the planning ticket's question, and it is the existing documented contract, kept.

**No single-instance form.** `StorageConfig` no longer accepts one store shared by every scope. `OpenNodeStorage` carries a `close()` that a shared instance would have closed once per scope; `levelDbNodeStorage` refuses a second call over one handle outright; and an embedder that genuinely wants sharing gets it better from upstream — `fileNodeStorage` hands back one set of stores per directory, counted by holder. No provider in this repository takes the single-instance form (`tickets/backlog/debt-shared-store-provider-never-exercised-end-to-end.md` says so and is retired by ticket 5). Dropping it also removes the `storeForScope` branch from `packages/integration-tests/test/control-node-config.spec.ts`, which ticket 4 owns.

Delete the deprecated, Node-only `getStrandStoragePath` with it (exported from `src/index.ts`, called by nothing but its own spec). It is a filesystem path helper for the layout this change replaces.

Also re-export `cohortOutOfSpaceOf`, and the `CohortOutOfSpaceError` type beside it, from `src/index.ts` — beside `appSchemaRefusalOf` and for the same reason (added by the review of ticket `optimystic-1-30-plugin-node-storage`). That ticket added the finder to `@serfab/quereus-plugin-sereus` and `docs/strands/writes.md` tells an app to use it, but the apps reach Sereus through this package: `reference-app-rn` declares neither the plugin nor `@optimystic/db-core`, so today it cannot name the error a failed write carries. One line, no behaviour.

## The read cache stays cadre-core's, through upstream's helper

`wrapStorageWithCache` / `disposeStorageCache` (`packages/quereus-plugin-sereus/src/cached-storage.ts`) are replaced by upstream's `withReadCache(storage, label)` from `@optimystic/db-p2p`, called on `storage.blocks` at the two seams that resolve a scope's storage, with the returned lease held for the scope's lifetime and released when the scope stops. Then the module and `packages/quereus-plugin-sereus/test/cached-storage.spec.ts` are deleted, and its export removed from the plugin's root.

Keep the wrap rather than letting the node do it. The node also calls `withReadCache` now, but it releases its lease when **it** stops, and cadre-core rebuilds a strand's libp2p node across runtimes over one store — on a hibernation wake and on every runtime rebuild. Upstream is explicit that sequential reuse starts cold once the previous lease released, so letting the node own the lease would lose the warm cache that `resolveStrandStorage`'s comment says it deliberately keeps ("so the wrap survives every runtime rebuild the instance goes through"). Handing the node a `blocks` that already reports `readCached` makes the node pass it through and take no lease — upstream's documented "a host that attaches its own read cache and hands the result in keeps owning it".

The cache reports the inner store's identity (`IRawStorage.getStoreIdentity`'s contract: a wrapper reports the value of the storage it fronts), so `blockStoreCountsPieces` still finds `blocks` and `pieces` in one location and does not count the pieces twice.

What cadre-core hands to a node is therefore `{ ...opened, blocks: cached }`. Build that in one place per seam so the two cannot drift.

Two readers inside cadre-core take the storage directly rather than through the node: `PeerJoinBackfill` (control and strand) and `strandStoreEmpty`. Both become `.blocks`, and both keep reading through the cache, as they do today.

## The allotment

`NodeOptions.storageAllotment.bytes` is how many bytes of this machine the operator gave the network; the node measures against the smaller of it and what the backend reports free. `StorageConfig.allotmentBytes` is passed as `storageAllotment: { bytes }` to the control node and to every strand node, **unchanged, not divided**.

That is the decision the planning ticket asked for, and the reasoning is that of 1.30's four responses to pressure, three are inert on a Sereus node today:

- **Ring move-in and move-out** need the rebalance reaction wired, and every Sereus node sets `rebalance: { enabled: false }` whenever its peer-join catch-up is armed — the default on both the control network (`cadre-node.ts`, at `controlBackfillStorage()`) and every serving strand (`strand-instance-manager.ts`, at `backfillArms`). Upstream leaves ring shifts inert without it, because a move-out is unsafe with no confirm/release path.
- **The released-block sweep** only has work once a ring shift or a confirmed rebalance release records a range in the ledger, so it is inert for the same reason.
- **Ring Zulu** is behind `arachnode.enableRingZulu`, which follows the `alwaysOn` role, and Sereus never set `arachnode.storage` or used `StorageMonitor` — so their removal upstream reaches no Sereus call site.

What is live is the read-cache budget (the smallest of `blobs.cacheBudgetBytes`, now a 256 MiB cap, an eighth of the total, and what other use leaves) and the refusal above 0.95. Handing each node the machine's number makes the cache budget **strictly tighter** than today's flat cap, and makes the refusal the first storage limit Sereus has ever enforced.

Dividing the number instead was rejected: a node's allotment is fixed when it is constructed and the strand count changes while the node runs, so any division is either stale for the nodes already built or forces a node rebuild on every strand launch.

What it costs, which `docs/cadre/node.md` must say: with N strands a machine can hold up to (N+1) × `allotmentBytes` before any one node refuses, so the number bounds one network's share of the machine rather than the machine. On a Node host the file backend reports free space, which the node measures against as well, so the disk still cannot be filled past its own size. Revisit when Optimystic can take one account across several nodes of a machine, or when Sereus turns ring shedding on (`tickets/backlog/later/5-ring-zulu-storage-rings.md`).

Sereus does not expose `thresholds` or `usedBytesCacheTtlMs`: nothing has measured a reason to move them, and one number is what an operator understands. Record that under the node doc's limits, not as a `NOTE:`.

`node.storageAccount` and `node.storagePressure` are per node and nothing in Sereus surfaces them. Leave it that way and record a tripwire at the seam that builds the options: if an operator ever asks how full a machine is, these two readings are per node and have to be summed across the control node and every strand node.

## A client strand node now gets storage

`startStrand` resolves no store at all when `roles.strandCohortMember` is `false`. Under 1.30 a client uses two thirds of the value — the key-value store for its HLC clock high-water mark, blob records and owed-blob ledger, and the pieces, which may be the only copy of a blob its own host put. `blocks` is required on both roles so one value serves either, and an unused block store costs nothing because every backend's constructor is lazy.

So resolve storage for **every** strand, client included, and pass it. `backfillArms` can no longer be "a store was resolved": it becomes `servesBlocks && config.backfill?.enabled !== false`. Walk every other reader of `strandStorages` and of the local `strandStorage` for the same assumption — the comments at `startStrand`, at the `storage` node option, and at `PeerJoinBackfill`'s arming each state "a client has no store", and each needs rewriting to "a client serves no blocks". `firstJoin` is already gated on `storageRepo !== undefined`, which a client's node lacks, so `strandStoreEmpty` is unreachable on a client; confirm that by inspection and say so at the site.

The `NOTE:` at the head of `peer-join-backfill.ts` asks for a persistent `kvStore` on strand nodes before this module is narrowed or deleted. It is satisfied by this change: rewrite it to say the under-replication ledger now survives a restart, and keep the rest of the argument for why the module exists.

## The edge-node seam

`EdgeNodeStorage` changes shape:

- `rawStorage(scope: string): IRawStorage` becomes `nodeStorage(scope: string): Promise<NodeStorage>`.
- `offlineJournal?(scope)` stays, and stays the platform's declaration that it supports offline mode (`edge-node.ts` reads its presence; absent, `setStrandOfflineMode` throws). Its contract gains one sentence: it returns the scope's own `NodeStorage.kv`, never a second key-value store over the same handle — upstream lists the journal's key prefix in `NODE_KV_NAMESPACES` for exactly that sharing, and a second store over one handle would not see the first one's unflushed writes.
- `allotmentBytes?: number` is new: what the platform declares for every node over this storage. The platform decides, and cadre-core applies no default — only the platform knows whether its backend reports free space. Export `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES = 2 * 2 ** 30` from cadre-core for the platforms that must declare one (ticket 3 wires React Native and NativeScript to it; the browser leaves it out, because IndexedDB reports the origin's estimate). Two gibibytes is a declaration and not a measurement: a phone app can plausibly give that much, and it is well above the 100 MiB below which upstream advertises the narrowest slice of the keyspace.
- `close()`'s contract is unchanged in words but now closes `OpenNodeStorage`s rather than block stores.

`buildEdgeNodeConfig`'s `storageProvider` input becomes the `open` function, and `allotmentBytes` is threaded onto the `storage` block.

## A full cohort is never retried

`CohortOutOfSpaceError` ends a write at once, with no retries, and is not retriable: nothing about the write's revision is the problem, so a re-read and rebase sends the same bytes to the same full members.

The control write retry would retry it anyway. `isUncommittedTransactorAggregate` claims a failure on the **phase** alone, whatever the cause inside says (its own comment says so, deliberately), so an out-of-space refusal arriving inside the transactor's promise-phase aggregate would be re-presented up to `CONTROL_WRITE_ATTEMPTS` and could spend the whole `CONTROL_WRITE_RETRY_BUDGET_MS` on a write that cannot succeed. That is a defect this adoption introduces if nothing is done.

Add a veto, not a matcher: `reportsCohortOutOfSpace(links)` in `control-retry.ts` beside `reportsUnreachableCohort`, checked in `matchesRetriableFailure` **before** any matcher runs, in the same position and for the same reason as `reportsPossiblyStoredWrite`. A veto rather than an omission from the matcher list, because the phase-level claim would otherwise re-admit it. It applies to all three shipped policies, since none of their opted-in bodies can make room on another machine.

## The budget specs

`control-start-storage-op-budget.spec.ts` and `strand-solo-write-budget.spec.ts` count calls into `IRawStorage` through `CountingRawStorage`. The agreement state that 1.30 now persists goes into `kv`, which that wrapper does not see, so the block-store counts may not move at all — the planning ticket's claim that they need re-baselining is unverified. **Measure, then re-baseline only what moved**, and update both the figure and its date in each spec's provenance comment, as those comments instruct. If a figure is unchanged, say so in the handoff; do not touch the comment.

## Edge cases and interactions

- **A provider that throws, now asynchronously.** `startStrand` resolves storage before anything is recorded so that a throwing provider leaves no instance behind; a rejected promise must behave the same. Check the ordering still holds with an `await` in it, and that `InvalidStrandIdError` still precedes the open (the scope-key assertion must run first — the id is also a libp2p protocol prefix).
- **Two concurrent first uses of the control scope.** `resolveControlStorage` is lazy, and `buildControlNodeOptions` and `startControlBackfill` both reach it. Memoize the in-flight promise, not only the result, or two opens race — and on LevelDB a second open over one handle throws.
- **`stop()` then `start()` on one `CadreNode`.** The provider is re-entered for the control scope and must hand back storage over the same location. Release the control read-cache lease on `stop()` and take a fresh one on the next open; a lease held past `stop()` keeps the cache claimed and the next open over that location warm but unreleasable.
- **`stopStrand` then a relaunch of the same strand.** Same shape, per strand. `disposeStrandStorage` becomes "release the lease and forget the entry"; it closes nothing.
- **Hibernate and wake.** `quiesceStrand` / `resumeStrand` must not re-enter the provider and must not release the lease — the point of holding it for the instance's lifetime. Pin this (see *Tests*).
- **A client strand node.** Storage is resolved and passed; `backfillArms` is false; `arachnode` and `rebalance` stay off it; `strandStoreEmpty` is unreachable. Every comment that says a client has no store is now wrong.
- **A node with no `storage` block at all.** Still allowed (the in-memory default), and upstream now logs one `node-wiring` `WARN:` naming what is lost. That channel is a `debug` channel, off unless `DEBUG=` is set, so it does not spam specs. Confirm that cadre-core passes no `storage` at all in that case rather than passing `memoryNodeStorage()`, so the warning an operator needs is not suppressed.
- **An allotment of the wrong shape.** Upstream throws at node construction for a `bytes` that is not an integer above 0. cadre-core passes the number through; decide nothing and validate nothing here, so there is one home for the refusal. State that where the option is documented.
- **Pieces counted twice.** Only if `blocks` and `pieces` report different identities. The cache carries the inner identity up, and each platform factory asserts one location, so this holds — verify by inspection at the seam that builds `{ ...opened, blocks: cached }`, and do not reorder it so that `pieces` comes from a different value than `blocks` did.
- **The two storage scopes of one party.** Unchanged: `controlStorageScope(partyId)` and each strand id, with `assertScopeKeyCharset` and `assertStrandScopeKey` where they are today. Nothing about the scope keys changes, and the existing `control-storage-scope.spec.ts` assertions stay meaningful.

## Tests

The compiler and the existing suites carry nearly all of this. Three behaviours have real branching and no type behind them:

- **The out-of-space veto.** `isRetriableControlWriteFailure` answers `false` for a `CohortOutOfSpaceError`, including when it arrives inside a promise-phase transactor aggregate that `isUncommittedTransactorAggregate` would otherwise claim. One case per policy is not wanted; one case for the default policy plus one for the aggregate shape is, in `test/control-write-retry.spec.ts` beside its siblings.
- **The provider is entered once per scope per runtime, and again after the scope stops** — the contract `control-storage-scope.spec.ts` and `strand-instance-manager-storage-ownership.spec.ts` already pin. Retype them; do not add cases.
- **A wake from hibernation does not re-enter the provider and does not release the lease.** `strand-instance-manager-storage-ownership.spec.ts` already asserts that the same storage reaches a rebuilt node; extend that file's existing quiesce/resume case to also assert the provider's call count, rather than adding a file.

Nothing new for the config retype, the allotment pass-through, the client's storage, or the edge-node seam: each is wiring or a type.

`edge-node/lazy-raw-storage.spec.ts` is deleted with its module.

## TODO

Phase 1 — the config and the two seams

- Replace `RawStorageProvider` and `StorageConfig` in `types.ts` with `open` and `allotmentBytes`; write the contract comments (called once per scope per runtime; re-entered after a scope stops; cadre-core closes nothing; what the allotment bounds and what it does not).
- `cadre-node.ts`: make `resolveControlStorage`, `controlBackfillStorage` and `buildControlNodeOptions` async; memoize the in-flight promise; wrap `blocks` with `withReadCache` and hold the lease; pass `storageAllotment`; release the lease on `stop()`; point `PeerJoinBackfill` at `.blocks`; add the storage-pressure tripwire `NOTE:`.
- `strand-instance-manager.ts`: resolve one `NodeStorage` per strand for every role; wrap and hold the lease per strand; pass `storageAllotment`; change `backfillArms` to read `servesBlocks`; point `PeerJoinBackfill` and `strandStoreEmpty` at `.blocks`; make `disposeStrandStorage` a lease release; delete `getStrandStoragePath` and its export; rewrite every comment that says a client has no store.
- `peer-join-backfill.ts`: rewrite the `kvStore` `NOTE:`.
- `control-retry.ts` and `control-write-retry.ts`: add `reportsCohortOutOfSpace` and veto on it before any matcher; document it in the module comment's list of vetoes.

Phase 2 — the edge node

- `edge-node/platform.ts`: `nodeStorage`, `allotmentBytes`, the `offlineJournal` contract sentence, the `close()` wording.
- `edge-node/config.ts` and `edge-node/edge-node.ts`: thread `open` and `allotmentBytes`.
- Delete `edge-node/lazy-raw-storage.ts`, its spec and its export; export `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`.

Phase 3 — the cache module

- Delete `packages/quereus-plugin-sereus/src/cached-storage.ts`, `test/cached-storage.spec.ts` and the package-root export, once nothing imports them.

Phase 4 — the specs

- `test/control-db-node-helpers.ts`: retype `fileStorageProvider` and `memoryStorageProvider` as scope-memoized `open` functions — the file one over `fileNodeStorage`, the memory one over `memoryNodeStorage()` memoized per scope so a restart over the same scope reads what the previous lifetime wrote (`control-store-migration.spec.ts` and `control-database-solo.spec.ts` depend on that). Every spec below then changes in one line.
- `test/storage-op-counter.ts`: add `deleteBlock` to `CountingRawStorage`, counted like every other block call.
- `test/peer-join-backfill.spec.ts`: add `deleteBlock` to `makeStorage`.
- Retype the 35 remaining spec and helper files that name a storage provider or a raw store: `cadre-node-control-backfill`, `cadre-node-control-node-options`, `cadre-node-dial-past-dead-addresses`, `cadre-node-issue-membership-invite`, `cadre-node-relay-boot-failure`, `cadre-node-relay-optional`, `cadre-node`, `control-database-close`, `control-database-offline-peers`, `control-database-solo-warm-start`, `control-database-solo`, `control-database-strand-peer`, `control-founding-consult-budget`, `control-schema-apply-unwind`, `control-start-storage-op-budget`, `control-storage-scope`, `control-store-migration`, `edge-node/config`, `global-setup`, `strand-approval-replay`, `strand-instance-manager`, `strand-instance-manager-backfill`, `strand-instance-manager-storage-ownership`, `strand-member-revocation`, `strand-membership-invite`, `strand-membership-manager-rotation`, `strand-membership-peer-registration`, `strand-membership-reconciler`, `strand-membership-writer`, `strand-pre-split-founder`, `strand-replica-claim`, `strand-scope-key-validation`, `strand-seal`, `strand-solo-write-budget`, `strand-spec-helpers`, `strand-transactor-handover`, `types`.
- Add the two retry cases; extend the quiesce/resume case with the provider call count.
- Run both budget specs; re-baseline only the figures that moved, with their dates.

Phase 5 — the doc

- `docs/cadre/node.md`: rewrite "Storage" (one value per scope, the three parts, the four platform openers, who closes what, the asynchronous opener, hibernation keeping its handle), rewrite "Available storage implementations" as the four openers, delete "A backend whose open call is asynchronous …" and the `lazyRawStorage` sentence, rewrite "The storage cache" around `withReadCache`, add an allotment section saying what the number bounds and what it does not, update the "Block storage" row of the configuration table, and replace the "Storage quotas are not enforced" entry under "Limits and accepted tradeoffs" with what is enforced, what over-commits, and that the thresholds are not exposed. Update the `storage.provider` mentions under "Node classes", "A node that holds no strand blocks" (a client now takes storage) and "What the platform supplies".
- Run `yarn workspace @serfab/cadre-core typecheck`, `test`, `yarn build` and `yarn lint`. Report the newly reddened downstream packages (cli, rn, host, provider, reference apps, integration-tests) as tickets 3 and 4's work, with their error counts.
