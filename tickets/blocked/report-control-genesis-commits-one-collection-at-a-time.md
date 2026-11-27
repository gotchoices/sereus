description: Setting up a new party writes thirty-five empty tables one at a time, and each write waits twice for the disk to confirm it — about two seconds in total, growing with every table added. The storage library already knows how to write several tables in one go, but only when ordinary data is being saved, so somebody needs to ask that project to make the same thing available here.
architecture: docs/cadre/control-replication.md#every-control-table-has-a-collection-from-genesis
files: packages/quereus-plugin-sereus/src/empty-collections.ts (`syncInventedCollections`, the one `sync()` per collection), packages/cadre-core/src/control-database.ts (`commitEmptyControlCollections` and its NOTE), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`legacyBatch`, `commitBatchLegacy` — the batch that already exists), ../optimystic/packages/db-p2p/src/storage/storage-repo.ts (`pend` and `commit`, the two flush sites), ../optimystic/packages/db-core/src/transaction/coordinator.ts (`TransactionCoordinator`)
difficulty: easy
----

# Human action: ask Optimystic for a way to commit several collections as one transaction

**Blocked category: a dependency outside this repository.** What unblocks it: an Optimystic release that exposes a batched commit over a set of collections — or a decision that the two-second founding cost is accepted and this ticket is declined.

**Filed 2026-11-26** in Optimystic as blocked/batched-commit-over-a-named-set-of-collections (optimystic 80b781e8), at the maintainer's request. This ticket now waits on that one.

## Why this is a human's call, not an agent's

The change belongs entirely in `../optimystic`. `tickets/rules/sibling-repos.md` forbids agents here from editing, building or filing in that repository, so somebody has to carry the request to its board. Nothing in Sereus has to change for the request to be filed; the Sereus-side work — recording the measured cost, correcting a test bound, adding a budget that catches the next growth — is `implement/control-genesis-gets-a-storage-budget-and-an-honest-test-bound` and does not wait on this.

## In plain terms

Before a party has an owner, the founding machine gives every one of its control tables an empty starting point, so that later reads of a table nobody has written can be answered from the machine's own storage instead of asking the other machines to prove the table empty. Today's schema has 35 of these — 19 tables, 3 indexes and 13 uniqueness checks — and each one is saved as its own separate transaction. Every transaction waits twice for the disk to confirm the write is really on it, once when the write is reserved and once when it is finalized. Those two waits are almost the whole cost: 74 of them, at roughly 20 ms each on a developer machine with a real disk, and the step takes about two seconds. The actual data is tiny; it is the waiting that is expensive.

The storage library already has the machinery to do this properly. When an ordinary SQL transaction touches several tables, their saves are gathered and pushed as a single transaction with a single pair of disk waits. What it has no way to do is gather up collections that are *empty* — nothing was written to them, so nothing marks them as needing saving, and the batch never sees them. That is the whole gap.

## What was measured

2026-11-23, in a `check:published` worktree of sereus `3320a3bd` with npm Optimystic 1.29.1 and Quereus 5.6.1 installed from the registry (no linked sibling checkouts), on an idle machine, driving `ControlDatabase.ensureOwnerKey` on a lone started `CadreNode`.

Per genesis, deterministic — byte-identical across six runs, and the same on `MemoryRawStorage` and `FileRawStorage`:

- **1,010 raw-storage operations over 105 distinct blocks**, three blocks per collection. Per method: `saveMetadata` 218, `savePendingTransaction` 109, `saveMaterializedBlock` 109, `saveRevision` 109, `promotePendingTransaction` 109, `saveProofEntry` 109, `listPendingTransactions` 105, `getMetadata` 70, `getCommitProof` 36, `saveCommitProof` 36.
- **183 durability barriers** (`flush`), which `IRawStorage` counts apart from the operations above because they order writes rather than write blocks.

Wall clock: 2,004–2,880 ms on `FileRawStorage` over six runs, 105–353 ms in memory.

