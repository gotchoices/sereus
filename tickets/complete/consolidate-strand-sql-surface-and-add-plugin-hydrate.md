description: Consolidated the strand SQL-surface composition onto a single shared `composeStrand` helper (cadre-core `StrandDatabase` now delegates to `connectToStrand`), added the warm-restart catalog-hydrate to the plugin path, and carried `mode`/`transactor`/`storage_path` through the loader. Reviewed and completed.
files:
  - packages/quereus-plugin-sereus/src/compose-strand.ts        (shared composition; shutdown comment corrected)
  - packages/quereus-plugin-sereus/src/connect.ts               (thin Node adapter)
  - packages/quereus-plugin-sereus/src/connect-browser.ts       (thin browser adapter)
  - packages/quereus-plugin-sereus/src/parse-config.ts          (mode/transactor)
  - packages/quereus-plugin-sereus/src/plugin.ts                (storage_path -> FileRawStorage)
  - packages/quereus-plugin-sereus/src/plugin-browser.ts        (storage_path Node-only note)
  - packages/quereus-plugin-sereus/src/types.ts                 (SereusPluginResult.hydrated)
  - packages/quereus-plugin-sereus/package.json                 (settings + storage-fs runtime dep)
  - packages/quereus-plugin-sereus/test/plugin.spec.ts          (reframed 2 tests + parseConfig tests)
  - packages/quereus-plugin-sereus/test/e2e/bootstrap.e2e.spec.ts (warm-restart hydrate regression)
  - packages/cadre-core/src/strand-database.ts                  (delegates to connectToStrand; shutdown comments corrected)
  - packages/cadre-core/package.json                            (workspace dep)
  - docs/architecture.md                                        (consolidation note)
----

## Summary of completed work

Eliminated the triplicated strand SQL-surface composition. There is now **one**
implementation, `composeStrand` in `packages/quereus-plugin-sereus/src/compose-strand.ts`,
through which all three entry points flow:

- `connectToStrand` (Node) — thin adapter supplying Node platform seams.
- `connectToStrandBrowser` (browser) — thin adapter supplying browser seams.
- cadre-core `StrandDatabase` — delegates to `connectToStrand` with its injected
  libp2p node; retains only the `Database` lifecycle (`getDatabase()`, `close()`,
  the `initialized` guard).

`composeStrand` is parameterized by three `StrandPlatform` strategies
(`registerCrypto`, `resolveStorage`, `createNode`); everything else — transactor
resolution, pluginConfig, optimystic registration, `registerLibp2pNode`,
`setDefaultVtab*`, **hydrate**, schema apply, cleanup/shutdown — is shared.

**Bug fixed:** the plugin path previously had no `hydrate` call, so a warm
reconnection against a non-trivial persisted schema re-emitted CREATE TABLE /
CREATE INDEX for every persisted object (the ~160s regression cadre-core already
fixed). `composeStrand` now `await`s `pluginResult.hydrate(db)` between
`setDefaultVtab*` and `apply schema App;`. Counts are surfaced on
`SereusPluginResult.hydrated`.

**Loader carry-through:** `parseConfig` parses `mode` (validated) and the internal
`transactor` override; `plugin.ts` (Node) reads `config.storage_path` directly and
resolves it to a `FileRawStorage` via dynamic `import('@optimystic/db-p2p-storage-fs')`
(promoted dev→runtime dep). `plugin-browser.ts` ignores `storage_path` (Node-only,
documented). All three keys added to `quereus.settings`.

## Review findings

### What was checked
- Read the full implement diff (`210b151`) with fresh eyes before the handoff:
  `compose-strand.ts`, both connect adapters, `strand-database.ts`,
  `parse-config.ts`, `plugin.ts`, `plugin-browser.ts`, `types.ts`, both test
  files, and the package.json / docs changes.
- Cross-package consolidation completeness: searched for any remaining inline
  strand composition (`optimysticPlugin` / `registerLibp2pNode` / `setDefaultVtabName`).
  Only `compose-strand.ts` (the consolidation target) and `control-database.ts`
  remain. **Confirmed `control-database.ts` is correctly out of scope** — it is the
  cadre *control plane* (a different SQL surface; raw `db.exec(schema)`, no
  declarative diff/apply, no sApp hydrate), not a strand.
- Node-vs-browser module-graph isolation: `index.ts` exports only `connectToStrand`
  (Node), so cadre-core never pulls browser-only modules; `storage_path`'s
  `db-p2p-storage-fs` import is dynamic and Node-only.
- Resource cleanup / shutdown semantics — traced through to optimystic's
  `CollectionFactory.shutdown()` (see finding 1).
- Cross-platform `performance.now()` in the now-shared `composeStrand`: it newly
  runs on the browser/RN path (the old `connect-browser.ts` had no timing calls).
  Verified **not** a new risk — cadre-core (which also targets RN) already uses
  `performance.now()` throughout, so the global is already required on every target.
