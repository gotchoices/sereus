---
description: A running workspace now keeps one handle to its own data store instead of asking for a fresh one every time it wakes from sleep, so waking is fast again and an in-memory workspace no longer loses its data.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/cached-storage.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-instance-manager-storage-ownership.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/reference-app-ns/src/ns-storage.ts, packages/integration-tests/src/harness/block-store-probe.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
---

# A strand instance owns one resolved raw storage for its lifetime

## What shipped

Storage resolution moved out of *runtime construction* and into the *lifecycle that owns
the runtime*. `StrandInstanceManager` resolves a strand's `IRawStorage` once in
`startStrand` and holds it in a `strandStorages` map until `stopStrand`;
`buildStrandRuntime` only reads it, so a hibernation quiesce → resume rebuilds the libp2p
node over the same store. `CadreNode` resolves `provider('control')` once per `start()`
into a `controlStorage` field and releases it in `cleanup()`. Both release through a new
`disposeStorageCache` helper in `packages/quereus-plugin-sereus/src/cached-storage.ts`,
which unregisters the wrapper from the process-wide cache pool and evicts the
instance-keyed memo so a later re-wrap gets a live cache rather than the retired one.

That closed three symptoms which were all one bug — `buildStrandRuntime` calling the
embedder's storage provider itself, on both `startStrand` and `resumeStrand`:

| symptom | before | after |
| --- | --- | --- |
| provider calls per strand across quiesce → resume | 2 | 1 |
| store handed to the rebuilt libp2p node | a different instance | the same instance |
| block written before quiesce, read after resume | gone (in-memory backends) | present |

…plus the release half: every wake used to register a second `CacheStoreHandle` in the
shared pool and never remove the first.

The `RawStorageProvider` contract in `packages/cadre-core/src/types.ts` now states the
rule embedders need: called once per scope per runtime lifetime; hibernation does not
re-enter it; a stop does, so a provider must be able to hand back a store over the same
durable backend a second time; cadre-core disposes only its own wrapper and never closes
the embedder's handle.

## Review findings

### Verified, not merely taken from the handoff

The handoff asserted *"[dispose] never closes the embedder's own handle."* That claim is
load-bearing — an embedder reads it and decides not to guard its own handle — and it was
unverified. Traced it through upstream: `CachedRawStorage.dispose()` →
`CachedStoreDriver.close()`, which does `clear()`, `pool.unregisterStore(store)`, **and
`await this.inner.close?.()`**. The inner is a `RawStorageDriverAdapter`, which declares
no `close` (only `listBlockIds` / `approximateBytesUsed` are conditionally wired), so the
optional call is a no-op and the claim holds. Also confirmed the cache is genuinely
write-through — `clearCache`'s own doc states it, so dispose drops no unflushed writes and
a stop cannot lose data.

