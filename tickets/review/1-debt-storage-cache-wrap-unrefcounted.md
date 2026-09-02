----
description: The shared read cache that sits in front of a data store now counts how many parts of the app are using it, so one part shutting down no longer throws away a cache the others are still reading through.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/cached-storage.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-backfill.spec.ts, docs/architecture.md
difficulty: medium
----

# Holder count on the storage cache wrapper

## What the code does now

`packages/quereus-plugin-sereus/src/cached-storage.ts` exposes one pair of functions
that every part of Sereus uses to put a read cache in front of an embedder-supplied
data store:

- `wrapStorageWithCache(storage, label)` — returns the cached view.
- `disposeStorageCache(storage)` — releases it.

**They are now a matched pair with a count between them.** Every `wrapStorageWithCache`
call that hands back a cache this module created takes one *holder claim* on that cache;
every `disposeStorageCache` of that cache releases one. The cache is emptied, unregistered
from the process-wide cache pool, and dropped from the wrap memo **only when the last
claim goes**.

Three rules fall out, and they are what the tests pin:

- Wrapping the same store twice is still the *same* cache object (unchanged), but the
  second wrap is now recorded as a second holder.
- A holder releasing while others remain retires nothing — the still-running scopes keep
  reading through a live cache, and a scope starting afterwards joins that same cache
  rather than building a second one over the same backend.
- Releasing something that has no live claim — a cache the embedder built itself, or a
  late second release of an already-retired wrapper — is a no-op. The count cannot go
  negative and a live successor is never consumed.

`MemoryRawStorage` still passes through unwrapped and `disposeStorageCache` still no-ops
on it, so no call site needs an `instanceof` test.

### Bookkeeping shape

`cached-storage.ts` holds two weak maps:

- `wraps: WeakMap<IRawStorage, CachedRawStorage>` — the memo, keyed by the inner store
  (unchanged).
- `claims: WeakMap<CachedRawStorage, { inner, holders }>` — the count, keyed by the
  wrapper, plus the reverse pointer dispose needs to find the memo entry.

Presence in `claims` is also how the module answers "is this cache mine to retire?".
A cache built outside this module never enters it, so it takes no claim and is never
disposed here. The decrement and the retire both happen in `disposeStorageCache`'s
**synchronous prefix**, before the `await storage.dispose()` — a wrap interleaved between
the two would otherwise find a memo entry pointing at a dying cache.

### `composeStrand` (the ticket's second arm)

`packages/quereus-plugin-sereus/src/compose-strand.ts` previously guessed at ownership:
`ownedStorageCache` treated "the wrap returned a different object than I handed in" as
"I created this", which cannot distinguish "I created it" from "the memo handed me one
cadre-core created". That guard and its comment are **gone**. `shutdown()` (and the
failed-setup rollback) now release this composition's own claim unconditionally, latched
so a caller that calls `shutdown()` twice releases once rather than consuming another
scope's claim.

No other call site changed behaviourally — `CadreNode.cleanup` and
`StrandInstanceManager.disposeStrandStorage` already called the pair correctly for their
own scope; their comments were corrected to say "releases its claim" rather than
"retires the registration".

### Docs relaxed

`docs/architecture.md`'s storage section and the `RawStorageProvider` doc comment in
`packages/cadre-core/src/types.ts` no longer steer embedders away from the shared-instance
provider form. Both now say either form is safe and why; the factory form is still
recommended, but on its real merit (per-strand data partitioning), not because of this
defect. Architecture also states the obligation the count creates: **call the pair in
balance, one dispose per wrap.**

## How to validate

Both commands were run and pass at the time of handoff:

```
yarn workspace @serfab/quereus-plugin-sereus test    # 9 files, 98 passed | 1 todo
yarn workspace @serfab/cadre-core test               # 104 files, 1665 passed | 1 skipped
yarn lint                                            # exit 0
yarn workspace @serfab/quereus-plugin-sereus typecheck   # exit 0
yarn workspace @serfab/cadre-core typecheck              # exit 0
```

`cadre-core` resolves `@serfab/quereus-plugin-sereus` through its `dist`, so
`yarn workspace @serfab/quereus-plugin-sereus build` must run before the cadre-core suite
picks up a change to `cached-storage.ts`.

### The cases that carry the fix

New in `packages/quereus-plugin-sereus/test/cached-storage.spec.ts`, describe block
`wrapStorageWithCache / disposeStorageCache holder count`:

- **Several scopes over one instance, one releases** — cache stays registered
  (`defaultCachePool().stats().stores.length` unchanged), and a wrap afterwards returns
  the *same* object, not a rival cache.