- Validation re-run from scratch (see below).

### Findings and disposition

1. **MINOR — fixed inline (comment correctness).** Several new comments asserted
   the injected libp2p node "is left alone" / "`shutdown` never stops the node."
   This is inaccurate: `composeStrand.shutdown` always calls
   `collectionFactory.shutdown()`, and optimystic's `CollectionFactory.shutdown()`
   (`collection-factory.ts:435`) iterates **all** registered nodes — including one
   injected via `registerLibp2pNode` — and calls `node.stop()` on each. So an
   injected node *is* stopped on shutdown; the `if (createdNode)` guard only avoids
   a redundant *second* stop on a node we created. The net behavior (cadre-core
   `releaseRuntime` then issues another `node.stop()`) is a harmless **idempotent
   double-stop** and is **pre-existing** (the old cadre-core `close()` likewise
   called `collectionFactory.shutdown()`), so no functional change — but the
   comments actively misled. Corrected the comments in `compose-strand.ts` (step-7
   return block) and `strand-database.ts` (class doc, `initialize()` inline note,
   `close()` doc) to describe the real behavior. The public `SereusPluginResult.shutdown`
   type doc ("Shuts down the libp2p node and collection factory") already matched
   reality, so no contract change and no new ticket warranted.

2. **MINOR — accepted, documented (test coverage floor).** The two reframed unit
   tests ("create a node" / "stop node") were re-pointed `network` → `bootstrap`
   because hydrate now drives a real coordinator lookup the mock node can't satisfy.
   Verified both still exercise the "non-test transactor ⇒ create + stop a node"
   branch (`createLibp2pNode` called once; mock node `.stop()` asserted) — the
   branch logic is identical for `network` and `bootstrap` (`resolvedTransactor !== 'test'`),
   so only the post-create hydrate path differs. The default-`network` end-to-end
   path remains covered by the real-node `networked.e2e.spec.ts`. Acceptable.

3. **MINOR — pre-existing, out of scope (untested seams).** `storage_path`
   resolution in `plugin.ts` and a cadre-core warm-restart through
   `StrandDatabase.initialize()` are not directly unit-tested. Both are small
   delegating branches; `storage_path`'s logic is a `typeof` guard + dynamic import,
   and the warm-restart composition itself is covered by the new
   `bootstrap.e2e.spec.ts` (multi-table + index hydrate). The cadre-core warm-restart
   gap is the same one the original hydrate ticket flagged; not introduced here.
   Left as-is — not worth a new ticket given the e2e coverage of the shared path.

4. **OBSERVATION — pre-existing, not introduced.** Networked-mode hydrate performs a
   blocking network read during connect; a transient (non "not-found/empty") error
   propagates out of `connectToStrand`. This moved onto the plugin path with the
   consolidation but is unchanged cadre-core behavior. If it ever proves a real
   robustness problem it is a separate ticket; not actionable here.

5. **OBSERVATION — minor foot-gun.** `transactor` (marked `@internal` on the type)
   is now exposed as a public `quereus.settings` key alongside `mode`/`storage_path`,
   so an external `.load` could pass e.g. `transactor: 'test'` and get a
   node-less, non-functional strand. String passthrough only — not a correctness or
   security defect. Noted, not changed.

### Categories with nothing found
- **Functional/correctness bugs in the consolidation:** none. The
  `setDefaultVtab → hydrate → apply schema` order is preserved across all three
  entry points; transactor/`mode` precedence matches the documented contract;
  injected-node `coordinatedRepo` validation retained.
- **Type safety:** clean. The only `no-explicit-any` warnings (4, in
  `applyRegistrations`) were relocated verbatim from the prior duplicated code;
  no new ones. Typecheck clean on both packages.
- **DRY/modularity:** this change is a net DRY win — three copies collapsed to one,
  with `applyRegistrations` shared rather than re-inlined.

### Validation re-run (all green)
- `yarn typecheck` (quereus-plugin-sereus) — clean.
- `yarn typecheck` (cadre-core) — clean.
- `yarn test` (quereus-plugin-sereus) — **39 passed / 1 todo** (5 files), incl. the
  warm-restart hydrate assertion (`tables > 0` **and** `indexes > 0`) and cold-start
  `{ tables: 0, indexes: 0 }`.
- `yarn test` (cadre-core) — **292 passed** (21 files).
- `eslint` on all changed source files — **0 errors** (4 pre-existing
  `no-explicit-any` warnings only).
- Comment-only review edits re-verified with both typechecks after applying.

No pre-existing test failures encountered; `tickets/.pre-existing-error.md` not written.

## Out of scope (unchanged)

Applying `schemas/strand.qsql` (membership/RBAC) remains tracked by
`strand-membership-rbac-schema-not-applied`. The consolidation leaves a single
clearly-commented `// SEAM:` in `compose-strand.ts` immediately before
`apply schema App;` so that ticket stays a one-location change.
