description: Every program that runs or embeds a cadre node now opens one combined storage value per data set, and the disk limit an operator sets is finally the number each node measures itself against. Review the five programs and three apps that were changed, and the documents that describe them.
prereq: 2-optimystic-1-30-cadre-core-node-storage
architecture: docs/cadre/node.md#storage
files: packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/env.ts, packages/cadre-cli/test/start-owner.spec.ts, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/env.example, packages/cadre-cli/docker/docker-compose.yml, packages/config-check/src/checkers.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-provider/src/service/container-env.ts, packages/cadre-rn/src/phone-node/leveldb-storage.ts, packages/cadre-rn/src/phone-node/node.ts, packages/reference-app-web/src/lib/strand-storage.ts, packages/reference-app-web/src/lib/web-edge-platform.ts, packages/reference-app-ns/src/ns-edge-platform.ts, packages/reference-app-rn/test/solo-founding.spec.ts, docs/platforms/react-native.md, docs/platforms/nativescript.md, docs/platforms/browser.md, docs/hosting/cadre-host.md, docs/hosting/provider.md, docs/strands/writes.md
difficulty: hard
----

# Review: every host and app opens one node storage per scope

Third of five tickets adopting Optimystic 1.30.0. Implemented in `ticket(implement): optimystic-1-30-hosts-and-apps`. Tickets 1 and 2 are in `complete/`; ticket 4 (`@serfab/integration-tests`) and ticket 5 (release notes and the board fold) are still in `implement/`.

This was the last ticket that reddened production source. After it, every workspace but `@serfab/integration-tests` typechecks, builds, lints and tests green.

## What landed, by program

**cadre-cli.** `openNodeStorage` in `node-session.ts` now builds `StorageConfig.open` over one `fileNodeStorage(`${path}/${scope}`)` or `memoryNodeStorage()` per scope, memoized per scope, with the handle's `close()` closing each. The local interface is renamed `NodeStorageHandle`, so `NodeStorage` in that file means only Optimystic's type (`start-node.ts` and `test/one-shot-node.spec.ts` follow the rename). Both branches share one `storagePerScope` helper.

`storage.quotaBytes` is now `storage.allotmentBytes` in `config/{schema,types}.ts` and `CADRE_STORAGE_QUOTA` is `CADRE_STORAGE_ALLOTMENT` in `config/env.ts`, and the value is read for the first time — into `StorageConfig.allotmentBytes` on the file branch. The schema takes a **positive** integer (`positiveInteger`, new in `@serfab/config-check` beside `nonNegativeInteger`), because Optimystic throws on an allotment of zero when the node is constructed and the operator should be told by the config load instead. The four launcher files that carried the old spellings moved with it: `docker/docker-compose.yml`, `docker/entrypoint.sh`, `docker/env.example`, `example.cadre.yaml`. `README.md` gained the allotment paragraph under the config table.

**cadre-host.** `buildChildConfig` maps `req.resources?.storageQuotaBytes` onto `storage.allotmentBytes` in the generated `cadre.json`. The management API field keeps its name. `docs/hosting/cadre-host.md` → "Child configuration" states what the figure bounds.

**cadre-provider.** `container-env.ts` emits `CADRE_STORAGE_ALLOTMENT`; `resources.storageQuotaBytes` and the 10 GB default keep their names. `docs/hosting/provider.md` gained "The tenant's storage quota", carrying the volume-is-the-enforcement statement. `container-env.test.ts`'s three assertions moved to the new variable name.

**cadre-rn.** `LevelDBEdgeStorage` opens one `levelDbNodeStorage(handle)` per scope: `nodeStorage(scope)` replaces `rawStorage(scope)`, `offlineJournal(scope)` returns that storage's own `kv` (the `journals` map is gone), and `close()` / `destroyScope()` close the `OpenNodeStorage` before the handle. The per-scope memo now carries the one-call-per-handle rule in its comment, because that rule is what the memo exists to satisfy. `PhoneNodePlatform` gained `storageAllotmentBytes`, defaulting to cadre-core's `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`.

