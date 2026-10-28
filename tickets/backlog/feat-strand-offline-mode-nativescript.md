description: Offline mode for strands works on the phone kit and in the browser but not in the NativeScript reference app, because NativeScript has no place to save the queue of unsent transactions yet. Give it one so NativeScript apps can use offline mode too.
architecture: docs/strands.md
files: packages/reference-app-ns/src/ns-edge-platform.ts, packages/cadre-core/src/edge-node/platform.ts (`EdgeNodeStorage.offlineJournal`), docs/reference-app-ns.md
tradeoffs: NativeScript is a reference platform with no shipping app depending on offline mode, so the work may wait until someone asks; until then `setStrandOfflineMode` refuses there by name.
----
The `strand-offline-mode` work (`strand-offline-platform-journals`) added an optional `offlineJournal(scope)` to the edge node's storage seam and implemented it for React Native (LevelDB) and the browser (IndexedDB). The NativeScript edge platform (`ns-edge-platform.ts`) does not implement it, so on NativeScript `CadreNode.setStrandOfflineMode` throws `StrandOfflineUnavailableError`.

What is wanted: `offlineJournal(scope)` on the NativeScript edge storage, returning one `SqliteKVStore` per strand scope over the scope's existing SQLite database (upstream's journal keys sit under `optimystic-offline/`, apart from block storage), closed with the scope; the NativeScript reference chat then shows the same toggle, queue line, per-message progress and discard as the other two reference apps.

Check before building: whether `SqliteKVStore` implements `flush` (a store without it is taken to be durable on every write, which must actually be true of the NativeScript SQLite plugin's writes), and that `SqliteRawStorage.listBlockIds` never reads the journal's keys as blocks.
