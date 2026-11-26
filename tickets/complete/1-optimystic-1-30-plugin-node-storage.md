description: The SQL layer now hands the storage library one combined value instead of three separate stores, and apps can tell "the machines holding this data are full" apart from every other failed write.
architecture: docs/strands/writes.md
files: packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/plugin.ts, packages/quereus-plugin-sereus/src/plugin-browser.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/write-errors.ts, packages/quereus-plugin-sereus/src/cause-chain.ts, packages/quereus-plugin-sereus/src/app-schema-errors.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/write-errors.spec.ts, packages/quereus-plugin-sereus/test/e2e/*.e2e.spec.ts, packages/quereus-plugin-sereus/README.md, docs/strands/writes.md, every package.json declaring @optimystic/* or @quereus/quereus
----

# The Quereus plugin takes one storage value, and names a full cohort

First of five tickets adopting Optimystic 1.30.0. Implemented in `ticket(implement): optimystic-1-30-plugin-node-storage`, reviewed and closed here.

## What landed

**One storage value, not three.** `StrandConnectionOptions.storage`, `ResolveStorageContext.requestedStorage`, `StrandPlatform.resolveStorage`'s return and `CreateNodeContext.storage` are all `NodeStorage` (`blocks` + `kv` + `pieces`). `composeStrand` hands the value through to `createLibp2pNode` and to the plugin config without unpacking it; the only member any file in the package reads is `kv`, in the browser entry's offline journal.

**The plugin config key is `storageFactory`**, in place of `rawStorageFactory`, still only on the `local` transactor. Nothing in the type system stands behind the name: upstream reads it out of a `Record<string, unknown>` and ignores a name it does not know without a word, leaving the `local` transactor writing to a memory store of its own.

**The read-cache wrap is gone from this package.** `wrapStorageWithCache` is no longer called here, and the holder-claim latch, `releaseStorageCache` and its three call sites are deleted. Upstream's `withReadCache` takes the lease twice below us — in the node's `resolveStorage` and in the Optimystic plugin's collection factory — each sharing one cache per backing store and passing a store that already reports `readCached` straight through. `src/cached-storage.ts` stays, unused by this package, because cadre-core still imports it from the package root; ticket `2-optimystic-1-30-cadre-core-node-storage` moves cadre-core to `withReadCache` and deletes it.

**`storage_path`, the browser default, and the offline journal.** `plugin.ts` resolves `storage_path` with `fileNodeStorage(path)`. `connect-browser.ts` defaults to `indexedDbNodeStorage(handle)`, and `defaultOfflineJournal()` returns that storage's own `kv` rather than a second store over the same handle — upstream declares the journal's key prefix in `NODE_KV_NAMESPACES` so one store serves both, and two stores over one handle would not see each other's unflushed writes.

**`cohortOutOfSpaceOf`**, in `src/write-errors.ts` and exported from the package root: finds the `CohortOutOfSpaceError` in an error's `cause` chain, mirroring `appSchemaRefusalOf`. A finder, not a new error class — the upstream error already carries `peerIds`, `approvals`, `peerCount` and `needed`.

**Dependency floors.** Every declared `@optimystic/*` range is `^1.30.0` and every `@quereus/quereus` range `^5.7.1`, across all eight workspaces that declare them.

**Docs.** `docs/strands/writes.md` gains a section on a write the cohort has no room for (the condition, that it throws once and is not retriable, that in offline mode the entry stays `queued` with `waitingFor: 'cohort'`, and that `cohortOutOfSpaceOf` is how an app tells it apart), a row in the app-facing Errors table, and the accepted tradeoff that the reference apps show the refusal's message unchanged. `README.md`: the first-run script, the `storage` option row, the `storage_path` setting, "What it writes" and `cohortOutOfSpaceOf`.

**Every e2e spec moved, not just the networked one.** Retyping `StrandConnectionOptions.storage` reddened six files that passed a bare `FileRawStorage` or `MemoryRawStorage`; they are now `fileNodeStorage(dir)` / `memoryNodeStorage()`, and every session closes the storage it opened.

## Review findings

### Fixed in this pass

- **The new unit test's premise was false, and it was redundant.** `test/plugin.spec.ts` → "writes through the storage it was handed, which is the only check on the config key name" claimed to be the only guard on `storageFactory`. Renaming the key back to `rawStorageFactory` and running `vitest run --project unit test/plugin.spec.ts` fails **two** cases: that one and the pre-existing "keeps its rows apart from the strand table, and across a warm restart" — which guards it better, by proving a second session reads what the first wrote rather than that a `save*` method was called on a spy. The two reopen cases in `local-transactor.e2e.spec.ts` guard it the same way over real file storage. The new case is deleted; the `NOTE:` at the config key now names the warm-restart cases, and that test's own comment says it carries the key-name claim so a later reader does not cut it as "just hydrate".
- **The cause walk was duplicated verbatim.** `cohortOutOfSpaceOf` was a copy of `appSchemaRefusalOf`'s loop. Extracted as `causeOf` in the new `src/cause-chain.ts` (internal — the finders stay the published surface, since each names the one type an app should ask about); both are now one call, so a rule added to the walk applies to every finder.
- **An app could not name what the finder returns.** `src/index.ts` re-exports the `CohortOutOfSpaceError` type, which is what the package already does for the offline queue's error types, so an app that depends on this package and not on `@optimystic/db-core` can annotate the result.
- **`docs/strands/writes.md` asserted a setting no operator can reach.** The section opened "Every machine that stores a strand's data is given an allotment: how many bytes of that machine its operator lent the network." No Sereus program passes Optimystic's `storageAllotment`, and Sereus's own `storage.quotaBytes` is recorded in `docs/cadre/node.md` → "Limits and accepted tradeoffs" as accepted and unread — so a reader would set a number that does nothing. Now stated as the machine having filled the storage it was given, with where that limit comes from linked to the doc that owns it; true both now and once ticket 2 makes an allotment settable.
- **Two files still described a caller this ticket removed.** `src/cached-storage.ts` and `test/cached-storage.spec.ts` both say `composeStrand` wraps again over whatever it is handed, in six places between them, and the module header gives that as the reason the module lives in this package and the reason it keeps a holder count instead of adopting `withReadCache`. One `NOTE:` at the top of each now says every `composeStrand` mention describes cadre-core's two remaining seams, and names the ticket that deletes both — rather than rewriting prose in a module that is about to go.

### Parked as a tripwire

- `src/compose-strand.ts`, at `pluginConfig.storageFactory`: it is passed on the `local` transactor only, so a `network` connection over a **client** node — one that holds no blocks and so carries no blob service of its own — leaves the Optimystic plugin to build its blob service over memory piece and key-value stores even though the connection was handed real ones. Unreachable today: no schema in the repository declares a `blobref` column, so no blob service is ever built. `NOTE:` at the site; arm appended to `backlog/feat-strand-blobs-persist`.

### Arms appended to existing tickets, no new ticket filed

- `implement/2-optimystic-1-30-cadre-core-node-storage` (already owns `cadre-core/src/index.ts`): re-export `cohortOutOfSpaceOf` and the `CohortOutOfSpaceError` type from cadre-core, beside `appSchemaRefusalOf`. `docs/strands/writes.md` tells an app to use the finder, but apps reach Sereus through cadre-core — `reference-app-rn` declares neither the plugin nor `@optimystic/db-core`, so today it cannot name the error a failed write carries.
- `backlog/feat-strand-blobs-persist`: its "What Sereus does today" still described 1.29's separate `pieceStorage` and `kvStore` node options, which 1.30 folded into one value; that, and the tripwire above.

### Checked, nothing found

- **The e2e storage-close judgement, which the handoff flagged as most worth a sceptical read.** Confirmed correct against upstream's `fileNodeStorage`: every holder of one directory is handed the *same* three stores, sharing their in-memory write groups, and the stores are dropped only when the last holder closes. So a warm-restart session that left its storage open would have been handed the previous session's own write groups and its persistence assertion would have passed with nothing on disk; each session closing is what makes the reopen construct fresh stores. The specs that remove their directory also release the shared write log and lock before the removal.
- **Every claim the handoff made about upstream**, read in `../optimystic` rather than taken on trust: `storageFactory` is the name the plugin reads; `withReadCache` is leased by `libp2p-node-base`'s `resolveStorage` and by the collection factory, whose `dispose()` and `shutdown()` both release and are both safe to call twice, so `shutdown()` stays idempotent with the latch gone; `CohortOutOfSpaceError` carries the four documented fields; the queue's `cohort-out-of-space` arm sets `waitingFor: 'cohort'` with the refusal as `lastError` on the same timer as `backoff`; all five platform factory names in `types.ts` and the README exist and take the arguments given.
- **Resource cleanup after the latch's removal.** Nothing in `composeStrand` takes a lease any more, so a plugin registration that throws has nothing to release — which is what let the inner `try` go. The two storage handles this package opens and never closes (`plugin.ts`'s `storage_path`, the browser entry's IndexedDB default) each carry a `NOTE:` saying who owns them and what it costs.
- **The `test` transactor** leaves `options.storage` undefined and no site reaches into the value without a presence check; `requestedStorage` is honoured ahead of the browser's IndexedDB default.
- **The browser journal falls back to memory when a caller supplies its own storage** (`defaulted` stays unset). Unchanged behaviour and deliberate: journaling into a borrowed store would contradict the Node rule `writes.md` states, and the seam is not handed the resolved storage.
- **`docs/strands/writes.md` → "Where queued transactions are saved"** still describes the browser journal correctly: it is the same `IndexedDBKVStore` over the strand's database, now the node's own instance rather than a second one, which the doc never claimed.
- **The dependency sweep:** `^1.30.0` and `^5.7.1` are the only values any workspace declares for those packages, and no `rawStorageFactory` reference survives outside ticket prose.

## Validation

```
yarn workspace @serfab/quereus-plugin-sereus typecheck     # clean
yarn workspace @serfab/quereus-plugin-sereus build         # dist rebuilt after the last source edit
yarn workspace @serfab/quereus-plugin-sereus test          # 15 files, 164 passed, 1 todo
npx eslint .                                               # clean, whole repo
yarn check:docs                                            # clean
yarn check:dep-ranges                                      # clean
```

No pre-existing failure surfaced, and `tickets/.pre-existing-error.md` was not written.

## Known state of the chain

`yarn typecheck` at the repo root still fails, by design: each ticket in this chain makes its own package green and reddens what is downstream, and only ticket 5 can claim a green workspace. Measured after the review, unchanged from the handoff's figures:

| Workspace | Errors | Owner |
| --- | --- | --- |
| `@serfab/quereus-plugin-sereus` | 0 | this ticket |
| `@serfab/cadre-core` | 16 | ticket `2-optimystic-1-30-cadre-core-node-storage` |
| `@serfab/integration-tests` | 3 | ticket `4-optimystic-1-30-integration-harness` |
| config-check, cadre-cli, cadre-rn, cadre-host, cadre-provider, all three reference apps | 0 | — |

cadre-core's and integration-tests' test suites were not run: they compile and run against this package's `dist`, whose types and behaviour changed, so they are expected red until tickets 2 and 4 land.

Nothing under `../optimystic` or `../quereus` was edited, built, or installed into.
