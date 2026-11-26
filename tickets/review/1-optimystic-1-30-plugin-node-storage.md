description: The SQL layer now hands the storage library one combined value instead of three separate stores, and apps can tell "the machines holding this data are full" apart from every other failed write.
architecture: docs/strands/writes.md
files: packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/plugin.ts, packages/quereus-plugin-sereus/src/plugin-browser.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/write-errors.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/write-errors.spec.ts, packages/quereus-plugin-sereus/test/e2e/*.e2e.spec.ts, packages/quereus-plugin-sereus/README.md, docs/strands/writes.md, every package.json declaring @optimystic/* or @quereus/quereus
difficulty: medium
----

# The Quereus plugin takes one storage value, and names a full cohort

First of five tickets adopting Optimystic 1.30.0. `@serfab/quereus-plugin-sereus` typechecks, lints and passes its whole suite against 1.30.0 / Quereus 5.7.1. The workspace as a whole does **not** typecheck, by design: see *Known state of the chain*.

## What landed

### One storage value, not three

`StrandConnectionOptions.storage`, `ResolveStorageContext.requestedStorage`, `StrandPlatform.resolveStorage`'s return and `CreateNodeContext.storage` are all `NodeStorage` (`blocks` + `kv` + `pieces`) now. `composeStrand` hands the value through to `createLibp2pNode` and to the plugin config without unpacking it, so nothing in this package reads `.blocks`, `.pieces` or (outside the browser journal) `.kv` — verified by grep over `src/`.

### The plugin config key is `storageFactory`

`registerStrandPlugins` sets `pluginConfig.storageFactory` in place of `rawStorageFactory`, still only on the `local` transactor. Nothing in the type system stands behind this: upstream reads the name out of a `Record<string, unknown>` and silently ignores one it does not know, which leaves the `local` transactor writing to its own memory store. A `NOTE:` at the site says so and names the test that pins it.

### The read-cache wrap is gone from this package

`wrapStorageWithCache` is no longer called here, and the holder-claim latch, `releaseStorageCache` and its three call sites are deleted. Upstream's `withReadCache` now takes the lease twice below us — the node's `resolveStorage` (`libp2p-node-base.ts`) and the Optimystic plugin's `createLocalTransactor`, which was read to confirm it — each sharing one cache per backing store and passing a store already reporting `readCached` straight through.

`src/cached-storage.ts` and its two root exports are **deliberately still here, unused by this package**: cadre-core imports them from the package root (`cadre-node.ts:7`, `strand-instance-manager.ts:5`). Ticket 2 moves cadre-core to `withReadCache` and deletes the module and `test/cached-storage.spec.ts` then. `test/cached-storage.spec.ts` was not touched.

### `storage_path`, the browser default, and the offline journal

`plugin.ts` resolves `storage_path` with `fileNodeStorage(path)`. `connect-browser.ts` defaults to `indexedDbNodeStorage(handle)` and `defaultOfflineJournal()` returns that storage's own `kv` instead of constructing a second `IndexedDBKVStore` over the same handle — upstream declares the journal's key prefix in `NODE_KV_NAMESPACES` so one store serves both, and two stores over one handle would not see each other's unflushed writes.

### `cohortOutOfSpaceOf`

New `src/write-errors.ts`, exported from the package root: finds the `CohortOutOfSpaceError` in an error's `cause` chain, mirroring `appSchemaRefusalOf`. A finder, not a new error class — the upstream error already carries `peerIds`, `approvals`, `peerCount` and `needed`.

### Dependency floors

Every declared `@optimystic/*` range is `^1.30.0` and every `@quereus/quereus` range `^5.7.1`, across all eight workspaces that declare them, in peer, dev and ordinary dependencies alike. `yarn check:dep-ranges` passes. Nothing under `../optimystic` or `../quereus` was read-modified, built, or installed into.

### Docs

`docs/strands/writes.md` gains a `## A write the cohort has no room for` section (the condition, that it throws once and is not retriable, that in offline mode the entry stays `queued` with `waitingFor: 'cohort'` instead of counting as an unclassified failure, and that `cohortOutOfSpaceOf` is how an app tells it apart), a row in the app-facing Errors table, and the accepted tradeoff that the reference apps show the refusal's message unchanged. `packages/quereus-plugin-sereus/README.md`: the first-run script, the `storage` option row, the `storage_path` setting, "What it writes" and `cohortOutOfSpaceOf`.

## Scope the ticket did not enumerate

**Every e2e spec had to move, not just `networked.e2e.spec.ts`.** Retyping `StrandConnectionOptions.storage` reddens every spec that passed a bare `FileRawStorage` or `MemoryRawStorage` as a strand connection's storage — six files, not one. They are now `fileNodeStorage(dir)` / `memoryNodeStorage()`.

That forced a judgement worth reviewing, in `local-transactor.e2e.spec.ts` and `strand-schema.e2e.spec.ts`: **`fileNodeStorage` hands every holder of one directory the SAME three stores and drops them only when the last holder closes.** A warm-restart test that opened a second storage without closing the first would have been handed the first session's own in-memory write groups, and its persistence assertion would pass without anything having reached disk. So every session in those specs now closes the storage it opened (in the session's `finally`, or in `afterEach` through a tracked `OpenNodeStorage`), which is what makes the reopen a real one. `networked.e2e.spec.ts` and `chat-schema.e2e.spec.ts` close in their teardown too, which also releases the directory's write log and lock before the `fs.rm`. **This is the change most worth a sceptical read:** the tests pass, but "passes" and "still proves what it claimed" are different questions here.

## Tests

| Test | What it verifies |
| --- | --- |
| `test/plugin.spec.ts` → `writes through the storage it was handed, which is the only check on the config key name` | A `local`-transactor insert reaches the `NodeStorage` the connection was given. `createLibp2pNode` is mocked in that file and ignores the storage, so the plugin config is the only consumer of it — which makes this the narrowest reachable proof of the `storageFactory` key name. Confirmed non-vacuous: renaming the key back to `rawStorageFactory` in the source fails it (`expected [] to not deeply equal []`), and only it. |
| `test/write-errors.spec.ts` → `finds the refusal however deeply it is wrapped, and nothing in any other failure` | `cohortOutOfSpaceOf` through zero, one and two layers of `cause`; `undefined` for an unrelated error, for an unrelated chain, for a string and for `undefined`. |

**Deleted:** four cache-claim cases in `test/plugin.spec.ts` (the relaunch, the flat-pool cycle, the held-elsewhere claim and the release-on-registration-failure cases). They asserted `wrapStorageWithCache`'s holder counting at a call site this ticket removes; the invariant now lives in upstream's `withReadCache` and is tested there. Their removal also made `composeStrand`, `defaultCachePool`, `IRawStorage`, `wrapStorageWithCache` and `disposeStorageCache` unused imports in that spec, which are gone with them.

Nothing was added for the renames in `connect.ts`, `connect-browser.ts`, `plugin.ts` or the types: the compiler is the check, and `connect.ts` needed no edit at all (it already spread `storage` through).

## How to validate

```
yarn workspace @serfab/quereus-plugin-sereus typecheck     # clean
yarn workspace @serfab/quereus-plugin-sereus build         # dist is current; cadre-core typechecks against it
yarn workspace @serfab/quereus-plugin-sereus test           # 15 files, 165 passed, 1 todo
npx eslint .                                                # clean, whole repo
yarn check:dep-ranges                                       # clean
yarn check:docs                                             # clean
```

Note the `build` step: cadre-core and the reference apps typecheck against this package's `dist`, so a stale `dist` hides the chain's real state. It was rebuilt after the last source edit.

## Known state of the chain

`yarn typecheck` at the repo root **fails**, and should. Each ticket in this chain makes its own package green and reddens what is downstream of it; only ticket 5 can claim a green workspace. Measured per workspace after this ticket:

| Workspace | Errors | Owner |
| --- | --- | --- |
| `@serfab/quereus-plugin-sereus` | 0 | this ticket |
| `@serfab/cadre-core` | 16 | ticket `2-optimystic-1-30-cadre-core-node-storage` |
| `@serfab/integration-tests` | 3 | ticket `4-optimystic-1-30-integration-harness` |
| config-check, cadre-cli, cadre-rn, cadre-host, cadre-provider, all three reference apps | 0 | — |

cadre-core was 13 at this ticket's start and is 16 now: retyping `StrandConnectionOptions.storage` added `src/strand-instance-manager.ts:1041`, `test/strand-membership-writer.spec.ts:103`, `test/strand-spec-helpers.ts:130` and both sites in `test/strand-transactor-handover.spec.ts`, while `src/cadre-node.ts:2616` moved from the old `kvStore`/`pieceStorage` shape to this one. The other eleven are the 1.30 storage-interface changes cadre-core owns (`deleteBlock` on `IRawStorage`, `getApproximateBytesFree`). Integration-tests' three are unchanged from the ticket's measurement. **Neither set is a new failure, and `.pre-existing-error.md` was not written** — these are the chain's planned state, not a surprise.

cadre-core's and integration-tests' **test suites** were not run. They pass this package's `dist`, whose types and behaviour changed, so they are expected red at runtime as well as at compile time until tickets 2 and 4 land.

## Tripwires parked in the code

- `src/connect-browser.ts` `resolveStorage` — the storage and the IndexedDB handle this entry point opens are never closed, because `StrandPlatform` has no shutdown seam; an abrupt tab close can lose writes a store still held in memory. Unchanged from before this ticket, and the `NOTE:` names the remedy (a platform release hook called from `composeStrand`'s `shutdown`).
- `src/plugin.ts` — the `fileNodeStorage` handle `storage_path` opens outlives `plugin.dispose()` and belongs to the host, which is already the rule for that setting. Stated so a later reader does not add a close here.
- `src/compose-strand.ts` — the `storageFactory` key name is load-bearing and unchecked by anything but one test.

## Things to check that are not visible in the diff

- **`shutdown()` is still idempotent with the latch gone.** The latch existed only to stop a second `shutdown()` releasing another scope's cache claim. What remains — `released.abort()`, `offlineControllers.delete(db)`, `releaseOptimysticPlugin` — was already relying on upstream idempotence for a double call: the collection factory's `dispose()` and `shutdown()` each empty their own collections before awaiting anything, and the node's second `stop()` was already documented as a no-op. Nothing else rode the latch.
- **The `test` transactor with no storage.** `options.storage` stays `undefined`, `createNode` spreads nothing, and no site reaches into the value without a presence check.
- **A host that pre-wraps `blocks`** (what cadre-core will hand over after ticket 2) is passed through by `withReadCache` with no lease taken, so the cache stays cadre-core's and survives a strand runtime rebuild. Nothing here needs to know.
- **Quereus 5.7's three changes still reach nothing in this repository**, re-confirmed: no schema under `schemas/` or `packages/` declares a view, materialized view, maintained table or assertion; Sereus never calls the SQL `StampId()` (`generateStampId` in `control-database.ts` is its own unrelated nonce generator); the control and chat schemas' CHECKs are per-row and the one declared foreign key is not deferred. The suites passing is the confirmation.
