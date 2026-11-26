description: Each program that runs or embeds a cadre node opens its own storage, and the way a node asks for storage has just changed. Update the command-line node, the self-hosted manager, the multi-tenant host, the phone kit and the three reference apps, and turn the operator's disk limit into the amount of disk the node actually measures itself against.
prereq: 2-optimystic-1-30-cadre-core-node-storage
architecture: docs/cadre/node.md#storage
files: packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/env.ts, packages/cadre-cli/test/start-owner.spec.ts, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/config/schema.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-rn/src/phone-node/leveldb-storage.ts, packages/cadre-rn/src/phone-node/node.ts, packages/reference-app-web/src/lib/strand-storage.ts, packages/reference-app-web/src/lib/web-edge-platform.ts, packages/reference-app-ns/src/ns-edge-platform.ts, docs/platforms/react-native.md, docs/platforms/nativescript.md, docs/platforms/browser.md, docs/hosting/cadre-host.md, docs/hosting/provider.md
difficulty: hard
----

# Every host and app opens one node storage per scope

Third of five tickets adopting Optimystic 1.30.0. Read tickets 1 and 2 first: ticket 2 changes `CadreNodeConfig.storage` to `{ open(scope): Promise<NodeStorage>; allotmentBytes?: number }` and `EdgeNodeStorage.rawStorage` to `nodeStorage(scope): Promise<NodeStorage>`, deletes `lazyRawStorage`, and settles the allotment decision. This ticket is every program on the other side of those two seams. It is the last ticket that reddens anything; after it and ticket 4, `yarn typecheck` is green.

Each program keeps its `OpenNodeStorage` and closes it itself: cadre-core closes nothing it was handed. The platform factories are `fileNodeStorage(basePath)`, `levelDbNodeStorage(handle)`, `sqliteNodeStorage(handle)` and `indexedDbNodeStorage(handle)`, each opening blocks, the node-local key-value records and the blob pieces over one location and asserting before it returns that all three sit inside what the block store measures.

## cadre-cli

`openNodeStorage` in `node-session.ts` becomes one `fileNodeStorage(`${path}/${scope}`)` or `memoryNodeStorage()` per scope, memoized per scope as today, with the handle's `close()` closing each. Two renames go with it:

- The local interface is called `NodeStorage`, which is now also upstream's type name. Rename the local one — `NodeStorageHandle` — so a reader of this file is never guessing which is meant.
- `storage.quotaBytes` becomes `storage.allotmentBytes` in `config/schema.ts` and `config/types.ts`, and `CADRE_STORAGE_QUOTA` becomes `CADRE_STORAGE_ALLOTMENT` in `config/env.ts`. The project keeps no backward compatibility, so rename outright rather than accepting both. The value is passed into `StorageConfig.allotmentBytes` and is, for the first time, read.

`fileNodeStorage` hands back one set of stores per directory per process, counted by holder, so the per-scope memo in this file is now belt and braces rather than the only thing preventing two sets over one directory. Keep it (it is what `close()` iterates) and say so at the site rather than leaving the overlap unexplained.

The memory branch calls `memoryNodeStorage()`, which is how a host says it meant memory: upstream warns on an **absent** `storage` option, not on stores that happen to be in memory. The memory branch sets no allotment — nothing measures a memory store's free space, so a memory node measures nothing, which is what a throwaway node should do.

`packages/cadre-cli/README.md`: the `storage` block's key list and the environment-variable table, plus one line on what the allotment bounds (one network's share of the machine, not the machine — the node doc carries the full statement; link, do not restate).

## cadre-host

`host-process-orchestrator.ts` writes a child's `cadre.json`. `req.resources?.storageQuotaBytes` keeps its name in the management API (it is a public request field, and renaming it is an API change this ticket is not for) and now maps to `storage.allotmentBytes` in the generated config. `docs/hosting/cadre-host.md` gains one sentence: the resource limit an operator sets for a hosted node is now the allotment that node measures itself against, and a hosted node running several strands can hold more than it in total.

## cadre-provider

`container-env.ts` emits `CADRE_STORAGE_QUOTA` from `resources.storageQuotaBytes`; that becomes `CADRE_STORAGE_ALLOTMENT`, matching the CLI rename. `resources.storageQuotaBytes` itself keeps its name in the create request and the config (same reason as cadre-host), as does the 10 GB default in `config/types.ts`.

