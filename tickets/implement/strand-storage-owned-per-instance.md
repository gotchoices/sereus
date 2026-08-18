---
description: Waking a sleeping workspace makes the app ask for a brand-new handle to its own data store instead of reusing the one it already has, which throws away the speed-up we just added and, with in-memory storage, loses the workspace's data. Make each workspace hold on to one data-store handle for as long as it is running.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/quereus-plugin-sereus/src/cached-storage.ts, packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/reference-app-ns/src/ns-storage.ts
difficulty: medium
---

# A strand instance owns one resolved raw storage for its lifetime

## The defect, reproduced

`StrandInstanceManager.buildStrandRuntime` calls the embedder's storage provider
every time it runs, and it runs on **both** `startStrand` and `resumeStrand`. A
hibernation wake therefore re-enters the provider callback and gets a second
`IRawStorage` over the same durable backend.

Reproduced 2026-08-18 against `packages/cadre-core` at `76c7a9c` with a throwaway
spec built on the mocks in `test/strand-instance-manager-hibernation.spec.ts`
(mock `createLibp2pNode` + `StrandDatabase`, so no real libp2p node starts).
Three assertions, all three failed:

| assertion | actual |
| --- | --- |
| provider called once per strand id across quiesce then resume | called twice (`['s1','s1']`) |
| rebuilt libp2p node gets the same `IRawStorage` object | two distinct `MemoryRawStorage` instances |
| metadata written before quiesce is readable after resume | `undefined` — the block is gone |

The third arm is the data-loss consequence in isolation: `cadre-cli --storage
memory` and `integration-tests/src/harness/node-fixtures.ts:71` both mint a fresh
`MemoryRawStorage` per call, so a hibernated strand wakes empty *inside one
process run*.

The second arm is the performance consequence: `wrapStorageWithCache`
(`quereus-plugin-sereus/src/cached-storage.ts`) memoizes on the **inner**
instance, so a fresh inner instance means a fresh, cold `CachedRawStorage`, and
the previous wrapper is never `dispose()`d — its `CacheStoreHandle` stays in the
process-wide `SharedCachePool.stores` map forever (`unregisterStore` is the only
removal, and only `dispose()` calls it). One orphan registry record per wake, in
processes designed to run for weeks.

Not a coherence bug: pool keys lead with a never-reused store id, and the
released runtime has stopped writing.

## Root cause

Storage resolution is a *step inside runtime construction* rather than a property
of the strand instance. Two call sites have the same shape:

- `strand-instance-manager.ts:282` — `resolveStrandStorage(config.storage?.provider, strandId)`
  inside `buildStrandRuntime`.
- `cadre-node.ts:1040` — `storage.provider('control')` inside `buildControlNodeOptions`.

The control arm is **dormant, not absent**: `buildControlNodeOptions` runs once
per `CadreNode.start()`, and `start()` is guarded only by `_running`, which
`stop()` clears — so a `stop()` then `start()` cycle on one `CadreNode` object
re-enters the provider and orphans the first control cache. Nothing in this repo
restarts a node in-process today (`cadre-cli`, `cadre-host`, `cadre-provider` all
build a node, start it, and exit), so this is latent. Give it the same ownership
rule anyway; leaving one of two identical sites unfixed is what makes the class
come back.

## The shape

**One resolved `IRawStorage` per scope per runtime ownership, released by an
explicit dispose.** Resolution moves *out* of the build step and *into* the
lifecycle that owns it:

```
startStrand(strandId)   -> resolve provider(strandId) once, keep it
  buildStrandRuntime    -> read the kept store           (start AND resume)
  quiesceStrand         -> release node + db, KEEP the store   <- warm wake
  resumeStrand          -> buildStrandRuntime reads the kept store
stopStrand(strandId)    -> releaseRuntime, then dispose + drop the store

CadreNode.start()       -> resolve provider('control') once, keep it
CadreNode.stop()        -> dispose + drop it
```

After this, a rebuild physically cannot mint a second store over one backend, the
cache stays warm across a wake, and the memory-backend data loss disappears with
it — same one change, all three arms.

### Provider contract

`RawStorageProvider` (`cadre-core/src/types.ts:118`) is a callback embedders
write, so the contract belongs in its doc comment. State it as:

