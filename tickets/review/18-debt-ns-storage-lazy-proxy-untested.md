description: On the NativeScript phone app, a failed open of a per-conversation database file is now retried on the next use instead of being replayed for the rest of the session, and the piece that opens those files has its first automated tests.
files: packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/test/ns-storage.spec.ts, packages/reference-app-ns/vitest.config.ts, docs/reference-app-ns.md, packages/reference-app-ns/src/cadre-phone.ts (model for the policy, not edited)
difficulty: easy
----

# `ns-storage.ts`: retry a failed database open, and cover the open cache

## What changed

`packages/reference-app-ns/src/ns-storage.ts` gives cadre-core one storage object per scope (a strand id, or the party's control-database key). The NativeScript SQLite open is asynchronous but cadre-core asks for a synchronous factory, so the module returns a proxy whose methods await a cached open promise. The cache is the module-level `openByDbName` map, keyed by database name (`sereus-<scope>`).

- `openStorage` now removes a rejected open promise from the map, so the next operation on that database opens again. Operations already awaiting the failed promise still receive its rejection. The removal is guarded by an identity check so an older promise's handler cannot delete a newer entry. This is the same shape as `openIdentityDb` in `src/cadre-phone.ts`.
- The `openByDbName` doc comment states the policy. A `NOTE:` on `openStorage` records two conditional concerns (see Tripwires).
- New suite `test/ns-storage.spec.ts`.
- `vitest.config.ts` header comment and `docs/reference-app-ns.md` (the storage paragraph near "`CadreNodeConfig.storage.provider` is a sync factory", the Unit row of the Testing Strategy table, and the "Unit suite" section) no longer list `ns-storage.ts` as uncovered, and the doc states the retry rule.

## Tests added

All in `packages/reference-app-ns/test/ns-storage.spec.ts`, over a mocked `@optimystic/db-p2p-storage-ns` (a fake `openOptimysticNSDb` that records names and can be made to fail, and a fake `SqliteRawStorage` with only `getMetadata` and `listRevisions`). Each test reloads the module with `vi.resetModules()` so the cache starts empty.

- **opens each database once, however many proxies and operations share it** — two proxies for scope `a` and one for `b`, three concurrent operations then a later one on `a`; the opens are exactly `['sereus-a', 'sereus-b']` (also pins the `sereus-` prefix), both `a` proxies delegate to the same storage instance, and `b` to a different one.
- **reports a failed open to the operations awaiting it, then retries on the next one** — one queued open error; two concurrent operations both reject with that error after a single open attempt; a third operation succeeds after a second open of the same name.
- **streams listRevisions from the delegate, opening only once iteration starts** — no open before the first `next()`, the yielded items are the delegate's, and the three arguments arrive in order. `listPendingTransactions` has the same two-line body and is not tested separately.

The thirteen one-line delegating methods are deliberately not tested individually; their signatures come from `IRawStorage`, so a wrong delegation is a type error.

## Validation run

- `yarn workspace @serfab/reference-app-ns typecheck` — passes (the tsconfig includes `test/**/*.ts`).
- `yarn workspace @serfab/reference-app-ns test` — 9 files, 131 tests pass.
- `yarn lint` — passes.

## Known gaps, stated honestly

- The retry test was not run against the previous `openStorage` to watch it fail. By reading, the old code kept the rejected promise in the map, so the third operation would have rejected and the opens list would have had one entry; a reviewer who wants proof can revert the `void opening.catch(...)` lines and rerun.
- Not covered by a test, verified by reading only: the identity guard that stops an older promise's handler deleting a newer map entry; and the `SqliteRawStorage` constructor throwing (it runs inside `.then`, so it rejects the same promise and is forgotten the same way).
- Nothing was run on a device or emulator. The bundle smoke (`test:bundle`) was not run; the change adds no imports.
- Nothing ever closes these connections. Unchanged and out of scope: cadre-core leaves closing the store to the embedder and the app holds them for the process life.

## Tripwires

Parked in the `NOTE:` comment on `openStorage` in `src/ns-storage.ts`:

- The upstream opener (`../optimystic/packages/db-p2p-storage-ns/src/ns-opener.ts`, a read-only sibling repository) opens the native handle and then applies the schema, and does not close the handle if applying the schema throws. A retry then opens a second handle on the same file. Fine while schema application does not fail in practice; the fix belongs upstream. `src/cadre-phone.ts` has the same exposure for the identity database.
- Retries have no backoff: a permanently broken file costs one open attempt per operation. Revisit only if a failing scope is seen issuing opens in a tight loop.

## Related, filed separately

The proxy implements `getApproximateBytesUsed` but not `listBlockIds`, the other optional `IRawStorage` method `SqliteRawStorage` supports. Tracked as `debt-ns-storage-proxy-omits-block-listing` in `tickets/backlog/`.
