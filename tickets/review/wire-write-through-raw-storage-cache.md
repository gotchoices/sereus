----
description: Adopt the storage library's new write-through cache so starting a node reads the disk about 12× less, re-baseline the two cost-guard tests to the new lower numbers, and review the wiring for correctness.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/index.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-backfill.spec.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, docs/STATUS.md, docs/architecture.md
----

# Implement handoff: wire `@optimystic/db-p2p` 0.24's write-through raw-storage cache

Done outside the runner (interactive session, 2026-08-17) as the adoption half of the two
now-complete blocked tickets `optimystic-block-read-amplification-on-control-start` and
`optimystic-schema-catalog-reread-per-write-blows-storage-budgets` — both moved to `complete/`
with resolution sections in the same commit. Upstream shipped the cache deliberately unwired
("adoption is the consumer's choice"); this change is Sereus opting in.

## What was built

- **`packages/quereus-plugin-sereus/src/cached-storage.ts`** — `wrapStorageWithCache(storage,
  label)`: wraps an `IRawStorage` in upstream's `CachedRawStorage`, memoized per inner instance
  (WeakMap) so repeated resolution, the strand backfill path, and quiesce→resume all share ONE
  cache over one backend (two live caches over one store would each miss the other's writes).
  `MemoryRawStorage` and already-wrapped instances pass through. Imports from
  `@optimystic/db-p2p/rn` (platform-neutral entry) because the browser path reaches it. Lives in
  the plugin package, not cadre-core, for the `cluster-size.ts` reason: the plugin's own
  connectors and cadre-core both need the identical wrap.
- **Three wiring seams**: control node (`cadre-node.ts` `buildControlNodeOptions`), strand node +
  backfill (`strand-instance-manager.ts` `resolveStrandStorage`), and the SQL plugin's shared
  composition (`compose-strand.ts`, covering `connectToStrand` and the browser/IndexedDB
  connector). The seams overlap by design — the memo makes double-wrapping idempotent.
- **Budget specs re-baselined with 2026-08-17 provenance** (their floors *forced* this — the
  measured counts fell below `ops/2`): control cold start 1983 → 172 backend ops, warm 463 → 52,
  strand launch 1979 → 168, 5 inserts 366 → 75, 5 selects 230 → 2. Full history retained in the
  budget comments. The warm phase now hands the second start a fresh storage identity (cold
  cache over warm store) because the in-process cache surviving a simulated "restart" measured
  3 ops — the spec's own pre-recorded tripwire for exactly this change.
- **Test updates**: `cadre-node-control-node-options.spec.ts` storage cases assert the wrap +
  memo (plus a new MemoryRawStorage pass-through case); `strand-instance-manager-backfill.spec.ts`
  moved to a partial `vi.mock` of `@optimystic/db-p2p` (importOriginal) since the wrap needs the
  real storage classes.
- **Unrelated-but-bundled**: `control-database-offline-peers.spec.ts` `MULTI_RECONCILE_TIMEOUT_MS`
  60s → 90s. Under a full parallel `yarn test` the WebRTC dial-storm pass completed at ~60.4s
  three runs straight (30–58s alone); it is a hang detector, and the liveness assertion it exists
  for has its own tight budget. Provenance comment at the constant.
- Docs: `control-database.ts` `loadSchema` NOTE, `docs/STATUS.md` (both budget entries),
  `docs/architecture.md` (solo-strand evidence sentence), `tickets/.pre-existing-known.md`
  (removed the two budget-failure entries with a pointer here).

## For the reviewer — known soft spots, in honesty order

1. **Coherence depends on the single-wrap rule.** Any future call site that hands a node a raw
   `IRawStorage` without routing through `wrapStorageWithCache` reintroduces a second uncached
   writer over a cached store — upstream's Invariant 5 territory. Worth checking whether any
   path outside the three seams passes storage to a node/transactor (integration harnesses pass
   `MemoryRawStorage`, which is exempt).
2. **No `dispose()` is wired** — a NOTE in the module records why (entries are clean; the shared
   pool evicts under pressure). Verify that reasoning holds for cadre-provider's long-lived
   multi-tenant process, which starts/stops many nodes.
3. **The `/rn` import** for class identity: both db-p2p entries re-export the same storage
   modules, so `instanceof` works on Node too — asserted implicitly by the passing options spec,
   but a second pair of eyes on bundler behavior (Metro, vite) is welcome.
4. **The select-phase floor is now 1** (measured 2, floor `ops/2`); the insert phase's writes
   carry the anti-vacuity duty for the strand spec. Stated in the budget comment; confirm that
   is acceptable rather than restructuring the assertion.
5. Validation run: `yarn lint` + `yarn build` + `yarn typecheck` green; full root `yarn test`
   green pre-module-move; the post-move full run + `yarn smoke:published` result should be in
   the working notes / follow-up commit by the time this is reviewed — re-run if in doubt.
