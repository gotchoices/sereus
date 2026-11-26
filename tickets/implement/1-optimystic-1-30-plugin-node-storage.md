description: Our SQL layer hands the storage library three separate stores and the new release takes one combined value instead, so the layer no longer compiles. Give it the combined value, and give apps a way to tell "the group of machines holding this data has no room left" apart from every other failed write.
architecture: docs/strands/writes.md
files: packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/plugin.ts, packages/quereus-plugin-sereus/src/plugin-browser.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/quereus-plugin-sereus/README.md, docs/strands/writes.md, every package.json declaring @optimystic/* or @quereus/quereus
difficulty: medium
----

# The Quereus plugin takes one storage value, and names a full cohort

First of five tickets adopting Optimystic 1.30.0. Read `../optimystic/.release-notes.pending.md` → "v1.30.0" first; it is the authority on what changed upstream. The sibling checkouts are already at `v1.30.0` and `v5.7.1`, the root `resolutions` link them in, and the declared `^1.29.1` / `^5.6.1` ranges already admit them — so **the repository is compiled against 1.30.0 today and does not typecheck**. Measured at this ticket's HEAD with `yarn workspace <name> typecheck`:

| Workspace | Errors |
|---|---|
| `@serfab/quereus-plugin-sereus` | 3 — `connect.ts:28`, `connect-browser.ts:53`, `test/e2e/networked.e2e.spec.ts:113` |
| `@serfab/cadre-core` | 13 — ticket `2-optimystic-1-30-cadre-core-node-storage` |
| `@serfab/integration-tests` | 3 — ticket `4-optimystic-1-30-integration-harness` |

Every other workspace is green only because it typechecks against the **built** `dist` of cadre-core and this plugin, which still carry the old types. Each ticket in this chain makes its own package green and reddens the packages downstream of it; **only ticket 5 can claim a green `yarn typecheck` for the whole workspace.** State that in each handoff rather than reporting a red tree as a failure.

## What this ticket changes

### One storage value through the composition

`NodeStorage` (`../optimystic/packages/db-p2p/src/storage/node-storage.ts`) is `{ blocks: IRawStorage; kv: IKVStore; pieces: IPieceStore }`, and `OpenNodeStorage` adds a `close()`. Every storage package opens all three over one location in one call — `fileNodeStorage(basePath)`, `indexedDbNodeStorage(handle)`, `sqliteNodeStorage(handle)`, `levelDbNodeStorage(handle)` — and each asserts before returning that all three sit inside the one location the block store measures (`assertOneMeasuredLocation`). Nothing closes a store the node or the plugin was handed; whoever opened it closes it.

So in this package every `IRawStorage` that means "this strand's storage" becomes a `NodeStorage`:

- `StrandConnectionOptions.storage`
- `ResolveStorageContext.requestedStorage`, and `StrandPlatform.resolveStorage`'s return
- `CreateNodeContext.storage`, which both `connect.ts` and `connect-browser.ts` spread into `createLibp2pNode`

### The plugin setting is `storageFactory`

`rawStorageFactory` and `blobStorageFactory` are gone upstream; `storageFactory: () => NodeStorage` replaces both, is read through `register()` only, and is called once per `<transactor>:<keyNetwork>`. **A plugin that still passes the old name is not refused — it silently runs on memory**, and nothing here can catch that, because `pluginConfig` is a `Record<string, unknown>`. In `registerStrandPlugins`, `pluginConfig.rawStorageFactory = () => storage` becomes `pluginConfig.storageFactory = () => storage`, still only on the `local` transactor. Pin the key name with a test, since no compiler and no runtime error stands behind it.

### The read-cache wrap moves upstream

Optimystic 1.30 adds `withReadCache(storage, label)`: one write-through read cache per backing store, shared under a lease, keyed by `getStoreIdentity()` when the backend reports one and by object otherwise. Both the node (`resolveStorage` in `libp2p-node-base.ts`) and the Optimystic plugin's `CollectionFactory` now go through it, and both skip a store that already reports `IRawStorage.readCached`. That is what `cached-storage.ts` in this package was built to do, with a weaker key (a `WeakMap` on the inner instance alone).

So `composeStrand` stops wrapping: delete the `wrapStorageWithCache` call, the `storageCacheReleased` latch, `releaseStorageCache` and every call of it. Whoever composes below takes the lease.

**Do not delete `cached-storage.ts` in this ticket.** cadre-core still imports `wrapStorageWithCache` and `disposeStorageCache` from this package's root; ticket 2 moves it to `withReadCache` and deletes the module and its spec then. Leave the module and its export in place, unused here.

### `storage_path` opens a node storage

`parse-config.ts` carries `storagePath` beside the options because a storage value is not a `SqlValue`; that stays. `plugin.ts` changes what it resolves the path to:

```ts
const { fileNodeStorage } = await import('@optimystic/db-p2p-storage-fs');
options.storage = fileNodeStorage(storagePath);
```

`fileNodeStorage` returns one set of stores per directory per process, counted by holder, so two `register()` calls over one `storage_path` share them and the stores close when the last holder closes. Nothing in this package closes it; note at the site that the handle outlives `plugin.dispose()` and belongs to the host, which is already the rule for `storage_path`. `plugin-browser.ts` keeps refusing `storage_path`; move its wording off `FileRawStorage`.

### The browser default opens all three, and the offline journal is the node's own key-value store

`connect-browser.ts` becomes `indexedDbNodeStorage(defaultedDb)` in place of `new IndexedDBRawStorage(defaultedDb)`, and `defaultOfflineJournal()` returns that storage's `kv` rather than constructing a second `IndexedDBKVStore` over the same handle. Upstream declares the offline journal's key prefix (`OFFLINE_JOURNAL_KEY_PREFIX`, `'optimystic-offline/'`) as one of `NODE_KV_NAMESPACES` so that a host may hand the node and the journal one store, and a second key-value store over one handle would not see the first one's unflushed writes. One store, one write group.

`NOTE:` at the site — the handle this entry point opens itself is still never closed, because `StrandPlatform` has no shutdown seam to close it through, exactly as before this change. If a browser host ever reports a database it cannot delete while the tab lives, give the platform a release hook.

### A full cohort gets a name apps can read

At `refusing` a node refuses a pend its cohort asks it to store, with a signed `out-of-space` vote, and the writer's statement ends at once with no retries in `CohortOutOfSpaceError` (`@optimystic/db-core`), naming the full members in `peerIds`. **Upstream gives it no SQL error of its own**, so an app on a strand sees only the message of a failed `db.exec`, indistinguishable from a contention or reachability failure.

Add a finder beside the existing `appSchemaRefusalOf`, exported from the package root:

```ts
/** The `CohortOutOfSpaceError` in `error`'s cause chain, or `undefined`. */
export function cohortOutOfSpaceOf(error: unknown): CohortOutOfSpaceError | undefined;
```

A finder and not a new error class: the error already carries everything an app needs (`peerIds`, `approvals`, `peerCount`, `needed`), a wrapper would be one more shape to keep in step with upstream, and `appSchemaRefusalOf` is the precedent for a classifier over a cause chain. Walk the chain the way that function does.

`docs/strands/writes.md` gains what an app sees: the condition, that it is neither retried nor retriable (nothing about the write's revision is wrong, so a re-read and rebase sends the same bytes to the same full members), that an entry already in an offline queue stays `queued` with `waitingFor: 'cohort'` under its usual backoff rather than counting as an unclassified failure, and that an app tells it apart with `cohortOutOfSpaceOf`. The reference apps show the error's message unchanged — they already surface a failed write's message, and a message naming the full machines is the useful thing to show. That is a decision, so record it in the doc rather than leaving it to be asked again.

### Dependency floors

Raise every declared range to `@optimystic/*` `^1.30.0` and `@quereus/quereus` `^5.7.1` across the whole workspace in this ticket — peer, dev and ordinary dependencies alike — so the repository declares what it is already built against. `yarn check:dep-ranges` passes before and after; the change is what makes the declaration honest. Do not touch anything under `../optimystic` or `../quereus`.

Quereus 5.7 brings three changes that were checked against this repository and reach nothing:

- **No Sereus schema contains a view, materialized view, maintained table or assertion** (`schemas/*.qsql`, and no `create view` anywhere under `packages`), so the refusal of a nested write inside one cannot fire.
- **`StampId()` in an autocommit write** — Sereus never calls the SQL function. `generateStampId` in `control-database.ts` is Sereus's own nonce generator, unrelated, so there is no workaround to remove.
- **A commit-time foreign key or cross-table CHECK judging the row as it stands at commit** — the control and chat schemas' CHECKs are per-row and per-statement, and the one declared foreign key (`chat-simple.qsql`) is not deferred. Nothing to change; confirm by running the suites.

## Edge cases and interactions

- **The silent `rawStorageFactory` → `storageFactory` rename.** Nothing fails if it is missed: the `local` transactor quietly keeps its data in memory. Covered by a unit test on the config key, not by the type system.
- **A host that pre-wraps `blocks`.** After ticket 2, cadre-core hands this package a `NodeStorage` whose `blocks` is already a read cache. `withReadCache` below sees `readCached` and passes it through taking no lease, so the cache lives as long as cadre-core's lease and survives a strand runtime rebuild. Nothing here needs to know; verify by inspection that no code in this package reads `blocks` expecting an uncached store.
- **`composeStrand` with no storage.** The `test` transactor path leaves `options.storage` undefined and `createNode` spreads nothing; that stays. Check that no site now reaches `storage.blocks` without a presence check.
- **`shutdown()` called twice.** The latch being deleted with `releaseStorageCache` existed so a double shutdown released one claim and not two. With no claim taken, confirm by inspection that the rest of `shutdown()` is still idempotent and that nothing else rode that latch.
- **Two `register()` calls over one `storage_path`.** `fileNodeStorage` hands back the same three stores, counted, and a `close()` by a holder that is not the last is a no-op for the stores. Inert here because this package closes nothing — stated so a later reader does not add a close.
- **The e2e spec at `test/e2e/networked.e2e.spec.ts:113`** builds a node over a bare block store. It becomes `memoryNodeStorage()` or `fileNodeStorage(dir)` depending on what it proves; read it before choosing.
- **Blob pieces now persist for a node this plugin builds**, because `storageFactory` supplies that node's pieces and blob records. Sereus production injects its own node, so this reaches only a host that lets the plugin build one. It belongs to ticket 5's fold of `backlog/feat-strand-blobs-persist`; do not document it here.

## Tests

Two new, and nothing else:

- **The plugin config carries `storageFactory`** on the `local` transactor. Assert the key name at the narrowest reachable seam. This is the one change in this ticket with no compiler and no runtime error behind it.
- **`cohortOutOfSpaceOf` finds the error through a cause chain, and answers `undefined` for every other error.** Branching logic over a chain, mirroring the existing `appSchemaRefusalOf` spec.

Nothing for the renames in `connect.ts`, `connect-browser.ts`, `plugin.ts` or the types: the compiler is the check.

Re-aim or delete the cache-claim cases in `test/plugin.spec.ts` (around lines 479–546). They assert `wrapStorageWithCache`'s holder counting at a call site this ticket removes, and the invariant they protect now lives in upstream's `withReadCache` and is tested there. Delete them with a line in the handoff rather than keeping tests of a seam that is gone. `test/cached-storage.spec.ts` stays untouched until ticket 2.

## TODO

- Raise every `@optimystic/*` declared range to `^1.30.0` and every `@quereus/quereus` range to `^5.7.1`, workspace-wide; run `yarn check:dep-ranges`.
- Retype `StrandConnectionOptions.storage`, `ResolveStorageContext.requestedStorage`, `StrandPlatform.resolveStorage` and `CreateNodeContext.storage` to `NodeStorage`.
- `compose-strand.ts`: rename the plugin config key to `storageFactory`; delete the wrap, the release latch and `releaseStorageCache`; update the module and option comments that describe the wrap.
- `connect.ts`: pass the `NodeStorage` through to `createLibp2pNode`.
- `connect-browser.ts`: default to `indexedDbNodeStorage(defaultedDb)`; return its `kv` from `defaultOfflineJournal`; add the un-closed-handle `NOTE:`.
- `plugin.ts`: resolve `storage_path` with `fileNodeStorage`. `plugin-browser.ts`: update the refusal wording. `parse-config.ts`: update the comment on what `storagePath` resolves to.
- Add `cohortOutOfSpaceOf`; export it from the package root.
- Fix `test/e2e/networked.e2e.spec.ts`'s node storage; re-aim or delete the cache-claim cases in `test/plugin.spec.ts`.
- Add the two tests named above.
- `packages/quereus-plugin-sereus/README.md`: `storage_path` now opens the blocks, the node-local records and the blob pieces over one directory. `docs/strands/writes.md`: the full-cohort section.
- Run `yarn workspace @serfab/quereus-plugin-sereus typecheck`, `test` and `lint`. Report cadre-core's and integration-tests' remaining errors as this chain's known state, not as new failures.
