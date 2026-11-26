description: An app can now declare a column that references a large file (a photo, a document) stored outside the row, but Sereus machines keep those files only in memory, so they are lost when the machines holding them restart. Give every platform a persistent store for them so apps can attach files to strand rows.
architecture: docs/schema-guide.md#limits-and-accepted-tradeoffs
files: packages/cadre-core/src/strand-instance-manager.ts (createLibp2pNode ~978), packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions), packages/cadre-core/src/peer-join-backfill.ts (NOTE on strand nodes having no kvStore), packages/cadre-core/src/edge-node/*, packages/cadre-rn, packages/reference-app-web/src/lib/strand-storage.ts, packages/reference-app-ns, ../optimystic/docs/blobs.md, ../optimystic/packages/db-p2p/src/blob/piece-store.ts (IPieceStore), docs/schema-guide.md, docs/strands/app-schema.md
tradeoffs: No Sereus app asks for attachments yet, and the work touches every platform's storage wiring plus a per-node-class choice of how much of other people's files a phone keeps, so it can wait until an app needs it.
----

# Strand blobs survive a restart

## What changed upstream

Optimystic 1.29.0 adds blobs: a large value cut into content-addressed pieces, kept outside transactions, copied to the machines responsible for it, and referenced from a SQL row by a `blobref` column (`../optimystic/docs/blobs.md`). A node keeps pieces in `NodeOptions.pieceStorage` and its pin, owed-copy and reclaim records in `NodeOptions.kvStore`. Without a piece store a node uses an in-memory one (logged on the `node-wiring` debug channel).

## What Sereus does today

No Sereus node passes `pieceStorage`, and strand nodes pass no `kvStore`. An app that declares a `blobref` column in its strand schema gets a working column whose bytes live only in memory on the writer and on each cohort member that pulled them. Restarting every holder loses the bytes while the row keeps the reference. `docs/schema-guide.md` → "Limits and accepted tradeoffs" says not to use the type yet.

Since Optimystic 1.30 there are no separate `pieceStorage` and `kvStore` options to pass: a node takes one `NodeStorage` carrying the blocks, the node-local records and the pieces together, so each platform's work here is one opener rather than three fields. The SQL plugin already hands that whole value to the strand node (ticket `optimystic-1-30-plugin-node-storage`), which narrows what is left.

One site this leaves, found reviewing that ticket: `composeStrand` passes the storage to the Optimystic plugin's `storageFactory` on the `local` transactor only, so a `network` connection over a *client* node — one that holds no blocks and therefore carries no blob service of its own — leaves the plugin to build a blob service over memory piece and key-value stores even though the connection was given real ones. Unreachable while no schema declares a `blobref` column; a `NOTE:` sits at the site.

## What is wanted

- Every platform passes a persistent piece store beside its block store, with the matching upstream backend: `FilePieceStore` (Node: cadre-cli, cadre-host, provider), `LevelDBPieceStore` (React Native, not yet run on a device upstream), `IndexedDBPieceStore` (browser), `SqlitePieceStore` (NativeScript). Strand nodes also get a persistent `kvStore`, which the peer-join-backfill NOTE already asks for.
- A phone keeps only what it put, pinned or read: `NodeOptions.blobs.hold: 'on-demand'` for the `device` node class, `'eager'` for `server`. Decide whether that follows the node class or the per-node roles.
- The app-facing API: how an app puts bytes and gets a reference to write (`plugin.blobsFor(table)` or `node.blobs` through the strand handle), and how it reads them back. The two-commit pattern for "no one sees the reference before the bytes moved" (`../optimystic/docs/blobs.md` → "Committing a reference") goes in `docs/strands/app-schema.md`.
- Remove the limit line from `docs/schema-guide.md`.
