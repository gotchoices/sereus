description: Call `pluginResult.hydrate(db)` in `StrandDatabase.initialize()` between `setDefaultVtab` and `executeSchema()` so warm restarts don't re-walk every persisted optimystic table/index through `apply schema App;`. Reported regression: ~160s `executeSchema` on Android emulator warm-start drops to <2s after the fix.
prereq: none
files:
  - packages/cadre-core/src/strand-database.ts
----

## Summary

`StrandDatabase.initialize()` registers the optimystic plugin, registers its vtables/functions, sets the default vtab to `optimystic`, then runs `apply schema App;` via `executeSchema()`. On a warm restart Quereus's in-memory catalog is empty, so the diff emits a full CREATE TABLE / CREATE INDEX pass — each one round-trips through the optimystic vtab module against persisted storage. The optimystic plugin now exposes `pluginResult.hydrate(db)` (idempotent; no-op when storage is empty) that primes the catalog from persisted vtab schemas. The fix is one call between `setDefaultVtab` and `executeSchema()`.

## Code change

Done in this same commit:

- `packages/cadre-core/src/strand-database.ts:23-28` — added `hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>` to the local `OptimysticPluginResult` shape.
- `packages/cadre-core/src/strand-database.ts:160-170` — calls `await pluginResult.hydrate(this.db)` after `setDefaultVtab` and before `executeSchema`, with a `sereus:cadre:timing` entry `[strandDb:<sid>] hydrate: <ms>ms (tables=<n>, indexes=<n>)` so both first-launch and warm-restart paths are diagnosable from one channel.

`tsc -p tsconfig.build.json` in `packages/cadre-core` passes locally.

## Validation expectation

- First launch (empty storage): `hydrate` reports `tables=0, indexes=0` and `executeSchema` does the full CREATE pass. End-to-end `total` time on the reference Android device is unchanged from the current baseline.
- Warm restart (persisted strand): `hydrate` reports the actual table/index counts; `executeSchema` drops from ~160s to <2s on the regression device; `[startStrand:...] total` correspondingly drops into the low seconds. Verified via logcat with `DEBUG=sereus:cadre:timing,sereus:cadre:strand-db,optimystic:db-core:cache,optimystic:db-p2p:storage-repo`.
- `apply schema App;` should still complete cleanly on warm restart — Quereus diffs the wrapped DDL against the hydrated catalog and emits no DDL.

## TODO

- Run `yarn build` for the `@serfab/cadre-core` workspace and confirm clean exit.
- Run the cadre-core test suite (`yarn test` in `packages/cadre-core`) and confirm pass; if any existing test exercises `StrandDatabase.initialize()` against persisted storage, ensure the new `hydrate` call doesn't break it.
- Check whether any downstream package (`apps/mobile`, `apps/reference-app-web`, etc.) needs a re-build or version bump — `@serfab/cadre-core` is `workspace:^` so a local build should propagate, but verify the mobile app picks up the change.
- Produce the review-stage ticket summarizing the change, key test cases (warm vs first launch), and the timing channels to watch.
