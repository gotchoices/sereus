----
description: When a sleeping workspace wakes back up, the app asks for a brand-new handle to its own data store instead of reusing the one it already had — which throws away the speed-up we just added, and with in-memory storage loses the workspace's data outright.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-cli/src/commands/node-session.ts, packages/quereus-plugin-sereus/src/cached-storage.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/harness/block-store-probe.ts
repro: static
difficulty: medium
----

# A strand runtime rebuild re-mints its raw storage

## What happens

`StrandInstanceManager.buildStrandRuntime` resolves the strand's `IRawStorage` from
scratch every time it runs:

```ts
// strand-instance-manager.ts
const strandStorage = resolveStrandStorage(config.storage?.provider, strandId);
//   → typeof provider === 'function' ? provider(strandId) : provider
```

`buildStrandRuntime` is shared by `startStrand` (first launch) **and** `resumeStrand`
(waking a hibernated strand), so the embedder's `storage.provider` callback is invoked
again on every wake. Hibernation drives that loop in normal operation —
`CadreNode.wakeStrand` → `HibernationManager` → `resumeStrand`.

Most providers mint a fresh object each call:

| provider | shape | stable per scope? |
| --- | --- | --- |
| `cadre-cli` file (`node-session.ts:33`) | `new FileRawStorage(path/strandId)` | no |
| `cadre-cli` memory (`node-session.ts:23`) | `new MemoryRawStorage()` | no |
| `reference-app-rn` (`cadre-phone.ts:75`) | `new LevelDBRawStorage(openLevelDb(...))` | no |
| `reference-app-ns` (`ns-storage.ts:132`) | `new LazyNsRawStorage(...)` (the SQLite connection under it IS cached) | no |
| `reference-app-web` (`strand-storage.ts`) | pre-opened map lookup | yes |
| integration harness `captureRawStorage` | memoized per scope | yes |

`reference-app-ns` reached the same conclusion independently — its comment reads "a strand's
provider may be invoked more than once over the node lifecycle" — and caches the SQLite
connection while still returning a fresh proxy object each call, which is exactly the case the
instance-keyed cache memo cannot see.

The integration harness is the one place that documents the requirement outright:

> MEMOIZED PER SCOPE, deliberately: cadre-core calls the provider again whenever a
> strand runtime is rebuilt (`startStrand` and `resumeStrand` both go through
> `buildStrandRuntime`). A factory that minted a fresh `MemoryRawStorage` each time
> would silently drop the strand's blocks on a resume.

So the contract exists, is known, and is met by the test double but not by the shipped
providers.

## Why it matters now

Two consequences, one cause.

**Data loss on the in-memory backend.** `cadre-cli --storage memory` (and
`integration-tests/src/harness/node-fixtures.ts:71`) hands back an empty
`MemoryRawStorage` on resume, so a hibernated strand wakes with none of its blocks.
Pre-existing, and harmless-looking because memory storage reads as ephemeral — but the
loss happens *within* one process run, which is not what "ephemeral" promises.

**The write-through cache is re-created cold on every wake.** Sereus now wraps
embedder storage in `@optimystic/db-p2p`'s `CachedRawStorage`
(`quereus-plugin-sereus/src/cached-storage.ts`), memoized on the *inner instance*. A
fresh inner instance means a fresh cache, so:

- the resumed strand re-pays the cold fill it did not need to (still far cheaper than
  the uncached ~1979 operations a launch used to cost — this is forfeited upside, not a
  regression against the pre-cache baseline);
- the released runtime's `CachedRawStorage` is never `dispose()`d, so its registration
  stays in the process-wide `SharedCachePool` (`stores` map, removed only by
  `unregisterStore`) and its entries stay resident until 2Q evicts them under budget
  pressure. One small registry record per wake, never reclaimed, in a process
  (cadre-provider, cadre-host, `cadre-cli start`) designed to run for weeks.

Not a coherence bug: pool keys lead with a never-reused store id, and the released
runtime has already stopped writing, so the stale cache cannot serve anyone.

## What "fixed" looks like

The narrow patch — dispose the cache in `releaseRuntime` — treats the symptom and
leaves the data-loss arm and the cold resume in place. The shape that retires the whole
class is to make the re-mint unrepresentable: **a strand instance owns one resolved
`IRawStorage` for its lifetime.** Resolve it once where the instance is created, keep it
on `StrandInstance` beside the retained launch config, and have `buildStrandRuntime`
read it rather than call the provider. Then the provider contract becomes "called once
per strand id per process", a rebuild physically cannot mint a second store over one
backend, the cache stays warm across a wake, and `stopStrand` (not `quiesceStrand`) has
an obvious place to dispose it.

Points to settle while designing:

- Whether the control node has the same shape: `CadreNode.buildControlNodeOptions`
  resolves `storage.provider('control')` too — confirm whether a stop → start cycle in
  one process re-enters it, and give control the same ownership rule if so.
- Whether `RawStorageProvider`'s doc comment (`cadre-core/src/types.ts`) should state
  the once-per-scope contract explicitly, since embedders are writing these callbacks.
- Whether the shipped providers should *also* memoize as defence in depth, or whether
  cadre-core owning the instance makes that redundant.
- A test that fails on the current code: quiesce → resume a strand and assert the
  provider was called once, and/or that a row written before the quiesce is readable
  after the resume with a fresh-instance factory.
