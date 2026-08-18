---
description: A running workspace now keeps one handle to its own data store instead of asking for a fresh one every time it wakes from sleep, so waking is fast again and an in-memory workspace no longer loses its data.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/cached-storage.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/reference-app-ns/src/ns-storage.ts, packages/integration-tests/src/harness/block-store-probe.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
---

# Review: a strand instance owns one resolved raw storage for its lifetime

## What changed, in one sentence

Storage resolution moved out of *runtime construction* and into the *lifecycle that
owns the runtime*: `StrandInstanceManager` resolves a strand's `IRawStorage` once in
`startStrand` and holds it until `stopStrand`; `CadreNode` resolves `provider('control')`
once per `start()` and holds it until `cleanup()`. Both release their cache wrapper
through a new `disposeStorageCache` helper.

## The three defects this closes

All three were one bug — `buildStrandRuntime` called the embedder's storage provider
itself, and it runs on **both** `startStrand` and `resumeStrand`:

| symptom | before | after |
| --- | --- | --- |
| provider calls per strand across quiesce → resume | 2 | 1 |
| store handed to the rebuilt libp2p node | a different instance | the same instance |
| block written before quiesce, read after resume | gone (in-memory backends) | present |

Plus the release half: every wake used to register a second `CacheStoreHandle` in the
process-wide `SharedCachePool` and never remove the first — one orphan per wake, in
processes designed to run for weeks.

## Interfaces added

`packages/quereus-plugin-sereus/src/cached-storage.ts`, exported from that package's
`index.ts`:

```ts
export async function disposeStorageCache(storage: IRawStorage): Promise<void>;
```

Unregisters the wrapper from the shared cache pool AND evicts the `wraps` memo entry,
so a later re-wrap of the same inner instance gets a live cache rather than the retired
one. No-op for anything `wrapStorageWithCache` returned unwrapped (`MemoryRawStorage`),
so callers need no `instanceof` test. It never closes the embedder's own handle.

The contract embedders must read is now on `RawStorageProvider`
(`packages/cadre-core/src/types.ts`): **called once per scope per runtime lifetime**;
hibernation does not re-enter it; a stop *does*, so a provider must be able to hand
back a store over the same durable backend a second time (it need not memoize to do
so); cadre-core disposes only its own wrapper.

## How to validate

Commands run, all green (2026-08-18):

```
cd packages/quereus-plugin-sereus && yarn build && yarn test    # 9 files, 85 pass (+ the 4 new dispose tests)
cd packages/cadre-core && yarn typecheck                        # clean
cd packages/cadre-core && yarn vitest run                       # 101 files, 1561 pass, 1 skipped (pre-existing)
cd packages/cadre-core && yarn build                            # dist refreshed for downstream freshness guards
yarn lint                                                       # clean, repo-wide
```

`control-start-storage-op-budget.spec.ts` — the guard that notices a broken or unwired
cache — is inside that suite and stayed green.

### The new spec, and proof it is not vacuous

`packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts` (6 tests,
mocks modelled on `strand-instance-manager-hibernation.spec.ts` so no real libp2p node
or Quereus database starts). Re-running it against the pre-fix line
(`buildStrandRuntime` re-resolving instead of reading the map) fails **5 of 6** —
the provider-call-count, same-instance, block-survives, pool-registration, and
failed-launch arms. The sixth (a strand with no storage provider at all) passes either
way by design.

The pool-leak arms use `defaultCachePool().stats().stores.length` measured *relative*
to a pre-start baseline, since the pool is process-wide.

### Manual/behavioural checks a reviewer may want

- `cadre-cli --storage memory`: start a strand, let it hibernate, wake it, and confirm
  rows written before hibernation are still selectable. That was the user-visible
  data-loss arm; it is covered by the unit spec but never by a real end-to-end run.
- A long-running `cadre-host`: hibernate/wake a strand repeatedly and watch
  `defaultCachePool().stats().stores.length` stay flat.

## Known gaps — treat these as the floor, not the finish line

- **The control arm has no lifecycle test.** Two `buildControlNodeOptions()` calls on
  one `CadreNode` are asserted to resolve the provider once and return the identical
  store (`cadre-node-control-node-options.spec.ts`), but **nothing asserts that
  `cleanup()` disposes the field, nor that a `stop()` then `start()` cycle re-resolves
  against a live cache.** That path is dormant in this repo (`cadre-cli`, `cadre-host`,
  `cadre-provider` all build a node, start it, and exit), which is why the ticket
  called it latent — but it is the arm with the weakest coverage, and the natural place
  for a reviewer to push.
- **`resolveControlStorage` is lazy, not eager in `start()`.** That is deliberate (the
  pure-unit spec calls `buildControlNodeOptions` on a bare `new CadreNode`), but it
  means a caller who builds options and never starts resolves a store nothing will
  dispose. Only the unit test does that today.
- **The `strandStorages` "entry exists iff `instances` does" invariant is hand-held
  across three sites** — the success path, the failed-launch rollback, and `stopStrand`.
  No assertion or type enforces the pairing. If a reviewer wants an architectural
  hardening, that is the rung: one record per strand holding config + storage + backfill
  rather than three parallel maps.
- **The pool-count assertions assume tests within the file run sequentially** (vitest's
  default). If this file is ever made concurrent, those counts race.
- **The `{} as IRawStorage` fakes never have a method called on them.** That holds only
  because the mocked libp2p node exposes no `keyNetwork`, so `StrandBackfill` stays
  inert. A mock that grows one would start calling into the bare object.
- **`packages/integration-tests` was not run** — the change there is a doc comment on
  `captureRawStorage` only (its per-scope memo now *matches* the stated contract instead
  of compensating for a violation of it). The suite is real-network and out of budget
  for this ticket.
- **`packages/reference-app-ns` change is a comment only** — not built, not tested.

## Tripwire parked

- `strand-instance-manager.ts`, on the `strandStorages` field: a hibernating strand now
  keeps its store (and its share of the shared cache pool) resident for as long as the
  instance is tracked. That is the point — it buys the warm wake — and the pool evicts
  under pressure, so today the cost is one map entry per hibernating strand. `NOTE:`
  records the revisit condition: a device hibernating strands *by the hundred* should
  drop the store at quiesce and pay for a cold wake instead.

## Docs updated alongside

- `docs/architecture.md` (storage section): the "a provider should return the same
  instance" advice was wrong-headed — replaced with the once-per-scope-per-runtime
  ownership rule and the dispose obligation.
- `docs/STATUS.md`: the cache entry pointed at the now-retired
  `fix/strand-runtime-rebuild-remints-raw-storage`; it now points at the new spec.
- Every in-code reference to that retired ticket slug is gone
  (`grep -rn "strand-runtime-rebuild-remints-raw-storage" packages/*/src packages/*/test docs`
  returns nothing).
