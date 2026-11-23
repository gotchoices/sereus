description: Founding a party costs about two seconds on disk, and the test that watches for a hang during founding gives it only fifteen — so a loaded machine fails the test even though nothing is wrong. Record what the step actually costs, give it a time limit that matches the one the product itself uses, and add a check that fails loudly the next time the cost grows.
architecture: docs/cadre/control-replication.md#every-control-table-has-a-collection-from-genesis
files: packages/cadre-core/src/control-database.ts (the NOTE on `commitEmptyControlCollections`), packages/cadre-core/test/control-database-solo-warm-start.spec.ts (`OP_TIMEOUT_MS`, lines 141 and 372), packages/cadre-core/test/control-start-storage-op-budget.spec.ts (where a genesis phase belongs), packages/cadre-core/test/storage-op-counter.ts (`OpSnapshot.barriers`), tickets/.pre-existing-known.md (the solo warm-start entry), docs/cadre/control-replication.md (Limits and accepted tradeoffs)
difficulty: medium
----

## What was measured

Everything below was measured on 2026-11-23 in a `check:published` worktree of sereus `3320a3bd` — npm Optimystic 1.29.1 and Quereus 5.6.1, no linked siblings — on an idle machine, driving `ControlDatabase.ensureOwnerKey` on a lone `CadreNode` that had already started. The figures are the subject of this ticket: they go into the source NOTE, the test bound's reason, and the new budget.

**Operation counts are deterministic.** 1,010 raw-storage operations over 105 distinct blocks per genesis, byte-identical across six runs and identical on `MemoryRawStorage` and `FileRawStorage` alike (the write-through cache is wired over both when the counter sits under it). Per method, `calls/distinct-blocks`:

```
saveMetadata 218/105, savePendingTransaction 109/105, saveMaterializedBlock 109/105,
saveRevision 109/105, promotePendingTransaction 109/105, saveProofEntry 109/105,
listPendingTransactions 105/105, getMetadata 70/70, getCommitProof 36/0, saveCommitProof 36/0
durability barriers, outside that total: flush 183
```

**Wall clock.** `FileRawStorage` 2,004–2,880 ms over six runs; `MemoryRawStorage` 105–353 ms. The disk figure is the one that matters, and the NOTE's 750–820 ms (2026-10-20, re-measured 2026-11-14, 32 collections then against 35 now) is what it has grown from.

**Where the time goes: durability barriers, not writes.** Timing every call into `IRawStorage` on three file runs put 1,754–1,872 ms of the ~2,100 ms inside the store, and of that, `flush` 183× cost 1,418–1,537 ms and `promotePendingTransaction` 109× cost 269–294 ms. Every other method together cost under 40 ms. Tracing the callers of `flush` on one 2,124 ms run splits the 183 into three groups:

| calls | total | caller |
| --- | --- | --- |
| 37 | 1,030 ms | `StorageRepo.commit` → `endGroup` |
| 37 | 405 ms | `StorageRepo.pend` → `endGroup` |
| 109 | 24 ms | `KvUnderReplicationLedger.record` → `beforeRecord` |

So 74 barriers — one at pend and one at commit, for each of 37 pend/commit pairs — cost 1,435 ms, about two thirds of the whole step. The other 109 are nearly free: they are the per-block shortfall-ledger flushes, which coalesce because the commit they order was already sealed. The 37 pairs are 35 empty collections plus the `OwnerKey` insert plus one more this measurement did not identify.

**The commit-proof store is not the cause.** `saveProofEntry` (109 calls), `saveCommitProof` (36) and `getCommitProof` (36) together cost under 30 ms of the ~2,100. The hypothesis on the `fix/` ticket this one comes from — that Optimystic 1.28.0's commit-proof store is where the time went — is refuted for wall clock; those writes are about 18% of the operation count and under 2% of the time.

**Syncing the collections concurrently does not help.** Patched in the throwaway worktree so `syncInventedCollections` issued every `collection.sync()` together and awaited them as one `Promise.all`, rebuilt, re-measured: 1,701/1,967/2,568 ms against 2,004/2,103/2,170 ms sequential. No improvement — the file store's write group serializes the syncs. Do not re-try this.

**What was not measured.** The per-commit barrier count on Optimystic 1.27.0, the release behind the 750–820 ms baseline. It was attempted in the same worktree (sereus `9bba27ea` with 1.27.0 and Quereus 5.4.0 pinned); yarn placed a second, nested copy of `@optimystic/db-p2p` under `db-p2p-storage-fs` and the mixed pair fails at the first commit inside `FileWriteLog.applyBatch`. So this ticket says nothing about which release added the pend-time barrier, and neither should the NOTE.

## Where to run this, while `../optimystic` is mid-change

The measurement above was taken in a throwaway `check:published --skip-gates --keep` worktree, not in this repository, because on 2026-11-23 the cadre-core suite could not run against the linked sibling checkout at all. Two reasons: the stale-build guard reported `@optimystic/db-p2p-storage-fs`'s `dist` stale (its `src/node-storage.ts` was being edited that afternoon), and the linked `@optimystic/db-p2p` now wants `NodeOptions.storage` as a whole `NodeStorage` value — `{ blocks, kv, pieces }` — where `CadreNode.buildControlNodeOptions` still passes a bare `IRawStorage`, so `start()` throws inside `prepareServingStore`. That is in-flight work in a read-only sibling (`a-node-takes-all-its-storage-as-one-value` on its board) and nothing here should chase it; it arrives with a release and a floor bump. If the suite still will not start when this ticket is picked up, run the specs in a `check:published --skip-gates --keep` worktree (build `@serfab/quereus-plugin-sereus` there first) and say so in the handoff.

## Why the test bound is wrong, not just tight