Timing every call into `IRawStorage` on three file runs put 1,754–1,872 ms of the ~2,100 ms inside the store, and `flush` alone was 1,418–1,537 ms of it. `promotePendingTransaction` was 269–294 ms; every other method together was under 40 ms. Tracing which code calls `flush`, on one 2,124 ms run:

| calls | total | caller |
| --- | --- | --- |
| 37 | 1,030 ms | `StorageRepo.commit` → `endGroup` |
| 37 | 405 ms | `StorageRepo.pend` → `endGroup` |
| 109 | 24 ms | `KvUnderReplicationLedger.record` → `beforeRecord` |

The 37 pend/commit pairs are the 35 empty collections, the founding `OwnerKey` insert, and one more the measurement did not identify. Their 74 barriers cost 1,435 ms — about two thirds of the whole step. The shortfall ledger's 109 barriers are nearly free, because the commit each one orders was already sealed.

## The ask

Expose the batched commit that `TransactionBridge.commitBatchLegacy` already performs, so a founding step can hand over a set of collections and pay one pend and one commit for all of them. That method builds a `TransactionCoordinator` over exactly the collections of one commit with `pendValidation: 'none'`, pends them all, then commits them all; `legacyBatch` reaches it only from the bridge's dirty-tree set, which an invented-but-unwritten collection never joins. The request is for that path to be callable with a collection set the caller names — the same API strand founding would use, since it runs the identical step for its own schemas.

Expected effect, by arithmetic from the figures above rather than by measurement: 74 barriers become 4, removing about 1.4 s of the 2.1 s and leaving the 105 blocks' ~280 ms of `promotePendingTransaction` and under 60 ms of everything else — roughly half a second. Worth confirming after adoption, not before.

Two things are already ruled out and are worth saying in the report so the Optimystic side does not re-derive them:

- **It is not the commit-proof store.** `saveProofEntry`, `saveCommitProof` and `getCommitProof` together cost under 30 ms of the ~2,100. They are about 18% of the operation count and under 2% of the time. The earlier suspicion that Optimystic 1.28.0's proof store was where the time went is wrong for wall clock.
- **It is not something fewer barriers per commit could fix.** Two barriers per commit is the write-order invariant (`packages/db-p2p/docs/storage.md`), not waste. The lever is fewer commits.

## What was rejected, and why

- **Doing the syncs concurrently, in Sereus.** Measured: patching `syncInventedCollections` to issue every `collection.sync()` together and await them as one `Promise.all` gave 1,701/1,967/2,568 ms against 2,004/2,103/2,170 ms sequential — no improvement. The file store's write group serializes them. Do not re-try this.
- **Building a private batching path in Sereus** over `TransactionCoordinator` directly. It is reachable — the pieces are exported — but it would duplicate the bridge's batch, including its partial-commit recovery, in a repository that does not own those invariants. The NOTE on `commitEmptyControlCollections` has said not to do this since the step was written, and the measurement does not change that.
- **Making the empty collections look dirty** so an ordinary SQL commit sweeps them. Nothing in SQL writes to them, so the only way to mark them is a write-then-undo per table, which is worse than what it replaces.

## If nothing is done

Founding stays at about two seconds on file-backed storage and grows with every control table added — about 60 ms per added collection, and a table brings its indexes and uniqueness checks with it — paid by every new party on every device, and twice over for a machine that also founds a strand. On a phone's flash under launch contention a single storage operation costs 50–90 ms rather than 1, so the same step is tens of seconds there and reads as a frozen app; the product's own bound for it is 60 s (`DEFAULT_OWNER_GENESIS_TIMEOUT_MS`), which is the margin being eaten. Nothing is incorrect, and `implement/control-genesis-gets-a-storage-budget-and-an-honest-test-bound` makes the next growth fail as a budget with a breakdown rather than as a flaky 15 s timeout — so declining this is a reasonable call, not a silent one.

## How reversible

Fully. Adopting the batched commit replaces one loop in `syncInventedCollections` with one call. The budget figures this ticket's sibling pins are expected to drop sharply when it lands, which is a re-measurement, not a conflict.
