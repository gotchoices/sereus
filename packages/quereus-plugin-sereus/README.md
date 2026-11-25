# @serfab/quereus-plugin-sereus

A [Quereus](https://github.com/gotchoices/quereus) plugin that connects a Quereus `Database` to a Sereus strand, so an app or tool reads and writes the strand with SQL. It registers the Optimystic storage module and the crypto functions, creates the strand's libp2p node (or uses one it is given), applies the strand's own `Strand` schema, and applies the app's schema as `App`.

`@serfab/cadre-core` opens every strand database through this package. An app that runs a cadre node gets its strand databases from cadre-core; use this package directly for tools, tests and Quoomb.

## Install

```bash
yarn add @serfab/quereus-plugin-sereus @quereus/quereus
```

The `Database` passed to this package must come from the same `@quereus/quereus` instance the package resolves.

## First run

This Node script opens a strand in one process, writes two rows and reads them back. It is adapted from `test/e2e/local-transactor.e2e.spec.ts`. It imports `FileRawStorage` from `@optimystic/db-p2p-storage-fs`, which this package depends on; add that package to your own dependencies if your package manager does not expose transitive ones.

```typescript
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Database } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';

const dir = './data/my-strand';
await mkdir(dir, { recursive: true });

const db = new Database();
const strand = await connectToStrand(db, {
	strandId: randomUUID(),
	transactor: 'local',
	storage: new FileRawStorage(dir),
	schema: 'table Msg (Id integer primary key, Body text not null)',
	schemaVersion: 1,
});

await db.exec(`insert into App.Msg (Id, Body) values (1, 'a'), (2, 'b')`);
for await (const row of db.eval('select count(*) as c from App.Msg')) {
	console.log(row);	// { c: 2 }
}

await db.close();
await strand.shutdown();
```

The script uses the `local` transactor so that it needs no other node. An application leaves `transactor` unset. Close the `Database` before calling `shutdown()`, so no write can begin on a released connection.

How to write the `schema` text is in the [schema guide](https://github.com/gotchoices/sereus/blob/master/docs/schema-guide.md).

## Entry points

| Import | Runs in | Provides |
|---|---|---|
| `@serfab/quereus-plugin-sereus` | Node | `connectToStrand`, `checkAppSchema`, the error classes and the types |
| `@serfab/quereus-plugin-sereus/plugin` | Node | Default export: a plugin registration function that takes settings as SQL values. A bundler that honours the `browser` condition gets the browser bundle instead. |
| `@serfab/quereus-plugin-sereus/plugin-browser` | Browser or worker | The same registration function as one bundled ESM file (`dist/plugin-browser.js`, with a source map beside it). It imports `@quereus/quereus` by bare specifier, which the host must resolve. |

The Node entries create a TCP libp2p node and keep blocks in memory unless given storage. The browser entry dials WebSockets and circuit relays only, and stores blocks in IndexedDB.

## `connectToStrand(db, options)`

Resolves to a [connection result](#the-connection-result). The options type is `StrandConnectionOptions` in [`src/types.ts`](src/types.ts).

| Option | Default | Meaning |
|---|---|---|
| `strandId` | required | The strand's id. The strand's libp2p network is named `strand-<strandId>`. |
| `schema`, `schemaVersion` | none | The app schema body and its version, given together or not at all. Without them the connection serves the `Strand` tables only. |
| `bootstrapNodes` | `[]` | Multiaddrs of nodes that already serve the strand. |
| `transactor` | `'network'` | Which Optimystic transactor commits go through. See [`transactor` values](#transactor-values). |
| `storage` | none | An `IRawStorage` that persists the strand's blocks. Borrowed: `shutdown()` does not close it. |
| `clusterSize` | `4` | Nodes the strand's replication cluster should have: an integer of at least 2. See [`clusterSize`](#clustersize). |
| `libp2pNode` | none | An existing strand node. The connection uses it and leaves it running on `shutdown()`. `port`, `bootstrapNodes`, `fretProfile` and `clusterSize` are then unused. |
| `coordinatedRepo` | none | The injected node's handle for coordinating writes to the blocks it holds. Required with a node that serves blocks, and refused with a client node (`servesBlocks: false`), which holds none and so reads and writes through the strand's serving machines. |
| `port` | `0` | TCP listening port of the node the connection creates. `0` picks a free port. The browser entry ignores it. |
| `fretProfile` | `'edge'` | FRET profile of the node the connection creates: `'edge'` or `'core'`. |
| `enableCache` | `true` | Passed to the Optimystic plugin as `enable_cache`. |
| `offline` | none | Turns on Optimystic's offline queue. See [Durability and offline mode](#durability-and-offline-mode). |
| `cohortReachability` | none | The gate the offline queue asks before it submits, in place of the node's own. cadre-core passes one that also waits for the party's own machines. |
| `sAppId`, `sAppVersion` | none | Accepted and not read by the connection. |

### The app schema and its version

`schema` is the body of `declare schema App { … }`: `table`, `index`, `unique index`, `view`, `materialized view` and `assertion` items. `schemaVersion` is a whole number of at least 1 that the app raises with every change to the schema. The strand records the highest version any member has applied, and a connect below it applies nothing and fails with `AppSchemaOutdatedError`. See [App schema versions across a strand's members](https://github.com/gotchoices/sereus/blob/master/docs/strands/app-schema.md#app-schema-versions-across-a-strands-members).

### `transactor` values

- `'network'`: commits go through the strand's libp2p cluster. A node that is alone coordinates for itself, so this works with one node or many. It is the only value an application should use.
- `'local'`: commits go straight to this process's raw storage and no other node is consulted. For in-process tests and tooling. Give it a persistent `storage` to keep data across restarts.
- `'test'`: Optimystic's in-memory fake. No libp2p node is created unless one is injected. For unit tests.

### `clusterSize`

4 is the smallest size at which a write still commits while one holder is offline; at 2 or 3 every holder must be awake for every write. Every node of a strand must use the same value, and the value is fixed when the libp2p node is created. The full reasoning is in [Replication cluster size](https://github.com/gotchoices/sereus/blob/master/docs/cadre/control-replication.md#replication-cluster-size).

## The connection result

`connectToStrand` and the plugin's default export both resolve to a `SereusPluginResult` ([`src/types.ts`](src/types.ts)).

| Member | Use |
|---|---|
| `shutdown()` | Releases the Optimystic plugin and stops the libp2p node if the connection created it. |
| `transactor` | The transactor the connection resolved to. |
| `hydrated` | How many persisted tables and indexes the catalog was loaded with before the schemas were applied. Both are 0 on empty storage. |
| `appSchema` | Present when `schema` was given. A promise that never rejects and settles with how the apply ended: `applied`, `failed` or `cancelled`. |
| `appSchemaWaitingFor`, `appSchemaDeferredBy` | Present when the connect-time apply was deferred: what it waits for (`'queue'` or `'cohort'`), and the queued transaction ids that refused it. |
| `onAppSchemaSuperseded(listener)` | Called once, with an `AppSchemaOutdatedError`, when another member has recorded a higher schema version. The host must then close the database. |
| `applyAppSchema({ schema, schemaVersion })` | Applies an app schema to the live connection and starts the version check for it. |
| `onCommitDurability(listener)`, `onCommitFullyHeld(listener)` | Report who holds what each commit wrote. |
| `offline` | The offline queue's controller. Present when `offline` was given. |
| `createEmptyCollections(except?)` | Commits an empty collection for every declared table that has none. For a strand's founder. |

## App schema checks and refusals

`checkAppSchema({ schema, schemaVersion })` needs no strand. It rejects with `AppSchemaRefusedError` for the refusals that the schema text and version decide alone: a `seed` item, an item the parser did not recognize (a `create …` prefix, a misspelled keyword), a syntax error, or a version that is not a whole number of at least 1.

A connect raises `AppSchemaRefusedError` when the schema can never apply to the strand's tables as they are, for example a `not null` column with no default added to a table that has rows. `AppSchemaOutdatedError` is its subclass for a version below the one the strand records. Retrying the same schema fails the same way, so a host should not retry. `appSchemaRefusalOf(error)` finds either error through wrapping errors. A storage or network fault is never one of these errors. See [A schema that can never apply here is not retried](https://github.com/gotchoices/sereus/blob/master/docs/strands/app-schema.md#a-schema-that-can-never-apply-here-is-not-retried).

An apply that queued offline transactions refuse, or that cannot reach the strand's other nodes, does not fail the connect. The connection comes up with the schema it had, sets `appSchemaWaitingFor`, and retries; `appSchema` settles when a retry ends. See [An app schema upgrade waits for the queue or the cohort](https://github.com/gotchoices/sereus/blob/master/docs/strands/app-schema.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort).

An app table may share its name with one of the strand's own tables; the two are stored separately. See [Same-named tables in Strand and App](https://github.com/gotchoices/sereus/blob/master/docs/strands/app-schema.md#same-named-tables-in-strand-and-app).

## Durability and offline mode

`onCommitDurability` is called after every commit that wrote something, before the commit returns. `onCommitFullyHeld` is called once when a commit that was reported below full replication becomes held by every node of its cluster. Both pass through from `@optimystic/quereus-plugin-optimystic`, whose README defines the report: [A commit's durability](https://github.com/gotchoices/optimystic/blob/main/packages/quereus-plugin-optimystic/README.md#a-commits-durability--pluginoncommitdurabilitylistener). The `SqlCommitDurability` and `CommitFullyHeld` types are re-exported here.

The `offline` option is that plugin's `offline` block without `journalLabel`, which this package derives from the strand id: [Offline mode](https://github.com/gotchoices/optimystic/blob/main/packages/quereus-plugin-optimystic/README.md#offline-mode--pluginoffline). With it, the result's `offline` is the queue's controller, and `offlineControllerOf(db)` finds the same controller from the `Database`. The queue's status, state and error types are re-exported here. Without a `journal` the queue lives in memory, except in the browser entry, which journals into the strand's IndexedDB database. The `Strand` tables are always acknowledged by the network, queue or not.

What these mean for an app is in [Writing to a strand: durability and offline mode](https://github.com/gotchoices/sereus/blob/master/docs/strands/writes.md).

## Founding a strand: `createEmptyCollections`

A table nobody has written has no collection, so no single node can show that it is empty: every read of it asks the strand's other nodes, and fails while they are offline. The result's `createEmptyCollections(except?)` commits an empty collection for every table the `Strand` and `App` schemas declare that has none, and resolves to the number it committed.

- `except` lists qualified tables (`'Strand.Header'`) that the caller is about to write. Their inserts create their collections, so those tables are left out. A name that matches no declared table throws.
- The founder calls it once, before its founding write, while no other node can have written to the strand. cadre-core's founder bootstrap does this.
- Call it only while nothing else writes through the `Database`. It commits whatever is staged in those collections, outside any SQL transaction.

The same step is exported as `createEmptyCollections(db, bridge, schemaNames, except?)` for a database composed outside this package. `bridge` is the Optimystic plugin's transaction bridge (`txnBridge` on its result). The call throws when `schemaNames` declare no Optimystic table.

## Plugin settings

The default export of `./plugin` and `./plugin-browser` takes a settings map of SQL values and resolves to the same [connection result](#the-connection-result):

```typescript
import { Database } from '@quereus/quereus';
import sereusPlugin from '@serfab/quereus-plugin-sereus/plugin';

const db = new Database();
const strand = await sereusPlugin(db, {
	strand_id: '550e8400-e29b-41d4-a716-446655440000',
	schema: 'table Message (Id text primary key, Content text)',
	schema_version: 1,
	bootstrap_nodes: '/ip4/192.0.2.10/tcp/9100/p2p/<peer id>',
});
```

Quereus's `registerPlugin(db, sereusPlugin, settings)` also works, but it returns nothing, so the caller has no `shutdown()` to call.

| Setting | Default | Accepts |
|---|---|---|
| `strand_id` | required | A string: the strand's id |
| `bootstrap_nodes` | `''` | Comma-separated multiaddrs |
| `schema` | none | The app schema body |
| `schema_version` | none | A whole number of at least 1. Required with `schema` and refused without it |
| `transactor` | `'network'` | `'network'`, `'local'` or `'test'` |
| `storage_path` | none | Node entry only: a directory for a `FileRawStorage`. The browser entry rejects it |
| `port` | `0` | An integer from 0 to 65535 |
| `enable_cache` | `true` | `true`, `false`, `1` or `0` |
| `fret_profile` | `'edge'` | `'edge'` or `'core'` |
| `sapp_id`, `sapp_version` | `'unknown'`, `'1.0.0'` | Strings. Accepted and not read by the connection |

`clusterSize`, `offline`, `storage`, `libp2pNode` and `cohortReachability` have no setting; they are programmatic only.

Settings are checked strictly when the plugin loads (`parseConfig` in [`src/parse-config.ts`](src/parse-config.ts)):

- An unknown key or a value of the wrong type fails the load with one error that lists every problem. Nothing falls back to a default the user did not choose, so a host that adds keys of its own to the settings map cannot load the plugin.
- A setting left out, set to null, or (for the string and select settings) set to `''` takes its default.
- `port`, `schema_version` and `enable_cache` must be a JSON number or boolean. A `${VAR}` reference in `quoomb.config.json` expands to a string, which they reject.

## Loading in Quoomb Web

Quoomb Web imports a plugin by URL in its worker and registers the module's default export. The published browser bundle does not load that way:

- **The bundle imports `@quereus/quereus` by bare specifier.** The build leaves Quereus external so that the plugin uses the host's Quereus instance. A browser resolves a bare specifier in a module imported by URL only through an import map, and Quoomb Web's worker supplies none, so the import fails before the plugin registers.
- **The Plugins panel's install-by-URL registers a plugin with empty settings.** This plugin refuses that, because `strand_id` is required. Only a `plugins` entry in `quoomb.config.json` carries settings.

The browser entry is for a host that resolves `@quereus/quereus` itself, such as an app whose bundler includes the entry and maps the specifier to the app's own Quereus module. Such a host also meets these limits:

- **Bootstrap addresses must be ones a browser can dial.** From an `https://` page that means `/wss` addresses or addresses through a relay. Plain `ws://` and raw TCP do not dial.
- **A host that loads by URL through Quoomb's loader needs `https:`.** The loader accepts only `https:` and `file:` plugin URLs, so a bundle served from `http://localhost` is refused.
- **Quoomb's loader discards the registration result,** so nothing calls `shutdown()`. The libp2p node stops when the worker does.
- **The browser entry has no WebRTC transport.**

## What it registers

- The `optimystic` virtual table module, set as the database's default, so tables declared without a `using` clause are stored in the strand.
- The functions `StampId()`, `digest()`, `sign()`, `verify()` and `randomBytes()`.
- Schema `Strand` (the strand's membership tables) on every connection, and schema `App` when `schema` is given.

## What it writes

- **Node, `storage` or `storage_path` given:** the strand's blocks, in that storage. Without either, blocks live in memory and are lost when the process exits.
- **Browser entry:** an IndexedDB database named `sereus-strand-<strandId>`, holding the strand's blocks and, with `offline` on and no `journal` given, the offline queue's journal. `shutdown()` does not close or delete it.

Set `DEBUG=sereus:plugin:*` for the connection's log.

## Other exports

`MIN_CLUSTER_SIZE`, `DEFAULT_STRAND_CLUSTER_SIZE`, `CONTROL_REPLICATION_BREADTH`, `COHORT_READ_DEADLINE_MS`, the cluster policies and their builders ([`src/cluster-size.ts`](src/cluster-size.ts)), and `wrapStorageWithCache` / `disposeStorageCache` ([`src/cached-storage.ts`](src/cached-storage.ts)) are exported for cadre-core, which builds the control and strand nodes with them. An app has no reason to call them.

## Development

```bash
yarn build      # tsc, then esbuild writes dist/plugin-browser.js
yarn test       # unit and e2e projects
yarn test:e2e   # e2e project only: real libp2p and FileRawStorage
yarn dev:test   # watch mode
yarn typecheck
```

The suite refuses to run against a stale build of the linked `@optimystic/*` and `@quereus/quereus` packages: see [Stale-build guard](https://github.com/gotchoices/sereus/blob/master/docs/contributing/gates.md#stale-build-guard). Releasing is covered in [Releasing](https://github.com/gotchoices/sereus/blob/master/docs/contributing/releasing.md).

## Documentation

- [Schema guide](https://github.com/gotchoices/sereus/blob/master/docs/schema-guide.md): writing an app schema.
- [App schemas: versions, upgrades and change notifications](https://github.com/gotchoices/sereus/blob/master/docs/strands/app-schema.md).
- [Writing to a strand: durability and offline mode](https://github.com/gotchoices/sereus/blob/master/docs/strands/writes.md).
- [Concepts](https://github.com/gotchoices/sereus/blob/master/docs/concepts.md) and [architecture](https://github.com/gotchoices/sereus/blob/master/docs/architecture.md).

## License

MIT