`control-database-solo-warm-start.spec.ts` puts every control operation under one `OP_TIMEOUT_MS` of 15 s, whose comment reads "Every operation here answers from local rows; this only catches hangs." That is true of `hasOwnerKey`, `getOwnerKeys` and `queryCadrePeers`. It is not true of `ensureOwnerKey`, which performs 37 durable commits and 74 fsyncs before it returns. Lumping it in with the local reads is the misclassification, and the 15 s bound is a throughput measurement wearing a hang detector's clothes: at 8 ms per fsync idle it passes with room, and on a machine whose fsyncs cost 100 ms it fails with nothing wrong.

The product bounds this same step at 60 s (`DEFAULT_OWNER_GENESIS_TIMEOUT_MS`, `packages/cadre-core/src/edge-node/config.ts`), and the spec already carries a 60 s `ADD_STRAND_TIMEOUT_MS` for the other step that does real work. A test bound tighter than the product's own bound for the same call reports a failure the product would not. 60 s is 28× the measured idle cost and still bounded, so it catches a hang.

## Why a budget, and why it goes where the other budgets are

The only thing that noticed this growth was a 15 s timeout in a liveness suite, which is why it surfaced as two flaky tests in `check:published` rather than as a number. `control-start-storage-op-budget.spec.ts` exists for exactly this and says so — it deliberately runs genesis *after* its cold snapshot and names the genesis as the cost it leaves unbudgeted. Giving it a third phase closes that hole: the counts are deterministic, they are the same in memory, and a growth fails with a per-method breakdown in the message instead of as a timeout somewhere else.

The barrier count has to be part of that budget, not just the operation total. The barriers are two thirds of the wall clock and `OpSnapshot.barriers` is deliberately excluded from `total`, so a change that doubled the fsyncs per commit while writing no extra blocks would pass an ops-only budget. `expectWithinBudget` has no barrier arm today; the genesis phase needs one.

The genesis phase's provenance is npm Optimystic 1.29.1, not an `../optimystic` commit, so it cannot share `MEASURED_ON`/`BASELINE_UPSTREAM` with the cold and warm phases as they stand. Say where each figure came from rather than making one constant mean two things.

These numbers are the cost of committing one collection at a time. They change when the batched commit on `blocked/report-control-genesis-commits-one-collection-at-a-time` lands upstream and is adopted — that is a deliberate, large drop to re-measure, which is exactly what a budget with provenance makes legible.

## TODO

- Replace the measurement paragraph of the NOTE on `ControlDatabase.commitEmptyControlCollections` with the figures above: 35 collections, 1,010 raw-storage operations over 105 distinct blocks and 183 flush barriers per genesis, 2.0–2.9 s on `FileRawStorage` and 0.1–0.35 s in memory, measured 2026-11-23 against npm Optimystic 1.29.1. Keep the structure the NOTE already has, and keep its closing instruction to ask Optimystic for a batched commit rather than building a private batching path — but name what the measurement found: the cost is two durability barriers per commit × 37 commits, so the lever is fewer commits, and `blocked/report-control-genesis-commits-one-collection-at-a-time` carries the request. Drop nothing that is still true; the per-operation phone-flash cross-reference to the NOTE in `initialize` stays.
- Add a `NOTE:` to `syncInventedCollections` (`packages/quereus-plugin-sereus/src/empty-collections.ts`) recording that issuing the syncs concurrently was measured and did not help, with the two sets of figures, so the next reader does not re-try it.
- Give `control-database-solo-warm-start.spec.ts` a separate bound for the genesis call — the two `within('ensureOwnerKey() (genesis)', …)` sites at lines 141 and 372 — at 60 s, with the reason: this call is 37 durable commits, not a local-row read; the product bounds the same step at `DEFAULT_OWNER_GENESIS_TIMEOUT_MS`; the bound is here to catch a hang. Correct `OP_TIMEOUT_MS`'s comment so it describes only the operations that do answer from local rows. Leave `registerSelf()` and the reads on `OP_TIMEOUT_MS` — one commit, and the measurement gives no reason to move them.
- Add a genesis phase to `control-start-storage-op-budget.spec.ts`, measured where the spec already measures: snapshot around the `ensureOwnerKey` call it already makes, over `MemoryRawStorage` under the counter. Budget the operation total, the distinct-block count and the flush-barrier count, each modestly above 1,010 / 105 / 183, and extend `expectWithinBudget` with the barrier arm (the existing two assertions' self-diagnosing message shape is the pattern). Record the provenance as npm Optimystic 1.29.1 on 2026-11-23, separately from the cold and warm phases' `../optimystic` baseline. Update the spec's head comment, which currently says the genesis is left unbudgeted.
- Rewrite the solo warm-start entry in `tickets/.pre-existing-known.md`: the idle baseline is now 2.0–2.9 s on `FileRawStorage` (not 750–820 ms), the cause of the failures is the per-operation bound being 15 s for a step that does 37 durable commits, and the confirm protocol should be the new one — compare `Committed 35 empty control collections in Nms` against about 2 s idle, and read a genesis that times out against the new 60 s bound as a real stall rather than load. State that the entry's own 2026-11-23 "superseded" addendum is resolved by this ticket.
- Add one item to "Limits and accepted tradeoffs" in `docs/cadre/control-replication.md`: founding a party commits one collection at a time, which costs about two seconds on file-backed storage and scales with the table count, because there is no API to commit several collections as one transaction; cite `blocked/report-control-genesis-commits-one-collection-at-a-time`. No measurements and no history in the doc — the source NOTE owns the figures.
- Run `yarn workspace @serfab/cadre-core test` for the two touched specs, and `yarn lint` (which runs `check:docs`) for the doc item.
