description: On the NativeScript phone app, the storage layer hides one optional ability of the underlying database — listing which data blocks are already stored — so features that depend on that list quietly do nothing on this app.
files: packages/reference-app-ns/src/ns-storage.ts, packages/cadre-core/src/peer-join-backfill.ts
difficulty: easy
tradeoffs: The phone runs as a transaction-only node that is not expected to hold or repair much block data, so the features that go inert may not matter there, and nobody has measured an effect.
----

# The NativeScript lazy storage proxy does not expose `listBlockIds`

`packages/reference-app-ns/src/ns-storage.ts` wraps the real SQLite-backed storage (`SqliteRawStorage` from `@optimystic/db-p2p-storage-ns`) in a proxy class, `LazyNsRawStorage`, because the database open is asynchronous and cadre-core wants a storage object synchronously.

The storage interface (`IRawStorage` in `../optimystic/packages/db-p2p/src/storage/i-raw-storage.ts`) has optional methods that callers detect by checking whether the method exists. `SqliteRawStorage` implements three of them: `getApproximateBytesUsed`, `listBlockIds` and `getStoreIdentity`. The proxy forwards only `getApproximateBytesUsed`. Because the proxy is what cadre-core sees, the other two read as "not supported" on this app even though the database underneath supports them.

Known consequences, from reading the code (not observed on a device):

- `packages/cadre-core/src/peer-join-backfill.ts` checks `storage.listBlockIds` and logs "backfill is inert" when it is absent. That is the catch-up that pushes existing blocks to a peer that has just joined.
- The interface's own documentation says `listBlockIds` is also used at node startup to seed the set of blocks the resilience monitors track; without it that set fills only as blocks are touched.

## Expected behaviour

The proxy forwards `listBlockIds` the same way it forwards the two existing async-generator methods (`await` the open, then `yield*`).

`getStoreIdentity` is a different case and should stay omitted unless a design is found: it is synchronous and its contract says the string is fixed at construction, but the proxy has no open handle at construction. The interface documents omission as the correct answer for a backend that cannot honour the contract. A one-line accepted-tradeoff `NOTE:` at the class would stop this being re-reported.

## What would confirm it matters

Whether either consumer is active under the phone's `profile: 'transaction'` configuration (set in `packages/reference-app-ns/src/cadre-phone.ts`) has not been checked. If neither runs under that profile, this is a consistency fix only.
