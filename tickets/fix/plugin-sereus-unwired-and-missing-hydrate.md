----
description: quereus-plugin-sereus is an unwired parallel SQL-surface implementation that duplicates cadre-core's composition and omits the hydrate warm-restart fix.
files: packages/quereus-plugin-sereus/src/connect.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/cadre-core/src/strand-database.ts
----
## Problem

The stated runtime architecture holds that `@serfab/quereus-plugin-sereus` is the SQL surface used by the cadre runtimes. In reality no runtime or app consumes it: a repo-wide search for `connectToStrand` / `quereus-plugin-sereus` (excluding the plugin package itself) returns no importers. Instead, `cadre-core`'s `StrandDatabase` reimplements the entire composition independently — crypto + optimystic plugin registration, `registerLibp2pNode`, `setDefaultVtab`/`setDefaultVtabArgs` with the same shape, and the identical `declare schema App {...} apply schema App;` wrapper. The plugin and the runtime are two parallel implementations of the same surface (`packages/cadre-core/src/strand-database.ts` vs `packages/quereus-plugin-sereus/src/connect.ts`). This is a DRY violation and a standing divergence risk: any change to one surface silently fails to reach the other.

## Concrete divergence: the hydrate warm-restart fix

`cadre-core` deliberately calls `pluginResult.hydrate(this.db)` before `apply schema App;`, so that on a warm restart the schema diff runs against a populated catalog instead of an empty one (`packages/cadre-core/src/strand-database.ts:161-177`). Without this, `apply schema App;` re-emits CREATE TABLE / CREATE INDEX for every persisted object, each round-tripping through the optimystic vtab module against persisted storage — a measured ~160s `executeSchema` regression on the reference Android emulator. This fix was completed for cadre-core (see completed ticket `strand-database-hydrate-catalog-before-apply-schema`).

The plugin never received that fix. `hydrate` appears nowhere in the `quereus-plugin-sereus` package. `connect.ts` applies the wrapped schema with no prior hydration (`packages/quereus-plugin-sereus/src/connect.ts:151-161`), and `connect-browser.ts` follows the same path. As a result, any reconnection of `connectToStrand({ storage })` against a non-trivial persisted schema re-applies full DDL and degrades the same way the cadre-core path did before its fix. The bootstrap-persistence e2e does not catch this because it exercises only a single one-column table, for which a full re-apply is cheap.

## Secondary defects in the plugin surface

- The plugin loader's `parseConfig` drops `mode` / `storage` / `transactor` from the incoming config (`packages/quereus-plugin-sereus/src/parse-config.ts:8-36`). Consequently the Quoomb / `.plugin` Node entry point can never select bootstrap mode or persistent storage — those options are silently discarded before they reach `connectToStrand`.
- The plugin SQL surface applies only the `sApp` DDL, with no membership / RBAC schema. This overlaps the separately-tracked concern captured under slug `strand-membership-rbac-schema-not-applied` (related, not a duplicate of this ticket).

## Expected behavior

Consolidate on a single SQL-surface composition rather than two parallel ones — either `cadre-core` consumes `quereus-plugin-sereus`, or the plugin becomes the shared implementation that `cadre-core` delegates to. Whichever direction is chosen, the shared path must perform catalog hydration before `apply schema App;`, so that warm restarts and browser reloads do not re-emit full DDL. The consolidated path must also carry `mode` / `storage` / `transactor` through the plugin-loader config so the Node `.plugin` entry can use bootstrap mode and persistent storage, and should apply the same DDL set (including membership/RBAC) that the runtime expects.

## Key references

- `packages/cadre-core/src/strand-database.ts:161-177` — the hydrate-before-apply-schema fix the plugin lacks.
- `packages/quereus-plugin-sereus/src/connect.ts:151-161` — plugin applies schema with no prior hydrate.
- `packages/quereus-plugin-sereus/src/connect-browser.ts` — browser path, same omission.
- `packages/quereus-plugin-sereus/src/parse-config.ts:8-36` — `parseConfig` drops `mode`/`storage`/`transactor`.
- Completed ticket: `tickets/complete/strand-database-hydrate-catalog-before-apply-schema.md`.
- Related ticket: `strand-membership-rbac-schema-not-applied`.
