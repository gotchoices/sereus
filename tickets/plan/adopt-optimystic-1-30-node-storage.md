description: Optimystic 1.30.0 changes how every node takes storage. A node gets one `NodeStorage` (`blocks`, `kv`, `pieces`) plus a storage allotment, and acts as it fills. The Quereus plugin takes `storageFactory` in place of `rawStorageFactory`. Adapt cadre-core, the plugin, the hosts and the reference apps, and decide how one machine's allotment is shared across its control node and its per-strand nodes.
architecture: docs/cadre/node.md#storage
files: packages/cadre-core/src/types.ts (`StorageConfig.provider`, `RawStorageProvider`), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/edge-node/lazy-raw-storage.ts, packages/cadre-core/src/control-write-retry.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/cadre-cli, packages/cadre-host, packages/cadre-provider, packages/cadre-rn, packages/reference-app-*, packages/integration-tests/src/harness, docs/cadre/node.md, docs/strands/writes.md
----

## Source

Optimystic 1.30.0, published 2026-11-25 (tag `v1.30.0`, `209882e5`; every `@optimystic/*` package is 1.30.0 on npm). Its release notes are on GitHub and in `../optimystic/.release-notes.pending.md` → "v1.30.0". It requires `@quereus/quereus` `^5.7.1`, so this adoption raises Sereus's Quereus floor too. The linked `../optimystic` (`v1.30.0`) and `../quereus` (`v5.7.1`) match the published versions.

**Quereus 5.7.** It refuses a view, materialized view, maintained table or assertion whose body contains a nested write; check that no Sereus schema (`schemas/*.qsql`, the control and Strand schemas) has one. In autocommit, a writing statement now opens its transaction before evaluating `values`, `set`, `where` and `returning`, so `StampId()` there no longer returns NULL. Check whether any Sereus workaround for that can go. Commit-time foreign-key and cross-table CHECK rules now judge each row as it stands at commit.

Optimystic says the release answers sereus#67, except that a node cannot yet free old revisions of blocks it still holds.

## What changes upstream, as it touches Sereus

- **One storage value per node.**
  - `NodeOptions.storage` is a `NodeStorage { blocks, kv, pieces }`. `kvStore`, `pieceStorage` and `transactionStateStore` are gone.
  - Each storage package has one opener: `fileNodeStorage(dir)` (`-fs`), `sqliteNodeStorage(db)` (`-ns`), `levelDbNodeStorage(db)` (`-rn`) and `indexedDbNodeStorage(db)` (`-web`). Each returns an `OpenNodeStorage` with `close()`. The node closes nothing it was handed.
  - Leaving `storage` out logs a `WARN:`. `memoryNodeStorage()` is the explicit memory choice.
- **Agreement state is now persisted** in `kv`, through `PersistentTransactionStateStore`. That costs disk (about 23 KB against 6 KB per row in a two-node group), so `strand-solo-write-budget.spec.ts` and `control-start-storage-op-budget.spec.ts` will need re-baselining.
- **`IRawStorage.deleteBlock` is required.** `LazyRawStorage` and the test doubles (`CountingRawStorage`, `SlowRawStorage`, `peer-join-backfill.spec.ts`'s `makeStorage`) must implement it.
- **Plugin.** `rawStorageFactory` and `blobStorageFactory` are replaced by `storageFactory: () => NodeStorage`, called once per `<transactor>:<keyNetwork>`, and only through `register()`. A plugin still passing the old names silently runs on memory. Blob pins of a node the plugin builds now survive a restart, which is the substance of `backlog/feat-strand-blobs-persist` and sereus#67.
- **Allotment.**
  - `NodeOptions.storageAllotment.bytes` sets the node's allotment. The node measures against the smaller of it and the disk's free space.
  - Only the file store and IndexedDB report free space. SQLite, LevelDB and memory nodes have a total only if the allotment is set; a node with neither logs a `WARN:` and does none of the following.
  - The node moves through stages, from slack to shedding to refusing. As it fills it shrinks its read cache, hands ranges to other machines and deletes what it handed over, and at the top it refuses new data.
  - `arachnode.storage` and `StorageMonitor` are removed; `arachnode` keeps only `enableRingZulu`.
- **A full cohort refuses writes.** `CohortOutOfSpaceError` (db-core) ends a write at once, with no retries. `classifyCommitFailure` sorts it as `cohort-out-of-space`, and the offline queue keeps the entry as `waitingFor: 'cohort'`. Sereus's control write retry and strand write paths must recognise it rather than retry, or report it as some other failure.
- **Mixed versions.** Every machine of a group upgrades together. A 1.29.1 coordinator counts an `out-of-space` vote as neither approval nor rejection.
- **Id validation.** Block, action and revision ids are validated in every backend. Ids the system mints are unaffected; check that no Sereus-made id, such as a strand id or a scope key, breaks the rules (`isValidBlockId`).

## Decisions this ticket must make (raise as `blocked/decide-…` if not clear-cut)

1. **The storage config shape.** Today it is `storage.provider: (scope) => IRawStorage`, with one scope for the control network and one per strand. The natural replacement is `(scope) => OpenNodeStorage`. cadre-core would then own `close()` for what it opened: on node stop, on strand hibernate and on strand removal. Confirm that a hibernated strand releases its storage handle and a resume reopens it.
2. **How the allotment is shared across one machine's nodes.** Optimystic measures one node at a time, but a Sereus machine runs a control node plus one node per strand, each over its own storage location. Options:
   - An operator-set machine allotment that cadre-core splits.
   - A per-scope allotment function in the config.
   - An allotment only for strand nodes, with the control network unmetered.

   For cadre-provider the allotment is a per-tenant quota, which may decide the shape. Recommend one, with what it costs a machine holding many strands.
3. **Platforms with no free-space reading** (RN on LevelDB, NativeScript on SQLite, tests on memory): which allotment each sets by default, so that they advertise a capacity and act on pressure.
4. **What an app sees when its strand's cohort is full.** `CohortOutOfSpaceError` reaches SQL with no error of its own. Decide whether the plugin or cadre-core names it for apps, and what the reference apps show.

## Outline of the work once decided

- Raise every `@optimystic/*` range to `^1.30.0` and every `@quereus/quereus` range to `^5.7.1` (`check:dep-ranges`).
- Migrate cadre-core's config, the node builders, `LazyRawStorage` and the test doubles. Then the plugin's `storageFactory` (also through `connect.ts` and `connect-browser.ts`), the CLI, host and provider configs, the RN kit and the reference apps.
- Classify `CohortOutOfSpaceError` in the control write retry and the strand write paths.
- Re-baseline the storage budgets with the new provenance.
- Update `docs/cadre/node.md` → "Storage", the config tables and the READMEs.
- Release notes: every machine of a party, and a strand's partners, upgrade together.
- Close or fold `backlog/feat-strand-blobs-persist` against the plugin change, and answer sereus#67.