Traced every mutation site of the new `strandStorages` map against the maps it parallels
(`instances`, `launchConfigs`, `backfills`) and every lifecycle path that touches storage:
`startStrand` (including the `instances.has` early return, which is safe because nothing
awaits between the check and the set), the failed-launch rollback, `buildStrandRuntime`'s
own rollback, `quiesceStrand`, `resumeStrand`, `stopStrand`, `stopAll`, and
`CadreNode.cleanup()`'s ordering. Also audited every `storage.provider` wiring in the repo
(cadre-cli file + memory, reference-app-rn LevelDB, reference-app-ns SQLite,
reference-app-web, the integration harness's `captureRawStorage`, and the integration
scenarios' inline providers).

### Major — filed

**`backlog/debt-storage-cache-wrap-unrefcounted`** — the wrap and the release are not a
matched pair. `wrapStorageWithCache` memoizes per inner instance (deliberately, so
overlapping seams cannot stack two caches over one backend), but `disposeStorageCache` is
unconditional and has no idea how many scopes still hold the wrapper it retires.
`CadreNodeConfig.storage.provider` accepts a single `IRawStorage` shared by every scope,
and `docs/architecture.md` documents that form as supported. With it: control + workspace
A + workspace B all get the *same* wrapper; A stopping empties that wrapper's cache,
unregisters it from the pool, and drops the memo entry while control and B are still
reading through it; the next workspace to start then builds a **second live cache over the
same backend**, which is exactly the invariant the memo exists to protect. Writes still go
through (write-through), but each cache holds its own read state including remembered
"block absent" answers, so a block one scope writes can read as still-absent to another.

`repro: verified` — ran the five steps directly against `cached-storage.ts`; every
assertion held (one wrapper handed to three scopes; a different, live wrapper handed to the
fourth after the third scope's dispose).

Dormant in-tree: every shipped provider hands out either a distinct store per scope or an
in-memory store, and in-memory stores are never wrapped — so the one place that does share
one instance across scopes (`control-delete-while-alone-convergence.integration.ts`) is
harmless. Filed as `debt-` per the dormant-latent-defect rule, not as a tripwire: it is not
conditional on anything changing, only on a documented config being used.

Filed at the representation rung rather than as a point fix, per *Architecture first*: an
owner count between wrap and release makes the bad state unrepresentable and requires no
caller changes. That also closes a **second arm at the same site** — `compose-strand.ts`
wraps a store per `connectStrand` and its `shutdown()` never releases it, the same
orphan-per-call leak this ticket closed on the cadre-core side. That arm cannot be closed
safely today (disposing there could retire a wrapper another scope holds), which is why
the two are one ticket.

Site-claim grep over all open ticket folders first: `bug-strand-join-dies-on-missing-block`
and `debt-plugin-strand-node-omits-cluster-policy` both name `compose-strand.ts`, but
neither claims the wrap/dispose pair — filed fresh. No accepted-tradeoff `NOTE:` exists at
either site.

### Minor — fixed in this pass

- **The control arm's missing lifecycle test**, which the handoff named as its own weakest
  coverage and the natural place for a reviewer to push. Added two tests to
  `cadre-node-control-node-options.spec.ts` via a `nodeCleanup` private-cast helper
  matching the file's existing `controlOptions` pattern: `cleanup()` retires the pool
  registration it created, and a post-`cleanup()` rebuild re-resolves the provider and gets
  a **live** wrapper (`not.toBe(first)`, `instanceOf CachedRawStorage`) even when the
  provider returns a stable inner instance — the case the memo cannot help with and where
  a missing memo eviction would hand back the disposed wrapper. Mutation-checked by
  disabling the dispose block in `cleanup()`: **both tests fail**, on the pool count and on
  the provider call count respectively. Source restored to HEAD byte-for-byte afterwards.
- **Docs steered readers at the hazardous config.** `docs/architecture.md` offered the
  shared-instance form neutrally; the `RawStorageProvider` doc comment in
  `packages/cadre-core/src/types.ts` did not mention it at all. Both now say to prefer the
  per-scope factory for any persistent backend, state why in one sentence, and point at the
  refcount ticket. The architecture doc's "the memo prevents two caches over one store"
  sentence was also true only before a release existed — qualified accordingly.
- **Stale pointer in an archived ticket.** `complete/wire-write-through-raw-storage-cache.md`
  still listed `fix/strand-runtime-rebuild-remints-raw-storage` as filed-and-open; it now
  names this ticket as where it landed. (The handoff's grep for that slug was scoped to
  `packages/*/src`, `packages/*/test`, and `docs`, so it never looked at `tickets/`.)

### Tripwires parked (not tickets)

- **Pool-count assertions assume sequential execution within a file.** The handoff listed
  this as a known gap but never recorded it anywhere a future reader would meet it. Now a
  `NOTE:` at both sites — the file header of
  `strand-instance-manager-storage-ownership.spec.ts` and the first pool-count arm in
  `cadre-node-control-node-options.spec.ts` — stating the condition (marking the file
  `concurrent`) and the remedy (give each arm its own `SharedCachePool`).
- The existing `NOTE:` on `strandStorages` (a hibernating strand keeps its store resident;
  revisit if a device hibernates strands by the hundred) was left as-is — correct rung,
  correct site, and its revisit condition has not tripped.

### Considered and deliberately not filed

- **The four hand-synced per-strand maps** (`instances`, `launchConfigs`, `backfills`,
  `strandStorages`) the handoff offered as an architectural hardening. Checked every
  mutation site including the ugly one — `stopStrand` where `releaseRuntime` throws, which
  retains all four together and so keeps the pairing invariant rather than breaking it.
  There is no reachable desync. That makes it a refactor with no defect behind it; filing
  speculative refactors is what the *Architecture first* ladder exists to avoid, so it is
  recorded here rather than queued.
- **`cadre-node.ts` size** (5158 lines, `wc -l`; this change added ~40). Already claimed by
  `backlog/debt-cadre-node-single-file-size` — evidence, not a new ticket, and too small an
  increment to be worth appending as an arm.
- **`{} as IRawStorage` fakes in the new spec.** Confirmed the handoff's reasoning holds:
  the mocked libp2p node exposes no `keyNetwork`, so `StrandBackfill` stays inert and no
  method is ever called on the bare object. It becomes a real problem only if the mock
  grows one — a code change, not a latent defect.
- **`resolveControlStorage` is lazy, not eager in `start()`.** Deliberate, so the pure-unit
  path works; the "builds options, never starts, nothing disposes" case is reachable only
  from that unit test, which now calls `nodeCleanup` in the arm that would otherwise leave
  a registration behind.

### Validation

All under the project's real per-workspace commands. (Note for anyone repeating this:
`yarn vitest run` at the repo root is **not** an entrypoint — it bypasses each workspace's
vitest config and sweeps in playwright specs and excluded e2e suites. The root `test`
script fans out per workspace.)

```
packages/quereus-plugin-sereus:  yarn build            ok
                                 yarn test             9 files, 89 pass, 1 todo
packages/cadre-core:             yarn typecheck        clean
                                 yarn test             101 files, 1563 pass, 1 skipped
                                 yarn build            ok
repo root:                       yarn lint             clean (exit 0)
```

`control-start-storage-op-budget.spec.ts` — the guard that notices a broken or unwired
cache — is inside the cadre-core suite and stayed green. Test count moved 1561 → 1563: the
two control-arm tests added above. No pre-existing failures surfaced, so nothing was
written to `tickets/.pre-existing-error.md`. (The handoff reported 85 passing in
quereus-plugin-sereus against a measured 89 + 1 todo — a stale number, not a behaviour
change; nothing in this ticket touched that count.)

### Not covered — deferred deliberately

- **`packages/integration-tests` was not run.** Real-network, out of the agent-runnable
  wall-clock budget, and the change there is a doc comment on `captureRawStorage` only.
  Read the comment; it now describes the contract accurately rather than compensating for a
  violation of it.
- **`packages/reference-app-ns` was not built or tested.** Comment-only change; read and
  confirmed accurate against the new contract.
- **No end-to-end run of the user-visible arm.** `cadre-cli --storage memory` → start a
  strand, hibernate, wake, confirm pre-hibernation rows are still selectable. Covered by
  the unit spec at the seam that broke, never by a real process.
- `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` fails when swept in by a
  root-level vitest run; that is already tracked by
  `backlog/bug-strand-join-dies-on-missing-block` and is excluded from the package's own
  `yarn test`. Not re-reported.