`docs/hosting/provider.md` gains the honest statement for a tenant quota: the number reaches the container's node as its allotment, each network the container serves measures against it separately, so a container running several strands can hold more than the quota in total. A provider that must enforce the quota hard sizes the Docker volume, because the file backend reports the volume's free space and the node measures against the smaller of the two. That is the answer to "for cadre-provider the allotment is a per-tenant quota" — the volume is the enforcement, the allotment is the declaration.

## cadre-rn

`LevelDBEdgeStorage` (`phone-node/leveldb-storage.ts`) becomes one `levelDbNodeStorage(handle)` per scope:

- `rawStorage(scope)` becomes `async nodeStorage(scope)`, memoized per scope. **One call per handle is a hard rule here**: the block store claims the handle in the cache pool, and a second `levelDbNodeStorage` over an open handle throws (`two caches over one backing store never converge`). The existing per-scope memo on `blockStores` is what satisfies it; keep the memo and state the rule in its comment.
- `offlineJournal(scope)` returns that storage's `kv` instead of constructing a second `LevelDBKVStore` over the same handle. It must: `levelDbNodeStorage`'s `kv` keeps the default `'optimystic:txn:'` prefix, which is the prefix the journal store used too, and two stores over one handle do not see each other's unflushed writes. Upstream lists the journal's prefix in `NODE_KV_NAMESPACES` precisely so one store serves both. The `journals` map goes.
- `close()` and `destroyScope(scope)` close the `OpenNodeStorage` (which commits the key-value store and then the block store, releasing the cache-pool claim) before closing the handle. `destroyScope` must still close before `destroyDB`, which throws on an open database.
- `allotmentBytes` is declared, because LevelDB reports no free space: a node with neither an allotment nor a measuring backend cannot tell how full it is and acts on nothing. `PhoneNodePlatform` gains `storageAllotmentBytes?: number`, defaulting to cadre-core's `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`, threaded into `LevelDBEdgeStorage`.

`docs/platforms/react-native.md`: the storage section (one database per scope now holding blocks, node-local records and blob pieces; the journal is the same store), and the allotment with its default and how an app changes it.

## reference-app-web

`strand-storage.ts` opens handles and stores per scope. `openStore` becomes a call to `indexedDbNodeStorage(handle)`, memoized per scope; `openJournal` returns that storage's `kv`; `closeStores` closes each `OpenNodeStorage` before its handle; `deleteStore` the same before deleting the database. `getStoreHandle`, which diagnostics read, keeps working off the handle map.

`web-edge-platform.ts`'s `webEdgeStorage` loses the `lazyRawStorage` proxy and the `durability` constant that existed only to answer synchronously before an open — `indexedDbNodeStorage` is called after the handle is open, so the store reports its own durability. `supportsStrictDurability()` may still be needed for `IndexedDBNodeStorageOptions`' strict-durability flag; read that option before deleting the helper.

No `allotmentBytes`: IndexedDB reports the origin's storage estimate, so the node measures against it. Say that in `docs/platforms/browser.md`, so the absence reads as a decision.

## reference-app-ns

`ns-edge-platform.ts`'s `nsEdgeStorage` becomes `sqliteNodeStorage(db)` per scope over the existing `SharedOpen<ScopeDb>`: `ScopeDb` holds the handle and the `OpenNodeStorage`, `nodeStorage(key)` awaits the shared open and returns it, `closeScopeDb` closes the node storage (which flushes the pieces and the key-value store and closes the block store) and then the handle. The `lazyRawStorage` proxy and its durability note go.

This platform also gains `offlineJournal(scope)`, returning that storage's `kv` — which is exactly what `tickets/backlog/feat-strand-offline-mode-nativescript.md` asks for, and it arrives here for free rather than as separate work. Its two "check before building" questions are answered by the change: the store is upstream's own `SqliteKVStore` over the scope's database, which `sqliteNodeStorage` flushes on close, and the block store's listing already skips the journal's keys because upstream declares its prefix in `NODE_KV_NAMESPACES`. Implement the journal here; the reference chat's offline toggle and queue line are NOT in this ticket — ticket 5 rewrites that backlog ticket down to the remaining app-side work.

`allotmentBytes` is declared, as on React Native and for the same reason (SQLite reports no free space), from the same `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`. `docs/platforms/nativescript.md`: the storage section, the journal, and the allotment.

## reference-app-rn

It passes `leveldb` and names into `createPhoneNode`; it changes only if it sets a storage allotment. Check it compiles and leave it otherwise alone.

## Edge cases and interactions

