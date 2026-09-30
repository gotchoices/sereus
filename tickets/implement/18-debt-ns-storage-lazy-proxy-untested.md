description: On the NativeScript phone app, make a failed open of a per-conversation database file get retried on the next use instead of being replayed for the rest of the session, and add the first automated tests for the piece that opens those files.
files: packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/test/ns-storage.spec.ts (new), packages/reference-app-ns/test/cadre-phone.spec.ts (model only, not edited), packages/reference-app-ns/src/cadre-phone.ts (model only, not edited), packages/reference-app-ns/vitest.config.ts, docs/reference-app-ns.md
difficulty: easy
----

# `ns-storage.ts`: retry a failed database open, and cover the open cache

## Background

`packages/reference-app-ns/src/ns-storage.ts` is the NativeScript app's storage provider. Cadre's node configuration asks for a **synchronous** factory returning one storage object per scope (a scope is a strand id, or the party's control-database key; a strand is the app's term for a shared conversation/dataset). The NativeScript SQLite open is **asynchronous**, so `makeLazyNsStorage(scope)` returns a proxy immediately and every proxy method awaits a cached open promise before delegating to the real `SqliteRawStorage`.

The cache is the module-level `openByDbName` map, keyed by database name (`sereus-<scope>`), holding the open **promise**. cadre-core calls the provider again for a scope after that scope's runtime has stopped (see the `RawStorageProvider` doc comment in `packages/cadre-core/src/types.ts`), so the cache is what keeps one SQLite connection per database file.

The module has no unit tests. `test/cadre-phone.spec.ts` mocks it out entirely.

## Decision: a rejected open is forgotten, so the next operation retries

Today a rejected open promise stays in the map, and every later operation on that scope replays the original error until the app is restarted.

Change it to the policy the same package already uses for its other SQLite handle. `openIdentityDb` in `src/cadre-phone.ts` caches the in-flight promise and removes it from the cache when it rejects ("a rejected open is forgotten so the next call retries"). `openStorage` gets the same shape:

```ts
function openStorage(dbName: string): Promise<SqliteRawStorage> {
	const cached = openByDbName.get(dbName);
	if (cached) return cached;
	const opening = openOptimysticNSDb(dbName).then((db) => new SqliteRawStorage(db));
	openByDbName.set(dbName, opening);
	// The rejection itself reaches every caller awaiting `opening`; this only forgets it.
	void opening.catch(() => {
		if (openByDbName.get(dbName) === opening) openByDbName.delete(dbName);
	});
	return opening;
}
```

Why this and not "stay failed":

- A transient failure (the SQLite plugin not ready during startup, a momentary out-of-space condition) otherwise disables that scope for the whole session, and the app has no screen that offers a way out.
- A permanent failure (a corrupt file) behaves the same to the user under both policies: every operation fails with an open error. Retrying costs one extra failed open attempt per operation, which is acceptable for a path that is already failing.
- Two caches in one package with opposite failure policies is a trap for the next reader; one policy is simpler to reason about.

Callers awaiting the failed promise at the time still receive the original rejection. Only operations that begin after the rejection has settled trigger a new open.

Rejected alternative — retry with a bounded count or backoff: no evidence of a failure mode that needs it, and it adds state and timers to a module that has none.

## Tests

New file `packages/reference-app-ns/test/ns-storage.spec.ts`. Follow the hoisted-doubles pattern of `test/cadre-phone.spec.ts`: one `vi.hoisted` block holding the state and the fakes, `vi.mock('@optimystic/db-p2p-storage-ns', …)` returning closures over it, and a `loadModule()` helper that calls `vi.resetModules()` then dynamically imports `../src/ns-storage`, so the module-level `openByDbName` map starts empty in every test. The mock must not be shared with `cadre-phone.spec.ts` — that suite mocks `../src/ns-storage` itself and never reaches it.

Doubles needed:

- `openOptimysticNSDb(name)` — records `name` in `state.opens`, rejects with `state.openErrors.shift()` when one is queued, otherwise resolves to a small object carrying the name.
- `FakeSqliteRawStorage` — constructed with that object; implements only the methods the tests call (`getMetadata`, `listRevisions`), recording arguments and returning/yielding canned values. It does not need to implement the whole `IRawStorage` interface.

Three tests, no more. The thirteen one-line delegating methods are not tested individually — a wrong delegation there is a type error, since each method's signature comes from `IRawStorage`.

