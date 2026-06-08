----
description: REVIEW — burned down all 68 @typescript-eslint/no-explicit-any sites and promoted the rule from warn → error
prereq:
files: eslint.config.mjs, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/browser-shape.spec.ts
----

# Review: kill `no-explicit-any` → error (DONE, verify)

All 68 `@typescript-eslint/no-explicit-any` sites were cleared and the rule promoted to `error`
in `eslint.config.mjs`. `yarn lint` exits 0 (only the 6 svelte reactivity warnings remain — owned by
the downstream `lint-cleanup-svelte` ticket). This is a starting point; treat the per-file approaches
below as the things to scrutinize.

## What landed, by file (the approach the reviewer should check)

**Quereus plugin-registration boundary (the trickiest)** — `compose-strand.ts` (4), `connect-browser.ts`
(coupled), `control-database.ts` (2). The published optimystic/crypto plugin signatures don't surface
the registration item types, so the local shim interfaces (`OptimysticPluginResult`,
`PluginRegistrations`, `CryptoPluginResult`) used `module/schema/func: unknown` and the call sites cast
each to `any`. Fix: the shims now use the **real** Quereus types `VTablePluginInfo` /
`FunctionPluginInfo` / `CollationPluginInfo` (exported from `@quereus/quereus`), so
`applyRegistrations` and `control-database`'s registration loops call
`db.registerModule/registerFunction/registerCollation` **cast-free** with properly typed values —
exactly as `@quereus/quereus`'s own `registerPlugin` helper does.
  - ⚠️ **Flag**: the plugin *construction* sites now use `as unknown as OptimysticPluginResult` /
    `as unknown as CryptoPluginResult` (was a plain `as`). This is required because the plugins'
    inferred return types don't structurally match the tightened interfaces (variance on
    `VirtualTableModule<TTable>` — `OptimysticModule implements VirtualTableModule<OptimysticVirtualTable,…>`).
    The double-cast is unchecked; runtime correctness is proven only by tests, not the compiler.

**`cadre-provider` request typing** — `routes.ts` (7) + `auth.ts` (2). All were
`(request as any).customer`. Fix: a Fastify **module augmentation** in `routes.ts`
(`declare module 'fastify' { interface FastifyRequest { customer?: CustomerIdentity } }`); auth sets
`request.customer`, handlers read it type-safely.
  - ⚠️ **Flag**: the augmentation is global to the cadre-provider compilation. Confirm that's the
    intended pattern vs. a per-route generic, and that no other code path assigns `customer` a
    different shape.

**`cadre-provider/config/loader.ts` (8)** — `deepMerge` was `<T extends Record<string, any>>` with
`(result as any)[key]` writes and `as any` at the three call sites. Fix: added a `DeepPartial<T>` type
(array-safe), `deepMerge<T extends object>(target, source: DeepPartial<T>)`, internal narrowing casts to
`Record<string, unknown>`, and one `return result as T`. The three call sites now pass
`PartialProviderConfig` with no cast. Merge semantics unchanged (tests pass).

**`cadre-core/cadre-node.ts` (2)** — (a) the event map is now
`Map<keyof CadreNodeEvents, Set<EventHandler<never>>>` (was `EventHandler<any>`); `on`/`off` add/remove
cast-free, `emit` does a single `handler as EventHandler<CadreNodeEvents[K]>` cast — the idiomatic
typed-emitter shape. (b) `(controlNode as any).coordinatedRepo as IRepo` → a local
`Libp2pNodeWithRepo` interface (mirrors the existing one in `strand-instance-manager.ts` /
`quereus-plugin-sereus/types.ts` — note this is now a **3rd local copy**; a reviewer may want it
hoisted, out of scope here).

**`cadre-provider/service/docker-orchestrator.ts` (2)** — pure cleanup: dockerode's `NetworkStats`
index type already gives `rx_bytes`/`tx_bytes`, so the `(sum: number, n: any)` annotations and the
trailing `as number` were redundant and removed.

**Test files** — `seed-bootstrap.spec.ts` (31, the long pole), `plugin.spec.ts` (6),
`browser-shape.spec.ts` (4).
  - `seed-bootstrap.spec.ts`: every site was `(service|node as any).<private>` for mock injection /
    private-method calls. Introduced two helpers — `serviceInternals(service)` and
    `cadreNodeInternals(node)` — that cast through `unknown` to small typed-internals interfaces
    (`SeedServiceTestInternals { libp2pNode: unknown; controlDatabase: unknown; queryPeers(): Promise<SeedPeer[]> }`,
    `CadreNodeTestInternals { selfRegistrationTimer: ReturnType<typeof setTimeout> | null }`).
    ⚠️ The injected fields are typed `unknown` (not their production types) **by design** — the mocks are
    deliberately partial, so these assignments stay unchecked; the helper just removes `any` and gives
    `queryPeers()`/the timer a real type.
  - `plugin.spec.ts`: `const rows: any[]` → `Array<Record<string, SqlValue>>` (matches
    `db.eval`'s `AsyncIterableIterator<Record<string, SqlValue>>`); partial mocks `as any` →
    `as unknown as Libp2p` / `as unknown as IRepo`.
  - `browser-shape.spec.ts`: typed the dynamic-import result (`BrowserPluginModule`) and the
    fake-indexeddb global (`IndexedDBLike` — a minimal local interface to avoid depending on DOM lib
    types), dropped `db as any`.

## Validation already run (reproduce these)

- `yarn lint` → **0 errors, 0 `no-explicit-any`**, 6 svelte warnings (exit 0).
- Typecheck (pass): `cadre-core`, `cadre-provider`, `quereus-plugin-sereus`, **and** the downstream
  consumers `cadre-cli`, `cadre-host`, `integration-tests` (run `yarn workspace <name> run typecheck`).
- Tests (pass): `quereus-plugin-sereus` 60 + 1 todo; `cadre-core` 344; `cadre-provider` 80
  (`yarn workspace <name> run test`).

## Reviewer focus / known gaps

- The three `as unknown as <PluginResult>` construction casts and the `serviceInternals`/test casts are
  the only places that remain unchecked. They're justified (boundary + partial mocks) but are where a
  real regression could hide — confirm the runtime shapes still hold (tests cover the happy paths).
- Decide whether the global Fastify `customer` augmentation and the 3rd `Libp2pNodeWithRepo` copy are
  acceptable as-is or worth a small follow-up (cosmetic; not blocking).
- Original ticket line numbers were stale (cadre-node was at 88/228 not ~1123; control-database's 2
  sites were `registerModule`/`registerFunction` casts, not "row typing"). The counts matched (68).
- No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
