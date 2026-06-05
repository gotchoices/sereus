description: Review the consolidation of the strand SQL-surface composition onto one shared `composeStrand` helper (cadre-core `StrandDatabase` now delegates to `connectToStrand`), the warm-restart catalog-hydrate fix on the plugin path, and the parseConfig mode/transactor/storage_path carry-through.
files:
  - packages/quereus-plugin-sereus/src/compose-strand.ts        (NEW — shared composition)
  - packages/quereus-plugin-sereus/src/connect.ts               (now thin adapter)
  - packages/quereus-plugin-sereus/src/connect-browser.ts       (now thin adapter)
  - packages/quereus-plugin-sereus/src/parse-config.ts          (mode/transactor)
  - packages/quereus-plugin-sereus/src/plugin.ts                (storage_path -> FileRawStorage)
  - packages/quereus-plugin-sereus/src/plugin-browser.ts        (storage_path Node-only note)
  - packages/quereus-plugin-sereus/src/types.ts                 (SereusPluginResult.hydrated)
  - packages/quereus-plugin-sereus/package.json                 (settings + storage-fs runtime dep)
  - packages/quereus-plugin-sereus/test/plugin.spec.ts          (reframed 2 tests + parseConfig tests)
  - packages/quereus-plugin-sereus/test/e2e/bootstrap.e2e.spec.ts (warm-restart hydrate regression)
  - packages/cadre-core/src/strand-database.ts                  (delegates to connectToStrand)
  - packages/cadre-core/package.json                            (workspace dep)
  - docs/architecture.md                                        (consolidation note)
----

## What landed

Eliminated the duplicated strand SQL-surface composition. There is now **one**
shared implementation, `composeStrand` in
`packages/quereus-plugin-sereus/src/compose-strand.ts`, that all three entry
points flow through:

- `connectToStrand` (Node) — thin adapter supplying the Node platform seams.
- `connectToStrandBrowser` (browser) — thin adapter supplying the browser seams.
- cadre-core `StrandDatabase` — now delegates to `connectToStrand` with its
  injected libp2p node; it keeps only the `Database` lifecycle role
  (`getDatabase()`, `close()`, the `initialized` guard).

`composeStrand` is parameterized by three platform strategies on a `StrandPlatform`
object: `registerCrypto` (Node `registerPlugin` vs browser inline
`applyRegistrations`), `resolveStorage` (Node passthrough vs browser IndexedDB
default), and `createNode` (Node TCP via `@optimystic/db-p2p` vs browser
WebSockets+relay via `@optimystic/db-p2p/rn`). Everything else — transactor
resolution, pluginConfig, optimystic registration, `registerLibp2pNode`,
`setDefaultVtab*`, **hydrate**, schema apply, cleanup/shutdown — is shared.

### The bug fixed

The plugin path (`connect.ts` / `connect-browser.ts`) previously had **no**
`hydrate` call, so a warm reconnection against a non-trivial persisted schema
would re-emit CREATE TABLE / CREATE INDEX for every persisted object (the ~160s
regression cadre-core already fixed). `composeStrand` now `await`s
`pluginResult.hydrate(db)` between `setDefaultVtab*` and `apply schema App;`,
matching the order in the former cadre-core code. The optimystic `hydrate`
returns `{ tables, indexes }`; these are surfaced on
`SereusPluginResult.hydrated` so a test can assert hydration ran.

### parseConfig / plugin loader

