----
description: Consolidate cadre-core and quereus-plugin-sereus onto one strand SQL-surface composition that hydrates the catalog before `apply schema App;`, and carry mode/storage/transactor through the plugin loader's parseConfig.
prereq:
files: packages/quereus-plugin-sereus/src/connect.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/plugin.ts, packages/quereus-plugin-sereus/src/plugin-browser.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/package.json, packages/quereus-plugin-sereus/test/e2e/bootstrap.e2e.spec.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/package.json
----

## Goal

There are currently **two parallel, independently-maintained implementations** of the
exact same strand SQL-surface composition:

- `packages/cadre-core/src/strand-database.ts` — `StrandDatabase`, the path actually
  used at runtime (via `StrandInstanceManager.startStrand`, consumed by the cadre
  runtimes and `reference-app-rn`). It **has** the warm-restart hydrate fix.
- `packages/quereus-plugin-sereus/src/connect.ts` (`connectToStrand`) and
  `connect-browser.ts` (`connectToStrandBrowser`) — the nominal "SQL surface" per
  `docs/architecture.md` / `AGENTS.md`, but **unwired**: a repo-wide search for
  `connectToStrand` / `@serfab/quereus-plugin-sereus` finds no importer outside the
  package itself, tickets, docs and README. It **lacks** the hydrate fix.

The two surfaces have already diverged once (the hydrate fix landed in cadre-core
only — see `tickets/complete/strand-database-hydrate-catalog-before-apply-schema.md`).
This ticket eliminates the duplication so future changes land in one place, fixes the
missing-hydrate regression on the plugin path, and repairs the plugin loader config.

**Out of scope (tracked separately):** applying the membership/RBAC schema
(`schemas/strand.qsql`) is the concern of plan ticket
`strand-membership-rbac-schema-not-applied`. Do **not** implement that here. The
consolidation should, however, leave a single obvious seam where that schema will
later be applied (one shared composition function rather than three), so that ticket
becomes a one-location change.

## Background: the bug being fixed