- **The `NodeStorage` name collision in cadre-cli.** Two different types with one name in one file is the kind of thing a later reader gets wrong. Rename the local one.
- **A `levelDbNodeStorage` call over an already-open handle throws.** The per-scope memo is the whole defence. A `destroyScope` followed by a relaunch of the same scope must close the node storage **and** the handle before reopening, or the reopen throws; follow the existing `destroyScope` ordering.
- **Close ordering, three deep.** Node storage first (it commits what its stores hold and releases the cache-pool claim), then the platform's handle, then anything the app owns. Every platform's `close()` must keep logging a failure and closing the rest — `EdgeNodeStorage.close()` does not reject.
- **`destroyScope` while a node still runs.** Unchanged contract (no handle may be open), but there is now a node storage between the handle and the caller. Check each platform's `destroyScope` closes it.
- **The browser's defaulted handle.** `openOptimysticWebDb` is called by the platform here and by `connect-browser.ts` for a host that uses the plugin directly; they are separate databases (`sereus-strand-<scope>` from both, so the **same** name). Two `indexedDbNodeStorage` calls over two handles to one database are tolerated by upstream ("two calls over one handle are harmless"), but two handles are two read caches by object identity. Nothing in the reference app reaches both paths; check that by inspection and note it if it is close.
- **A hosted node or container with several strands.** Each strand node measures against the whole allotment, so the total can exceed it. Documented in both hosting docs, and in the node doc by ticket 2; do not restate the reasoning, link it.
- **An allotment of 0 or a fraction.** Upstream throws at node construction. The CLI schema's `nonNegativeInteger` admits 0, which upstream refuses — tighten the schema to a positive integer so the operator is told by `config-check` at load rather than by a node that will not start.
- **`start-owner.spec.ts`** builds a memory provider by hand; it becomes `memoryNodeStorage()` memoized per scope.
- **Reference apps and a full cohort.** They show a failed write's message, which now names the full machines. Nothing to build (ticket 1 records that decision in `docs/strands/writes.md`); confirm each app's write-error path does surface the message rather than a fixed string, and say in the handoff if one does not.

## Tests

No new tests. Every change here is wiring a compiler checks, plus two schema renames that `@serfab/config-check` already refuses unknown keys for. The one judgement call — tightening the CLI allotment to a positive integer — is a one-line schema change whose refusal the existing config-schema spec covers by shape; extend that spec's existing table if it enumerates per-key acceptance, and add nothing if it does not.

The NativeScript offline journal is new behaviour, but `feat-strand-offline-mode-nativescript`'s own check ("does `SqliteKVStore` implement `flush`") is answered by using upstream's store through upstream's factory, and the offline queue's behaviour over an `IKVStore` is tested upstream and in the browser and React Native paths already. Do not add a third copy.

## TODO

- cadre-cli: `node-session.ts` over `fileNodeStorage` / `memoryNodeStorage`, with the local interface renamed; `storage.allotmentBytes` through `config/{schema,types,env}.ts` with `CADRE_STORAGE_ALLOTMENT`, tightened to a positive integer, read into `StorageConfig.allotmentBytes`; `test/start-owner.spec.ts`; README.
- cadre-host: map `req.resources.storageQuotaBytes` onto `storage.allotmentBytes`; `docs/hosting/cadre-host.md`.
- cadre-provider: `container-env.ts` emits `CADRE_STORAGE_ALLOTMENT`; `docs/hosting/provider.md` with the volume-is-the-enforcement statement.
- cadre-rn: `LevelDBEdgeStorage` over `levelDbNodeStorage` with `nodeStorage`, the journal from `kv`, close and destroy ordering, the one-call-per-handle rule in a comment; `storageAllotmentBytes` on `PhoneNodePlatform`; `docs/platforms/react-native.md`; package README if it describes the databases.
- reference-app-web: `strand-storage.ts` over `indexedDbNodeStorage`, journal from `kv`, close and delete ordering; `web-edge-platform.ts` without the lazy proxy; `docs/platforms/browser.md` including why no allotment is declared.
- reference-app-ns: `ns-edge-platform.ts` over `sqliteNodeStorage`, with `offlineJournal` and `allotmentBytes`; `docs/platforms/nativescript.md`.
- reference-app-rn: compile check only.
- `docs/cadre/node.md` → "Where each record is kept": the block-store row now names what each platform's one call opens.
- Run `yarn typecheck`, `yarn build`, `yarn lint` and each package's `test`. `@serfab/integration-tests` stays red until ticket 4; say so.