`parseConfig` now parses `mode` (`'bootstrap'`/`'networked'`, validated) and the
internal `transactor` override. `storage_path` is **not** in the typed options
(an `IRawStorage` can't ride a `Record<string,SqlValue>`); instead `plugin.ts`
(Node) reads `config.storage_path` directly and resolves it to a
`FileRawStorage` via dynamic `import('@optimystic/db-p2p-storage-fs')` (promoted
dev→runtime dep). `plugin-browser.ts` ignores `storage_path` (documented
Node-only; browser defaults to IndexedDB). All three keys were added to
`quereus.settings` in package.json.

## Validation performed

- `yarn build` in `quereus-plugin-sereus` — clean (tsc + browser bundle; bundle
  2960 KiB raw / 638 KiB gzipped, well under the 8/3 MiB caps).
- `yarn build` in `cadre-core` — clean (new `@serfab/quereus-plugin-sereus`
  `workspace:^` dep resolves; `yarn install` re-wired the edge + lockfile).
- `yarn test` in `quereus-plugin-sereus` — **39 passed / 1 todo** (5 files),
  incl. the new warm-restart hydrate assertion.
- `yarn test` in `cadre-core` — **292 passed** (21 files).
- `yarn typecheck` (plugin) — clean. `eslint` on changed files — 0 errors (only
  pre-existing `no-explicit-any` warnings, relocated verbatim from the old
  `applyRegistrations`/test mocks).
- Cross-platform: confirmed browser-only modules (`db-p2p/rn`, `@libp2p/websockets`,
  `@libp2p/circuit-relay-v2`, `db-p2p-storage-web`) appear **only** in
  `connect-browser.ts`, and fs-only `db-p2p-storage-fs` **only** in `plugin.ts`
  (dynamic import). The Node `index → connect → compose-strand` graph cadre-core
  resolves is clean of both, so the RN bundle won't start pulling them. The
  existing `browser-bundle.spec.ts` forbidden-import assertion still passes.
- Sanity: `connectToStrand` now HAS a real importer outside the package —
  `cadre-core/src/strand-database.ts`. The `setDefaultVtab → hydrate → apply
  schema` order is preserved.

## Use cases / what to test

- **Warm restart (headline):** `bootstrap.e2e.spec.ts` →
  "hydrates the catalog from a persisted multi-table+index schema on warm
  restart". Cold session applies a 2-table + 1-index schema and inserts; a
  second session over the same storage dir asserts `result.hydrated.tables > 0`
  **and** `result.hydrated.indexes > 0` (proves the index round-trips through
  optimystic's stored schema and is rehydrated), plus a cross-table join returns
  the persisted row. This is the floor — see gaps below.
- **Cold start:** same test asserts the first session's `hydrated` is
  `{ tables: 0, indexes: 0 }`.
- **Node lifecycle:** `plugin.spec.ts` → node created for a real (non-test)
  transactor and stopped on shutdown.
- **parseConfig:** new cases for `mode` (valid/invalid/absent) and `transactor`.
- **Browser shape unchanged:** `browser-shape.spec.ts` / `browser-bundle.spec.ts`
  still green (IndexedDB reached, no forbidden imports, under size caps).

## Known gaps / things to scrutinize (treat tests as a floor)

1. **Two unit tests were reframed `network` → `bootstrap`.** `plugin.spec.ts`'s
   "create node" / "stop node" tests previously ran with the default `network`
   transactor + a mock `createLibp2pNode`. Hydrate now drives a real
   `Libp2pKeyPeerNetwork.findCoordinator` lookup the **mock** node cannot satisfy
   (crashes in `batch-coordinator`). Faithfully mocking the libp2p coordinator +
   repo protocol is out of scope for a unit test, so these two now use
   `mode: 'bootstrap'` (real local transactor, in-memory hydrate) — still
   exercising "non-test transactor ⇒ create + stop a node". **Consequence:** the
   default-`network` node-creation path is now covered only by the real-node
   `networked.e2e.spec.ts`, not a unit test. Confirm that's acceptable.
2. **Networked-mode hydrate does a blocking network read during connect.** This
   is pre-existing cadre-core behavior, now also on the plugin path: if the
   cohort is unreachable at connect time, `hydrate` (hence `connectToStrand`)
   throws. Not introduced or changed here, and `hydrateCatalog` swallows only
   "not found / missing / empty"; a transient network error propagates. Worth a
   look as a latent robustness concern (would be a separate ticket if real).
3. **No cadre-core unit test drives a persisted warm-restart through
   `StrandDatabase.initialize()`** — the same gap the original hydrate ticket
   flagged. The delegation is covered indirectly (292 tests green) and the
   plugin e2e covers the composition, but the cadre-core seam specifically is
   not warm-restart-tested.
4. **`storage_path` resolution in `plugin.ts` is not directly unit-tested.** No
   test loads the Node plugin default-export with `storage_path` set and asserts
   a `FileRawStorage` is constructed. The `parseConfig` half (mode/transactor)
   is tested; the storage_path half is exercised only via manual reasoning.
5. **Observability change (debug-only).** cadre-core's former per-step timing
   lines (`cryptoPlugin`, `optimysticPlugin`, `registerLibp2pNode`,
   `setDefaultVtab`, `executeSchema`) are gone; cadre-core now emits a single
   `sereus:cadre:timing` `connectToStrand` line, and per-step/hydrate timing
   moved to the plugin's `sereus:plugin:strand:timing` namespace. No functional
   impact, but anyone grepping the old channels on-device should know.
6. **`index indexes > 0` assertion depends on optimystic persisting declared
   indexes into the stored table schema.** It held in this run, but it couples
   the test to optimystic-internal behavior (`StoredTableSchema.indexes`); if
   optimystic ever stops persisting declarative indexes that way, the assertion
   would regress for an external reason. The `tables > 0` half is more robust.

## Out of scope (do NOT implement here)

Applying `schemas/strand.qsql` (membership/RBAC) is tracked by plan ticket
`strand-membership-rbac-schema-not-applied`. This consolidation deliberately
leaves a **single** clearly-commented seam for it — in `compose-strand.ts`, the
`// SEAM:` comment immediately before `apply schema App;` (the one place
declarative schema is applied) — so that ticket becomes a one-location change.