**reference-app-web.** `strand-storage.ts`'s `openStore` became `openNodeStorage(key)` over `indexedDbNodeStorage(handle)`, memoized per key; `openJournal` returns that storage's `kv`; `closeStores` and `deleteStore` close the `OpenNodeStorage` before the handle. `getStoreStorage`, which diagnostics reads for the backend label and the byte count, returns that storage's `blocks` and still reports `IndexedDBRawStorage`. `web-edge-platform.ts` lost the `lazyRawStorage` proxy, the `durability` constant and the `supportsStrictDurability` import — the store is built after the handle is open, so it reports its own durability, and upstream's own comment says a host has no reason to set `strictDurability`.

**reference-app-ns.** `ScopeDb` now holds the handle and an `OpenNodeStorage` from `sqliteNodeStorage(db)`; `nodeStorage(key)` awaits the shared open, `closeScopeDb` closes the node storage before the handle. The platform gained `offlineJournal(scope)` — so **NativeScript now has an offline journal**, which is what `tickets/backlog/feat-strand-offline-mode-nativescript` asked for on the platform side — and `allotmentBytes: DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`.

**Docs.** The three platform documents' storage sections, the two hosting documents, `docs/cadre/node.md`'s record table (the block-store row now names each platform's one opener), and two documents that asserted something this change makes false: `docs/strands/writes.md` ("Offline mode is unavailable on NativeScript", and the per-platform journal list, which is now one rule rather than three stores) and `docs/platforms/reference-apps.md`.

## Validation

Green, with every command run in the foreground from the repo root:

| Command | Result |
|---|---|
| `yarn lint` (ESLint + `check:docs`) | clean, 67 Markdown files |
| `yarn typecheck` per workspace | 0 errors in all ten; `@serfab/integration-tests` still red (ticket 4) |
| `yarn build` | every workspace but `@serfab/integration-tests` |
| `@serfab/cadre-core` test | 199 files, 2,709 passed, 1 skipped |
| `@serfab/cadre-cli` test | 24 files passed, 1 skipped; 295 passed, 4 skipped |
| `@serfab/cadre-host` test | 54 files, 444 passed, 6 skipped |
| `@serfab/cadre-provider` test | 32 files, 234 passed |
| `@serfab/cadre-rn` test | 16 files, 176 passed |
| `@serfab/quereus-plugin-sereus` test | 14 files, 148 passed, 1 todo |
| `@serfab/reference-app-web` test | 4 files, 11 passed |
| `@serfab/reference-app-ns` test | 7 files, 72 passed |
| `@serfab/reference-app-ns` test:bundle | OK, 0 errors, 0 warnings |
| `@serfab/reference-app-rn` test | 20 files, 180 passed |
| `@serfab/reference-app-rn` test:bundle | **FAILS, pre-existing** — see below |

The skips are the platform and environment guards that predate this chain; nothing was skipped, disabled or loosened here.

**The CLI schema's four new behaviours were exercised by hand** against the built `dist`, not only read: `storage.quotaBytes` in a file is refused naming `allotmentBytes`; `allotmentBytes: 0` is refused as "must be a whole number above zero"; a `file` store takes the key from the file and from `CADRE_STORAGE_ALLOTMENT`; `CADRE_STORAGE_QUOTA` is refused naming its replacement, attributed to the variable rather than the file.

## Deviations from the ticket, both deliberate — please weigh them

**1. The rename ships with two retired-name entries, which the ticket did not ask for.** The ticket says "The project keeps no backward compatibility, so rename outright rather than accepting both." Neither entry accepts the old name: `RETIRED_STORAGE_KEYS` in `schema.ts` and a `RETIRED_ENV` entry in `env.ts` **refuse** it, with the message naming the replacement, exactly as `RETIRED_IDENTITY_KEYS` and `CADRE_IDENTITY_PROTOBUF` already do in the same two files. Without them an operator's existing `quotaBytes` gets a bare "unknown key" and `CADRE_STORAGE_QUOTA` gets "Unknown environment variable" with no near match (the edit distance to `CADRE_STORAGE_ALLOTMENT` is too large for the suggestion). Both carry the same `NOTE: transitional` wording the existing entries do, so they are deletable on the same terms. Cut them if you read the ticket's sentence as covering a refusal too.

**2. A `memory` store may not name an allotment; the key is refused rather than dropped.** The ticket settles that the memory branch sets no allotment, which it does. But the schema would then have accepted `allotmentBytes` beside `type: memory` and `openNodeStorage` would have silently ignored it — which is the one thing this validator exists to prevent (its module header: a key that is never read "would otherwise be ignored without a word"). The storage block's `refine` grew a second cross-field rule, lifted into a named `storageCrossFields` function beside the existing file-needs-a-path rule. If you would rather pass the figure through to a memory node instead, note that it *would* work — `effectiveTotalBytes(allotment, undefined)` is the allotment, so a memory node would measure used bytes against it — so this is a real choice, not a forced one. I kept the ticket's decision and made it loud.

## Two things the ticket called "check only" that turned out to need work

**`reference-app-rn` did not compile.** `test/solo-founding.spec.ts` carried two of ticket 2's reds: it passes `storageProvider` into `buildPhoneNodeConfig`, which ticket 2 renamed to `openStorage` and changed to return a `NodeStorage`. Converted to a per-scope memoized `levelDbNodeStorage` over the fake native module, with the memo's reason stated (the one-call-per-handle rule). The spec also now passes `allotmentBytes: DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`, because the spec's whole premise is that it builds the node `cadre-phone.ts` builds and `createPhoneNode` declares that figure. **Worth a second opinion:** is passing the allotment there right, or does the spec want the bare config and no allotment? Either compiles.

**`@serfab/config-check` needed a checker.** `positiveInteger` is new, four lines, beside `nonNegativeInteger` and matching `positiveNumber`/`nonNegativeNumber`.

## Edge cases the ticket named, and what was found

- **The `NodeStorage` name collision in cadre-cli** — resolved by renaming the local interface to `NodeStorageHandle`, with the reason at the site.
- **`levelDbNodeStorage` over an already-open handle throws** — the per-scope memo is the defence and now says so. `destroyScope` closes the node storage (releasing the cache-pool claim) and then the handle, and drops both map entries, so a relaunch of that scope opens a fresh handle and calls the factory again.
- **Close ordering, three deep** — node storage, then platform handle, in all three platforms. cadre-rn's `close()` still logs a failure and closes the rest; reference-app-ns's `closeScopeDb` still runs each step through `logFailure`; reference-app-web's `closeStores` still uses `closeLogged`. None rejects.
- **The browser's defaulted handle** — checked by inspection and it is not close: `packages/reference-app-web` does not depend on `@serfab/quereus-plugin-sereus` at all (no import anywhere in `src/`, and not in its manifest), so `connect-browser.ts`'s `openOptimysticWebDb('sereus-strand-<id>')` is unreachable from the app. The two paths could only meet in a host that embeds both; they would then be two handles to one database, which upstream tolerates for IndexedDB but which gives two read caches by object identity.
- **An allotment of 0 or a fraction** — refused by the schema, verified by hand (above).
- **`start-owner.spec.ts`** — now builds `memoryNodeStorage()` memoized per scope, so each test's "restart" still meets the party the first node left.
- **Reference apps and a full cohort** — all three surface the thrown message: `use-chat.ts`/`app/index.tsx` on React Native, `chat-vm.ts` on NativeScript, `messages.svelte.ts` on the browser, each through `describeThrown(err)`. **One observation to weigh rather than a defect:** React Native and NativeScript wrap it as "Not confirmed sent (<message>). Press Send again — it can only be stored once." A cohort-out-of-space refusal definitively wrote nothing, so "not confirmed" is weaker than the truth there, though the message itself reaches the user and pressing Send again is safe. `docs/strands/writes.md` already records "the reference apps show the refusal's message and nothing more" as an accepted tradeoff, so this was not changed.

## Tests: none added

Every change here is wiring that a compiler checks, plus two renames `@serfab/config-check` already refuses unknown keys for. The one judgement call — the allotment as a positive integer — is a one-line schema change, and `config-validation.spec.ts` says in its own header that "per-field type checks are not tested: the field tables are compile-checked against the config type and the checkers are one-liners", so there was no per-key table to extend. The retired-key mechanism already has a case (`identity-key.spec.ts` → "rejects the retired identity.protobufKeyFile, naming keyFile"); a second copy for the storage block would pin the same branch. The four new schema behaviours were exercised by hand instead, which is recorded above.

The NativeScript offline journal is new behaviour, and deliberately carries no new test: it is upstream's own `SqliteKVStore` reached through upstream's own factory, `sqliteNodeStorage` flushes it on close, and the offline queue's behaviour over an `IKVStore` is already tested upstream and on the browser and React Native paths.

## Behaviour changes a reviewer should look at on purpose

- **The CLI's memory branch is now memoized per scope**, where it previously returned a fresh `MemoryRawStorage` on every call. A `stop()`/`start()` cycle, or a `stopStrand` and relaunch, in one process now reads back what that scope wrote. The ticket asked for the memo ("memoized per scope as today") and `close()` needs the map to iterate; the file branch was already memoized. This is a change in what a memory node remembers, so it is worth agreeing with rather than skimming.
- **NativeScript strands now get an offline queue object**, in `'online'` mode by default, because the edge node configures `strandOffline` whenever the platform has an `offlineJournal`. Two consequences beyond the journal itself: `CadreNode` now tracks the party's own machines for that app (so a commit's `awaitedMachines` is populated where it used to be absent) and registers `cohortReachability`. Writes stay network-acknowledged until something calls `setStrandOfflineMode`, and the reference chat has no control that does.
- **A hosted node's and a tenant's storage limit now does something.** Both were accepted and ignored before. An operator who set a small figure for bookkeeping will now get a node that refuses writes above 0.95 of it.