`cadre-core` deliberately calls `pluginResult.hydrate(this.db)` (the optimystic
plugin's catalog-hydration hook, `plugin.ts:70` in `@optimystic/quereus-plugin-optimystic`)
**before** running `apply schema App;`
(`packages/cadre-core/src/strand-database.ts:161-177`). Without hydration, on a warm
restart Quereus's in-memory catalog is empty, so `apply schema App;` diffs the
declared schema against nothing and re-emits CREATE TABLE / CREATE INDEX for every
persisted object — each round-tripping through the optimystic vtab against persisted
storage. This was a measured ~160s `executeSchema` regression on the reference Android
emulator.

`hydrate` appears **nowhere** in `quereus-plugin-sereus`. Both `connect.ts:151-161`
and `connect-browser.ts:176-185` apply the wrapped schema with no prior hydrate, so any
reconnection of `connectToStrand`/`connectToStrandBrowser` against a non-trivial
persisted schema degrades the same way the cadre-core path did before its fix. The
existing `test/e2e/bootstrap.e2e.spec.ts` "persists DML across reopen" case (line 91)
exercises the warm path but only with a 2-column `Msg` table, for which a full re-apply
is cheap — so it does not catch the regression.

## Chosen direction

**Make `quereus-plugin-sereus` the single shared composition; `cadre-core`'s
`StrandDatabase` delegates to it.** Rationale:

- The plugin is the documented SQL surface and already owns the superset of behavior:
  it supports both an **injected** libp2p node (cadre-core's only case) and a
  **self-created** node (Quoomb / browser). cadre-core's composition is the
  injected-node subset.
- `StrandDatabase` keeps its lifecycle role (owns the `Database`, exposes
  `getDatabase()` / `close()`); only its body changes to call `connectToStrand`.
- Adding hydrate once in the shared path fixes node, browser, and cadre-core together.

### Shape after consolidation

Extract the common steps that `connect.ts` and `connect-browser.ts` duplicate into one
internal helper (e.g. `compose-strand.ts`), parameterized by the two things that
genuinely differ between Node and browser:

1. **plugin registration strategy** — `registerPlugin(db, …)` (Node, `connect.ts`) vs
   the inline `applyRegistrations(db, …)` (browser, avoids bundling a second
   `@quereus/quereus`).
2. **node acquisition** — injected node, Node `createLibp2pNode` (TCP), or browser
   `createLibp2pNode` (`/rn` entry + WebSockets + circuit-relay) plus the IndexedDB
   default-storage resolution.

Everything else is shared and lives in the helper, in this order:
- resolve transactor from `mode` / legacy `transactor` (current logic in both files is
  identical — keep it),
- build `pluginConfig` (incl. `rawStorageFactory` when `local` + storage),
- register optimystic vtables/functions,
- `registerLibp2pNode` on the collection factory,
- `setDefaultVtabName('optimystic')` + `setDefaultVtabArgs({...})`,
- **`await pluginResult.hydrate(db)`** (NEW — the fix; mirror the cadre-core timing/log
  lines and the `OptimysticPluginResult.hydrate` type shim from
  `strand-database.ts:27`),
- apply `declare schema App { … } apply schema App;` when `schema` is provided,
- the same try/catch cleanup + returned `shutdown` handler.

`connectToStrand` and `connectToStrandBrowser` become thin adapters supplying the two
strategies. This also collapses the connect.ts↔connect-browser.ts duplication, not just
the cadre-core one.

### cadre-core delegation

`StrandDatabase.initialize()` should: create its `Database`, then call `connectToStrand`
with the injected node:

- `strandId` ← `config.strandId`
- `schema` ← `config.sAppConfig.schema`
- `mode` ← `config.mode`
- `storage` ← `config.rawStorage`  (field rename at the call boundary only)
- `libp2pNode` ← `config.libp2pNode`, `coordinatedRepo` ← `config.coordinatedRepo`
- `enableCache: true`

Store the returned `SereusPluginResult.shutdown` and call it from `StrandDatabase.close()`
(replacing the direct `collectionFactory.shutdown()`); then `db.close()`. Because the
node is injected, `connectToStrand`'s `createdNode` is `null`, so its `shutdown` will
**not** stop the node — correct, since `StrandInstanceManager.stopStrand` owns the node
lifecycle. Keep `getDatabase()` / `ensureInitialized()` / the `initialized` guard as-is.

Add `@serfab/quereus-plugin-sereus` to `cadre-core`'s `package.json` dependencies
(`workspace:^`).

**Cross-platform caution (verify, don't assume):** cadre-core builds for React Native.
The plugin's package `main`/`index.ts` only re-exports `connectToStrand` from
`connect.ts`; the browser-only imports (`@optimystic/db-p2p-storage-web`, explicit
transports) live in `connect-browser.ts`/`plugin-browser.ts` and must NOT be pulled in
by the Node `index`/`connect` path. `connect.ts`'s `await import('@optimystic/db-p2p')`
is only reached when creating a node, which cadre-core never does (node always
injected). Confirm the RN bundle does not start resolving browser-only modules after
this dependency is added.

## parseConfig carry-through

`parseConfig` (`parse-config.ts:8-36`) parses 8 keys but drops `mode` / `storage` /
`transactor`, so the Node `.plugin` entry can never select bootstrap mode or persistent
storage even though `connectToStrand` already accepts all three.

- Parse **`mode`** (`'bootstrap'`/`'networked'`) and **`transactor`** (string override)
  in `parseConfig` — both are plain strings, platform-agnostic.
- **storage**: a `Record<string, SqlValue>` cannot carry an `IRawStorage` instance.
  Carry a **`storage_path`** string instead and resolve it to a concrete storage in the
  platform entry, NOT in `parseConfig`:
  - Node (`plugin.ts`): when `storage_path` is set, construct
    `new FileRawStorage(storage_path)` from `@optimystic/db-p2p-storage-fs` (already a
    devDependency; promote to a runtime `dependency`, and load it via dynamic `import()`
    to keep the package cross-platform — this is legitimate platform-conditional dynamic
    loading, consistent with `connect.ts`'s existing `import('@optimystic/db-p2p')`).
  - Browser (`plugin-browser.ts`): `connectToStrandBrowser` already defaults to
    IndexedDB; leave that default, ignore `storage_path` there (or document it as
    Node-only).
- Add `mode`, `transactor`, `storage_path` to the `quereus.settings` array in
  `package.json` so Quoomb surfaces them.

Decide and document whether `storage_path` belongs on `StrandConnectionOptions` (it is
Node-loader-only sugar) or stays a local concern of `plugin.ts`. Recommended: keep
`StrandConnectionOptions.storage` as the typed `IRawStorage` contract and resolve
`storage_path` → `FileRawStorage` entirely inside `plugin.ts`.

## Regression test

Add a test that would have caught the missing hydrate. The optimystic `hydrate(db)`
returns `{ tables, indexes }`; surface those counts so a test can assert hydration ran
on warm restart (options, pick one):

- expose the hydrate counts on the returned `SereusPluginResult` (e.g.
  `hydrated?: { tables: number; indexes: number }`), and in the bootstrap e2e add a
  **multi-table + indexed** schema, then on the second (warm) `connectToStrand` assert
  `hydrated.tables > 0` / `hydrated.indexes > 0`; or
- assert via a `debug`/spy that `hydrate` was invoked and returned non-zero on reopen.

Note (carried from the cadre-core hydrate ticket): there is no clean Quereus hook to
assert "`apply schema` emitted zero DDL", so assert on the hydrate counts rather than on
re-apply being a no-op. Extend `bootstrap.e2e.spec.ts` rather than adding a new harness.

## Validation

- `yarn build` in `packages/quereus-plugin-sereus` (tsc + browser bundle) — clean.
- `yarn build` in `packages/cadre-core` — clean (new dependency resolves).
- `yarn test` in `packages/quereus-plugin-sereus` (unit + e2e) — green, incl. the new
  warm-restart hydrate assertion. Stream output (`| tee`), do not silently redirect.
- `yarn test` in `packages/cadre-core` — all existing tests still green (the completed
  hydrate ticket reports 10 files / 127 tests).
- Sanity: grep that `connectToStrand` now HAS an importer (`cadre-core`) and that the
  `setDefaultVtab → hydrate → apply schema` order matches `strand-database.ts:152-198`.
- Update `docs/architecture.md` / `docs/STATUS.md` only if they assert the plugin and
  `StrandDatabase` are separate compositions; reflect the consolidation.

## TODO

- [ ] Extract a shared `compose-strand` helper in `quereus-plugin-sereus` holding the
      common steps (transactor resolve, pluginConfig, vtab/function registration,
      `registerLibp2pNode`, `setDefaultVtab*`, hydrate, schema apply, cleanup/shutdown),
      parameterized by registration-strategy and node-acquisition-strategy.
- [ ] Add the `OptimysticPluginResult.hydrate` type shim and the
      `await pluginResult.hydrate(db)` call (with timing/log lines) into the shared path,
      between `setDefaultVtab*` and the `apply schema App;`.
- [ ] Reduce `connect.ts` / `connect-browser.ts` to thin adapters over the helper.
- [ ] Make `cadre-core/StrandDatabase.initialize()` delegate to `connectToStrand`
      (injected node), store + reuse the returned `shutdown` in `close()`, and remove
      the now-duplicated composition body. Add `@serfab/quereus-plugin-sereus`
      (`workspace:^`) to `cadre-core` deps. Keep `getDatabase()`/guards intact.
- [ ] Verify the RN/browser bundles do not start pulling browser-only or fs-only modules
      across the new dependency edge (Node path stays Node-only, browser path browser-only).
- [ ] parseConfig: parse `mode` + `transactor`; carry `storage_path`. Resolve
      `storage_path` → `FileRawStorage` in the Node `plugin.ts` entry via dynamic import;
      promote `@optimystic/db-p2p-storage-fs` to a runtime dependency. Add the three keys
      to `quereus.settings` in `package.json`.
- [ ] Surface hydrate `{ tables, indexes }` on the result (or via spy) and add a
      warm-restart, multi-table+index regression test to `bootstrap.e2e.spec.ts`.
- [ ] Run the builds + test suites above (streamed), and update
      `docs/architecture.md`/`STATUS.md` wording about the two surfaces.
- [ ] Leave a single, clearly-commented seam where `schemas/strand.qsql` will later be
      applied, so `strand-membership-rbac-schema-not-applied` is a one-location change
      (do not apply it here).