- **Last holder releases** — registration retired; a later wrap yields a fresh, live,
  distinct wrapper that registers again.
- **Over-release, both orders** — surplus releases before a successor exists, and
  surplus releases while a successor is live. Neither retires a live cache nor resurrects
  a retired one.
- **Re-wrap of the wrapper itself** — the `composeStrand` shape: cadre-core wraps and
  passes the wrapper down; the re-wrapper's release must be its own claim, not
  cadre-core's.
- **Embedder-built cache** — `new CachedRawStorage(...)` handed to the pair is returned
  unchanged and never disposed here.

New in `packages/quereus-plugin-sereus/test/plugin.spec.ts`:

- **Pool flat over repeated connect/shutdown cycles** — three `connectToStrand` →
  `shutdown()` cycles over one backing store leave the shared pool's store count exactly
  where it started, with `+1` between connect and shutdown. This is the leak the second
  arm was about.
- **Does not retire a cache another scope wrapped and still holds** — the regression the
  guard removal risks: wrap a store as cadre-core would, connect a strand over that
  wrapper, shut the strand down, assert the cache is still registered, then release the
  outer claim and see it retire.

The pre-existing regression test the 0.26 upgrade added — `releases the storage cache it
wrapped, so a relaunch over the same backing store connects` — still passes unchanged.

### Manual / usage check worth doing

Nothing in-tree walks the shared-instance provider path (every shipped provider hands out
a distinct store per scope), so the fix is proven at the helper and at `composeStrand`,
**not** through a live `CadreNode` with one `IRawStorage` shared by the control database
and two workspaces. If a reviewer wants that end-to-end proof: build a `CadreNode` with
`storage: { provider: someSingleNonMemoryInstance }`, start control plus two strands, stop
one strand, and confirm the control database still reads its own writes and the pool still
reports one store for that backend.

## Known gaps and judgement calls the reviewer should weigh

- **Behaviour change, deliberate:** `disposeStorageCache` handed a `CachedRawStorage` this
  module never created is now a **no-op**; before, it disposed it. Nothing in-tree does
  that (`composeStrand`'s old guard already skipped it, and cadre-core only disposes what
  it wrapped), and closing a host's own cache out from under it is the mirror of the
  defect being fixed. Pinned by the `embedder-built cache` test.
- **A retired wrapper handed back to `wrapStorageWithCache` is still returned as-is**, now
  with no claim, so a caller in that position gets a dead cache silently rather than an
  error. This is unchanged from before the ticket and out of its scope; no in-tree path
  reaches it, since both retire sites drop their reference in the same block.
- **The pair must be called in balance.** That obligation is new: two cadre-core specs
  assert identity *through* the helper (`expect(options.storage).toBe(wrapStorageWithCache(instance, 'control'))`),
  which now takes an extra claim they never release. Harmless where they sit — noted with
  a `NOTE:` at both sites — but a test that asserts that way *and* measures pool occupancy
  after a teardown would read one registration too many.
- **Upstream already ships an equivalent**, `withReadCache` in `@optimystic/db-p2p`: a
  lease-based count that *additionally* dedupes by `getStoreIdentity()`, so two distinct
  `FileRawStorage` over one directory share one cache. It was not adopted. Reason recorded
  as a `NOTE:` in `cached-storage.ts`: this module's public surface releases by *wrapper*,
  not by lease, and `withReadCache` returns no lease on its already-cached pass-through —
  which would leave `composeStrand`'s unconditional release unable to tell its own claim
  from cadre-core's. Adopting it means changing the surface at all three call sites, and
  buys the identity-keyed dedupe. Reasonable follow-up; deliberately not done here.
- **Concurrency argument is by inspection, not measurement.** The claim that the
  decrement-and-retire is safe rests on it being synchronous ahead of the first `await`,
  mirroring the same argument upstream makes in `CachedStoreDriver.close()`. No test
  interleaves a wrap into a dispose.

## Pre-existing failures (not from this change)

`packages/integration-tests` carries two deterministic failures in
`src/scenarios/strand-membership-closed-strand-e2e.integration.ts` — "replicates the
founder's blocks PHYSICALLY into the joiner's own block store" and "serves the strand's
founding membership from the joiner alone after the founder stops". Both are recorded in
`tickets/.pre-existing-known.md` (delta 2026-09-01) against the in-flight
`strand-catch-up-refused-until-solo-writes-carry-proof` ticket. That suite was not run in
this ticket; nothing here touches the catch-up path.
