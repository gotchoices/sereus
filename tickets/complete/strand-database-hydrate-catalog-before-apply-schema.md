description: Hydrate Quereus catalog from persisted optimystic vtab schemas before `apply schema App;` in `StrandDatabase.initialize()`. Eliminates ~160s warm-restart regression where every persisted table/index was re-CREATEd through the optimystic vtab module against persisted storage.
files:
  - packages/cadre-core/src/strand-database.ts
----

## Summary

Single-location change in `packages/cadre-core/src/strand-database.ts`:

- **Type addition** (`strand-database.ts:23-29`) — local `OptimysticPluginResult` shim extended with `hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>`, matching the upstream signature published at `@optimystic/quereus-plugin-optimystic/src/plugin.ts:70`.
- **Call site** (`strand-database.ts:161-173`) — between `setDefaultVtabName/Args` and `executeSchema()`, awaits `pluginResult.hydrate(this.db)` and emits a `sereus:cadre:timing` entry of the form `[strandDb:<sid>] hydrate: <ms>ms (tables=<n>, indexes=<n>)`. Counts are also logged to `sereus:cadre:strand-db`.

The hydrate implementation lives upstream in `@optimystic/quereus-plugin-optimystic` and delegates to `optimysticModule.hydrateCatalog(db, config, config)` (`optimystic-module.ts:907`). It is idempotent — tables already present in the target schema are skipped, and a cold-start (no persisted schema tree) returns `{ tables: 0, indexes: 0 }`.

## Why

On warm restart Quereus's in-memory catalog is empty. `apply schema App;` diffs the declared schema against an empty catalog and emits CREATE TABLE / CREATE INDEX for every persisted object. Each CREATE round-trips through the optimystic vtab module against persisted storage — measured at ~160s `executeSchema` on the reference Android emulator. Hydrating first primes the catalog so the diff is a no-op.

## Key files

- `packages/cadre-core/src/strand-database.ts:23-29` — local `OptimysticPluginResult` shim
- `packages/cadre-core/src/strand-database.ts:161-173` — hydrate call + timing
- `../optimystic/packages/quereus-plugin-optimystic/src/plugin.ts:70` — upstream hook
- `../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:907` — `hydrateCatalog` implementation

## Validation

- `tsc -p tsconfig.build.json` clean (exit 0); dist artifacts produced.
- `yarn test` in `packages/cadre-core` — all 10 test files / 127 tests pass in ~5s.
- Downstream consumers (`reference-app-rn`, `cadre-cli`, `cadre-provider`, `integration-tests`) use workspace ranges; the rebuilt `dist` propagates with no version bump. `reference-app-web` does not depend on cadre-core.

No cadre-core unit test exercises persisted-storage warm restart through `StrandDatabase.initialize()`, so the new call surfaces only on the hot path in apps.

## Testing notes (behavioral, on device)

Recommended channels: `DEBUG=sereus:cadre:timing,sereus:cadre:strand-db,optimystic:db-core:cache,optimystic:db-p2p:storage-repo`

1. **First launch (empty storage)** — `[strandDb:<sid>] hydrate: <ms>ms (tables=0, indexes=0)`; full CREATE pass in `executeSchema`.
2. **Warm restart (persisted strand)** — `hydrate` reports actual table/index counts; `executeSchema` drops from ~160s to <2s; `apply schema App;` emits no DDL (diff is empty).
3. **Re-init in the same process** — top-level `initialized` guard short-circuits; `hydrate` is not called twice.

## Follow-ups

- A future cadre-core integration test driving a persisted `StrandDatabase` round-trip should assert the `hydrate` log line on the second `initialize()` of the same strand.
