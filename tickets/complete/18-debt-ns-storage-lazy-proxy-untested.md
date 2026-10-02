description: On the NativeScript phone app, a failed open of a per-conversation database file is now retried on the next use instead of being replayed for the rest of the session, and the piece that opens those files has its first automated tests.
files: packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/test/ns-storage.spec.ts, packages/reference-app-ns/vitest.config.ts, docs/reference-app-ns.md, packages/reference-app-ns/README.md
difficulty: easy
----

# `ns-storage.ts`: retry a failed database open, and cover the open cache

## What shipped

`packages/reference-app-ns/src/ns-storage.ts` gives cadre-core one storage object per scope (a strand id, or the party's control-database key). The NativeScript SQLite open is asynchronous but cadre-core asks for a synchronous factory, so the module returns a proxy whose methods await a cached open promise. The cache is the module-level `openByDbName` map, keyed by database name (`sereus-<scope>`).

- `openStorage` removes a rejected open promise from the map, so the next operation on that database opens again. Operations already awaiting the failed promise still receive its rejection. The removal is guarded by an identity check so an older promise's handler cannot delete a newer entry. Same shape as `openIdentityDb` in `src/cadre-phone.ts`.
- New suite `test/ns-storage.spec.ts` (three tests) over a mocked `@optimystic/db-p2p-storage-ns`: one open per database name across proxies and operations; a failed open reported to its waiters and retried by the next operation; `listRevisions` opening only when iterated and passing its arguments through in order.
- `vitest.config.ts` header comment and `docs/reference-app-ns.md` no longer list `ns-storage.ts` as uncovered, and the doc states the retry rule.

Implemented in `ticket(implement): debt-ns-storage-lazy-proxy-untested`.

## Review findings

**Checked**

- The implement diff, read before the handoff: `openStorage`, its comments, the new spec, the `vitest.config.ts` comment and the three edited places in `docs/reference-app-ns.md`.
- The retry logic against its stated model: `openIdentityDb` in `src/cadre-phone.ts` has the same structure line for line (cache check, `.then`, store, guarded `void opening.catch`, return). The rejection handler does not swallow the error: every caller awaits `opening` itself and receives the rejection; the detached handler only clears the map entry.
- Error paths by reading: a throw from the `SqliteRawStorage` constructor happens inside `.then`, so it rejects the cached promise and is forgotten the same way. `openOptimysticNSDb` is an `async` function, so it cannot throw synchronously before the map is set.
- The implementer's open gap "the retry test was not watched failing": closed. With the `void opening.catch(...)` lines removed, `reports a failed open to the operations awaiting it, then retries on the next one` fails and the other two tests pass; the lines were then restored (working tree matched the commit afterwards).
- The tripwire claim about the upstream opener: confirmed by reading `../optimystic/packages/db-p2p-storage-ns/src/ns-opener.ts` (read-only sibling) — `openOrCreate` then `applySchema` with no close on failure.
- The tests against the "must pay for themselves" bar. All three kept: the first two pin the cache contract (branching logic, and the second is the reproduction of the defect fixed); the third catches a swap of the two numeric `listRevisions` arguments, which the types cannot.
- Docs: every file mentioning `ns-storage` (`docs/reference-app-ns.md`, `packages/reference-app-ns/README.md`, `vitest.config.ts`). The README's storage paragraph defers to the source file for the cache behaviour, so it needed no retry text.
- `yarn workspace @serfab/reference-app-ns typecheck` — passes. `yarn workspace @serfab/reference-app-ns test` — 9 files, 131 tests pass. `yarn lint` — exit 0.

**Found and fixed in this pass (minor)**

- The source-tree listings in `docs/reference-app-ns.md` and `packages/reference-app-ns/README.md` described the factory as `makeLazyNsStorage(strandId)`; the parameter is `scope` (a strand id or the party's control key). Both now say `makeLazyNsStorage(scope)`.

**Major findings**

None. The change is about ten lines copying an existing, already-reviewed pattern in the same package, and the mutation check shows the test detects its removal.

**Tripwires (parked, not ticketed)**

Both live in the `NOTE:` comment on `openStorage` in `src/ns-storage.ts`:

- The upstream opener leaks the native handle if applying the schema throws, so a retry opens a second handle on the same file. The fix belongs upstream.
- Retries have no backoff: a permanently broken file costs one open attempt per operation.

**Not verified**

- The identity guard (an older promise's handler must not delete a newer map entry) has no test; verified by reading. It cannot trigger today, because an entry is only replaced after its own handler has already deleted it.
- Nothing was run on a device or emulator, and the bundle smoke (`test:bundle`) was not run; the change adds no imports.
- Nothing closes these connections. Unchanged: cadre-core leaves closing the store to the embedder and the app holds them for the process life.

## Related, filed separately

The proxy implements `getApproximateBytesUsed` but not `listBlockIds`, the other optional `IRawStorage` method `SqliteRawStorage` supports. Tracked as `debt-ns-storage-proxy-omits-block-listing` in `tickets/backlog/`.