> Called **once per scope per runtime lifetime**: `'control'` once per
> `CadreNode.start()`, and each strand id once per `startStrand`. Hibernation
> (`quiesceStrand` then `resumeStrand`) reuses the store already resolved and
> does not re-enter this callback. It **is** re-entered for a scope after that
> scope's runtime has stopped (`stopStrand`, or a `stop()` then `start()`
> cycle), so it must be able to hand back a store over the same durable backend
> a second time. A factory may mint a fresh object per call; it must not *need*
> to.
>
> cadre-core disposes only its own cache wrapper — it never closes the store you
> returned. Closing the underlying handle stays the embedder's job.

That last sentence is verified: `CachedStoreDriver.close()` calls
`inner.close?.()`, and `inner` is `RawStorageDriverAdapter`, which defines no
`close` — the call is a no-op.

### Dispose helper

`CachedRawStorage.dispose()` unregisters the store handle from the pool, and the
handle id is never reused — so a disposed wrapper must never be handed out again.
`wrapStorageWithCache`'s `wraps` WeakMap is keyed by the **inner** instance, so a
stable-instance provider (the web reference app's `strand-storage.ts`, the
integration harness's `captureRawStorage`) would get the *disposed* wrapper back
on a stop then start of the same scope. Disposal therefore has to evict the memo,
which means the helper lives beside the memo, in `cached-storage.ts`:

```ts
/** Reverse of `wraps`, so dispose can evict the memo entry it cannot otherwise find. */
const inners = new WeakMap<CachedRawStorage, IRawStorage>();

/**
 * Release the cache wrapper `wrapStorageWithCache` returned: unregister it from the
 * shared pool and forget the memo, so a later re-wrap of the same inner instance gets
 * a live cache rather than this retired one. No-op for anything this module returned
 * unwrapped (e.g. `MemoryRawStorage`), so callers need no instanceof test.
 */
export async function disposeStorageCache(storage: IRawStorage): Promise<void>;
```

Export it from `quereus-plugin-sereus/src/index.ts` alongside
`wrapStorageWithCache`.

### Where the strand's store is kept

`launchConfigs` and `backfills` are already private maps on
`StrandInstanceManager` keyed by strand id; the resolved store is the same kind of
runtime plumbing, so add a third — not a new public field on `StrandInstance`.
Hold the **wrapped** store (what `buildStrandRuntime` hands to `createLibp2pNode`
and `StrandBackfill`), since that is also what gets disposed.

Keep the existing "an entry exists iff `instances` does" invariant: `startStrand`'s
failure path already deletes `instances` + `launchConfigs`, and must now dispose
and delete the store too.

### Not in scope

- **No new memoization in the shipped providers.** cadre-core owning the instance
  makes it redundant, and a provider-level memo that never releases would pin file
  handles for the process lifetime. `reference-app-ns` keeps its SQLite-connection
  cache — that exists for an independent reason (reopening the file is expensive,
  the `LazyNsRawStorage` proxy over it is not) — but its comment claiming "a
  strand's provider may be invoked more than once over the node lifecycle" is
  about to be wrong; restate it as "once per strand runtime, again after a stop".
- **`composeStrand`** (`quereus-plugin-sereus/src/compose-strand.ts:172`) wraps a
  caller-supplied store on its own standalone path. cadre-core's `StrandDatabase`
  passes no `storage`, so the two never share a wrapper and nothing there can be
  disposed out from under it. Leave it alone.

## TODO

Phase 1 — dispose helper

- Add `disposeStorageCache` to `packages/quereus-plugin-sereus/src/cached-storage.ts`,
  with the `inners` reverse WeakMap so it evicts the `wraps` entry as well as
  calling `dispose()`. Export from that package's `index.ts`.
- Update the module doc comment at the top of `cached-storage.ts`: the long
  paragraph about the memo not spanning a runtime rebuild, and the pointer to
  `tickets/fix/strand-runtime-rebuild-remints-raw-storage.md`, both describe the
  bug this ticket removes. Replace with the ownership rule.

Phase 2 — strand ownership

- In `StrandInstanceManager`, add a private `Map<string, IRawStorage>` for the
  resolved (wrapped) per-strand store, documented like `launchConfigs` and
  `backfills` are.
- Move the `resolveStrandStorage` call from `buildStrandRuntime` into
  `startStrand` (after the schema-signature check, before the build). Populate the
  map; have `buildStrandRuntime` read it instead of calling the provider.
- Drop the stale "the memo does NOT span a runtime rebuild" comment inside
  `resolveStrandStorage`.
- `stopStrand`: after `releaseRuntime`, `disposeStorageCache` the store and delete
  the map entry. Do not let a dispose failure fail the stop — catch and `log` it.
- `startStrand`'s failure path: dispose + delete alongside the existing
  `instances` / `launchConfigs` deletes.
- Confirm `releaseRuntime` (shared by `quiesceStrand` and the build rollback)
  touches the store map not at all — that is what keeps the wake warm.

Phase 3 — control ownership

- In `CadreNode`, resolve `provider('control')` + `wrapStorageWithCache` once per
  `start()` into a field; have `buildControlNodeOptions` read the field, resolving
  lazily if unset so the existing pure-unit-test call path
  (`cadre-node-control-node-options.spec.ts` calls it on a bare `new CadreNode`)
  still works.
- Dispose and clear that field in `stop()` / `cleanup()`, so a `stop()` then
  `start()` cycle re-resolves against a live cache rather than a retired one.

Phase 4 — contract + tests

- Rewrite the `RawStorageProvider` doc comment in `cadre-core/src/types.ts` with
  the once-per-scope-per-runtime contract above (keep the existing per-platform
  examples).
- Fix the now-inaccurate comment in `packages/reference-app-ns/src/ns-storage.ts`
  (see *Not in scope*).
- New `packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts`,
  modelled on `strand-instance-manager-hibernation.spec.ts`'s mocks. The three
  arms below are the verified repro — they fail on current `master` and must pass
  after. Note the module mock replaces `@optimystic/db-p2p` wholesale, so the spec
  imports `MemoryRawStorage` from `@optimystic/db-p2p/rn` (a different specifier,
  unmocked, same class identity).

  ```ts
  it('calls the storage provider once per strand id across quiesce -> resume', async () => {
    const calls: string[] = [];
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('s1', (id) => {
      calls.push(id);
      return new MemoryRawStorage();
    }));
    await manager.quiesceStrand('s1');
    await manager.resumeStrand('s1');
    expect(calls).toEqual(['s1']);
  });

  it('hands the SAME IRawStorage instance to the rebuilt libp2p node', async () => {
    // compare the `storage` field of the first vs. the post-resume
    // `createLibp2pNode` mock call.
  });

  it('a block written before quiesce is still readable after resume', async () => {
    // write via the store the first createLibp2pNode call received, read via the
    // store the post-resume call received; fresh-instance factory throughout.
  });
  ```

  Add a fourth arm: `stopStrand` after `resumeStrand` disposes exactly once —
  assert via `defaultCachePool().stats()` store count returning to its pre-start
  value (exported from `@optimystic/db-p2p/rn`), or by counting `dispose` calls on
  a spy. Prefer the pool-stats form; it is what the leak actually is.

- Extend `packages/cadre-core/test/cadre-node-control-node-options.spec.ts`: two
  `buildControlNodeOptions()` calls on one `CadreNode` invoke the provider once and
  return the identical `storage` object.
- Clear the in-code references to the retired fix ticket — `grep -rn
  "strand-runtime-rebuild-remints-raw-storage" packages/` currently hits
  `cached-storage.ts` and `strand-instance-manager.ts`.

Phase 5 — validation

- `cd packages/quereus-plugin-sereus && yarn build`, then
  `cd packages/cadre-core && yarn typecheck && yarn vitest run 2>&1 | tee /tmp/cadre-core-tests.log`.
  `control-start-storage-op-budget.spec.ts` is the guard that notices a broken or
  unwired cache — it must stay green.
- `packages/integration-tests`: `captureRawStorage`'s doc comment
  (`src/harness/block-store-probe.ts`) explains its per-scope memo as compensation
  for exactly this bug. The memo is still correct (it models a real persistent
  provider); update the paragraph to say the memo now matches cadre-core's
  contract rather than working around its violation.