- **One open per database name.** Create two proxies for scope `a` and one for scope `b`. Start operations on all three concurrently (`Promise.all`), then one more on `a` afterwards. Expect `state.opens` to equal `['sereus-a', 'sereus-b']` — this also pins the `sereus-` name prefix — and both `a` proxies to have delegated to the same `FakeSqliteRawStorage` instance.
- **A failed open is reported, then retried.** Queue one open error. Start two operations on the same scope concurrently; both reject with that error and `state.opens` has one entry. Then run a third operation: it resolves with the delegate's value and `state.opens` has two entries, both the same name. This is the test that fails against the current code.
- **The async-generator shape.** `listRevisions(blockId, startRev, endRev)` on a proxy yields exactly the items the delegate yields, with the three arguments passed through in order, and the open has not been attempted before the first `next()` (an async generator body does not run until iterated — the proxy stays lazy). `listPendingTransactions` has the identical two-line body and is covered by this one test.

Run with `yarn workspace @serfab/reference-app-ns test` and `yarn workspace @serfab/reference-app-ns typecheck`, plus `yarn lint`.

## Edge cases & interactions

- **Callers already awaiting a failed open.** They must receive the original rejection, not a retry. Verified by the second test (two concurrent operations, one open attempt, both reject).
- **The `.catch` used only to forget the entry must not swallow the error or create an unhandled rejection.** It is attached to `opening` as a side branch; callers hold `opening` itself. `void` prefix per the lint rule. Verified by the second test (the rejection is observed) and by Vitest failing a run on an unhandled rejection.
- **Forgetting the wrong entry.** A retry may already have replaced the map entry by the time an older promise's catch handler runs; the identity check (`openByDbName.get(dbName) === opening`) prevents deleting the newer one. Verified by inspection — same guard as `openIdentityDb`.
- **The `SqliteRawStorage` constructor throwing.** It runs inside `.then`, so it becomes a rejection of the same promise and is forgotten the same way. Verified by inspection.
- **A half-finished open upstream.** `openOptimysticNSDb` (in the read-only sibling `../optimystic/packages/db-p2p-storage-ns/src/ns-opener.ts`) opens the native handle and then applies the schema; if applying the schema throws, the opener does not close the handle it opened. A retry then opens a second native handle on the same file. `src/cadre-phone.ts` has the same exposure for the identity database already. Do not edit the sibling repo. Record it as a `NOTE:` comment on `openStorage`: fine while schema application does not fail in practice; if retried opens are ever seen blocking on a leaked handle, the fix belongs in the upstream opener.
- **Retry cost on a permanently broken file.** Each operation makes one fresh open attempt with no backoff. Record as part of the same `NOTE:` — revisit only if a failing scope is seen issuing opens in a tight loop.
- **Nothing ever closes these connections.** Unchanged by this ticket; cadre-core leaves closing the store to the embedder and the app holds them for the process life. Out of scope.
- **Test isolation.** `openByDbName` is module state; without `vi.resetModules()` per test, the first test's cached open makes later tests' `state.opens` assertions wrong. Verified by the tests themselves asserting exact `opens` contents.

## Related, filed separately

The proxy implements `getApproximateBytesUsed` but not the other optional `IRawStorage` method that `SqliteRawStorage` supports, `listBlockIds`. Parked as `debt-ns-storage-proxy-omits-block-listing` in `tickets/backlog/`; not part of this ticket.

## TODO

- Change `openStorage` in `src/ns-storage.ts` to forget a rejected open, as in the snippet above. Update the `openByDbName` doc comment to state the policy, and add the `NOTE:` covering the upstream half-finished-open leak and the no-backoff retry.
- Add `test/ns-storage.spec.ts` with the three tests above.
- Update the comment in `vitest.config.ts` that lists `ns-storage.ts` among modules "not unit-targeted here" — only the pages remain.
- Update `docs/reference-app-ns.md` → "Testing Strategy": the Unit row of the table ("`src/ns-storage.ts` and the pages are **not** covered here") and the "Still uncovered here" sentence in "Unit suite"; add `src/ns-storage.ts` to the first group of targeted modules with one sentence on what is covered (the open cache and its retry-after-failure rule, over a mocked `@optimystic/db-p2p-storage-ns`). Also state the retry policy where that doc describes the lazy proxy (the paragraph near "`CadreNodeConfig.storage.provider` is a sync factory"). Describe the current behaviour only, no history.
- Run typecheck, the unit suite and lint; all must pass.
