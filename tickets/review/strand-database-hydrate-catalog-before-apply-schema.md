description: Review of `StrandDatabase.initialize()` change that hydrates the Quereus catalog from persisted optimystic vtab schemas before `apply schema App;`. Eliminates ~160s warm-restart regression where every persisted table/index was re-CREATEd through the vtab module against persisted storage.
prereq: none
files:
  - packages/cadre-core/src/strand-database.ts
----

## What was built

Single-location change in `packages/cadre-core/src/strand-database.ts`:

1. **Type addition** (`strand-database.ts:23-29`) — extended the local `OptimysticPluginResult` interface with `hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>` so the upstream plugin's already-published hook is callable.
2. **Call site** (`strand-database.ts:161-173`) — between `setDefaultVtabName/Args` and `executeSchema()`, awaits `pluginResult.hydrate(this.db)` and emits a `sereus:cadre:timing` entry: `[strandDb:<sid>] hydrate: <ms>ms (tables=<n>, indexes=<n>)`. Also logs to `sereus:cadre:strand-db` with the counts. Comment block explains the rationale (warm-start diff regression) and points back at this ticket family.

The hydrate function is provided by `@optimystic/quereus-plugin-optimystic` (verified at `C:/projects/optimystic/packages/quereus-plugin-optimystic/src/plugin.ts:70`) which delegates to `optimysticModule.hydrateCatalog(db, config, config)`. It is idempotent and a no-op when storage is empty.

## Why

On warm restart, Quereus's in-memory catalog is empty. `apply schema App;` diffs the declared schema against an empty catalog and emits CREATE TABLE / CREATE INDEX for every object. Each CREATE round-trips through the optimystic vtab module against persisted storage — measured at ~160s `executeSchema` on the reference Android emulator. Hydrating first primes the catalog so the diff is a no-op.

## Validation done

- `yarn build` for `@serfab/cadre-core` — clean exit (no TS errors).
- `yarn test` in `packages/cadre-core` — all 10 test files / 127 tests pass. None exercise persisted-storage warm restart of `StrandDatabase.initialize()`, so the new call surfaces only on the hot path in apps.
- Downstream `@serfab/cadre-core` consumers (`reference-app-rn`, `cadre-cli`, `cadre-provider`, `integration-tests`) all use `workspace:^` / `workspace:*` — the rebuilt `packages/cadre-core/dist` propagates automatically with no version bump. `reference-app-web` does not depend on cadre-core.

## Review focus

- **Interface contract**: confirm the `hydrate` signature here matches the published one in `@optimystic/quereus-plugin-optimystic`. The local `OptimysticPluginResult` is a structural shim — if upstream renames or changes the return shape, this file is where it must be updated.
- **Placement**: the call must remain *after* vtable registration + `setDefaultVtab` (so the optimystic module is wired) and *before* `executeSchema()` (so the diff sees the hydrated catalog). Don't reorder.
- **Error policy**: `hydrate` is awaited unguarded. A failure aborts strand init, which is the right behavior — a half-hydrated catalog would silently corrupt the diff. No try/catch needed.
- **Telemetry**: a single `sereus:cadre:timing` line covers both cold and warm paths. `tables=0, indexes=0` confirms a cold path; non-zero counts confirm warm.

## Key test cases (behavioral, not unit)

1. **First launch (empty storage)** — `hydrate` reports `tables=0, indexes=0`; `executeSchema` does the full CREATE pass; end-to-end `[startStrand:...] total` is unchanged from baseline.
2. **Warm restart (persisted strand)** — `hydrate` reports the actual table/index counts; `executeSchema` drops from ~160s to <2s on the regression device; `apply schema App;` completes cleanly and emits no DDL (the diff is empty).
3. **Re-init in the same process** — `initialized` guard at the top of `initialize()` short-circuits; `hydrate` is not called twice.

## Timing channels to watch on device

```
DEBUG=sereus:cadre:timing,sereus:cadre:strand-db,optimystic:db-core:cache,optimystic:db-p2p:storage-repo
```

Compare the `[strandDb:<sid>] hydrate: <ms>ms (tables=<n>, indexes=<n>)` and `[strandDb:<sid>] executeSchema: <ms>ms` lines across cold and warm launches.

## Open follow-ups (none blocking)

- If a future ticket adds a cadre-core integration test that drives a persisted `StrandDatabase` round-trip, it should assert the `hydrate` log line on the second `initialize()` of the same strand.