## Tripwires recorded, not filed

- **The CLI keeps a scope's stores after `stopStrand`.** `NOTE:` at the memo in `storagePerScope`. On a file store the retained holder is the point (the process owns the directory and its lock); on a memory store it means a process that launches and stops many strands keeps every one's blocks until exit. Harmless while memory storage is for tests and throwaway nodes; the note names what to do if a long-lived memory node ever churns strands.

## Known gaps and loose ends

- **`tickets/.pre-existing-error.md` was written.** `yarn workspace @serfab/reference-app-rn test:bundle` (the Metro release bundle, not the package's `test`) fails with `Unable to resolve module p2p-fret`. The file carries the evidence that it is pre-existing: the module is imported by `@optimystic/db-p2p`'s index, which `@optimystic/db-p2p-storage-rn`'s own modules and `cadre-core`'s `cadre-node.ts` already imported before this change, and the cause is a path spelling — the junction stores `C:\Projects\Fret\...` while `metro.config.js` builds its `linkedRoots` as `C:\Projects\fret` — the same class as `complete/linked-sibling-loaded-under-two-path-spellings`, here in Metro's watch-folder matching. Not fixed here: the remedy is in Metro config or in a read-only sibling's junction, neither of which is this ticket's subsystem.
- **`@serfab/integration-tests` is still red** — 7 typecheck errors on `RawStorageProvider`, `storage.provider`, `IRawStorage.deleteBlock` and a node's `storage` option. Ticket 4 owns every one.
- **`tickets/backlog/later/3-mobile-resource-awareness.md` still cites `storage.quotaBytes` in `CadreNodeConfig`**, a field that no longer exists. Ticket 5 folds the board but does not name this file. Left alone rather than edited from here, since a concurrent agent may hold it; one line to fix when someone does.
- **Nothing was run that takes a device or a network.** `test:e2e` on the three apps, `test:bundle:native` on NativeScript, and `yarn check:published` (which installs from npm and so cannot exercise an unpublished change) were all skipped.
- **The allotment's live effect is still unexercised end to end.** Nothing in this change drives a store to 0.95 of an allotment; what is verified is that the figure reaches `StorageConfig.allotmentBytes` and that a bad one is refused at load. `docs/cadre/node-storage.md` already records that as a limit.

## Suggested review focus

1. The two deviations above — both are one-paragraph decisions a maintainer may simply reverse.
2. `packages/cadre-rn/src/phone-node/leveldb-storage.ts` close and destroy ordering, which is the one platform where a second open over a live handle **throws** rather than merely being wasteful.
3. Whether `reference-app-ns`'s `scopeStorage` helper, which awaits `SharedOpen.get()` on every call, interacts correctly with `take()` — the pre-existing `NOTE:` on `take` says a caller that got the handle before a `take` and runs a statement after the close hits a closed handle, and there is now one more caller (`offlineJournal`) on that path.
4. The documents, against the code: three platform storage sections, two hosting statements, and `docs/strands/writes.md`'s journal section, which went from three per-platform stores to one rule.
