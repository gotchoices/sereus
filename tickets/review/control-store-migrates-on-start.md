description: When a machine starts on a release whose control schema is newer than the one its control database was written under, it upgrades that database in place and keeps every row; a database a newer release upgraded, one from before upgrades existed, or one no upgrade can handle is refused with a reason an app can show. Review this implementation, including the finding that each machine keeps its own copy of the catalog.
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts (`ControlStoreIncompatibility`, `ControlStoreIncompatibleError.reason`, `refuseIncompatibleControlStore`, `incompatibilityOf`, `refusalMessage`), packages/cadre-core/src/control-schema.ts (version doc comments), packages/cadre-core/src/control-database.ts (`loadSchema` and `applyControlSchema` comments), packages/cadre-core/src/index.ts, test-harness/control-schema-releases.ts (new; the two "releases" both suites run), packages/cadre-core/test/control-store-migration.spec.ts (renamed from control-store-incompatible.spec.ts), packages/cadre-core/test/control-schema-versions.spec.ts (section title only), packages/integration-tests/src/harness/node-fixtures.ts (`ControlNodeOpts.schemaPath`), packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts (new), docs/architecture.md ("Control schema versions and migrations"), .release-notes.pending.md, tickets/blocked/decide-control-catalog-lineage-per-machine.md (new)
----

# The control store migrates when a machine starts on a newer release

GitHub #46. The runtime half of versioned control-schema migrations, on top of `control-schema-versions-stay-migratable` (edit-time guard and fixtures) and Optimystic 1.16.0's catalog-only `alter table` arms (adopted by `adopt-optimystic-1-17-0`; the `@optimystic/*` floors were already ^1.17.0, `scripts/check-dep-ranges.mjs` passes).

## What changed

- **The apply is the migration.** `ControlDatabase.loadSchema` keeps its shape (declare, check, apply with the existing retry policy). `refuseIncompatibleControlStore` now lets `additive` and `catalog-only` changes through, so the apply's diff runs each version's changes in order and ends with `alter table OwnerKey set tags`, which persists since Optimystic 1.16.0; after a migrating start the store records the build's version. No per-version migration code.
- **Three refusal reasons**, decided in this order by `incompatibilityOf`: `newer-release` (store version above the build's; message says to update and gives no recreate advice), `before-migrations` (store version below `CONTROL_SCHEMA_BASELINE_VERSION`, refused even when the diff only adds; recreate advice, points at the baseline explanation), `not-migratable` (an `unmigratable` pending statement; recreate advice). `ControlStoreIncompatibleError` gains `readonly reason`, and its constructor takes the reason first; the only constructor call is in the module. `ControlStoreIncompatibility` is exported from the package entry beside the error. `CadreNode.start()` rethrows unchanged, so the kits' `status.error` carries `reason`; no kit change.
- **Comments and docs.** The module `NOTE:` about the stale tag is replaced by what the migrating start guarantees. `applyControlSchema`'s unwind comment names the catalog-only arms, checked against the adopted plugin source (`alterCatalogOnly`, `saveCatalogOnly`, `endSchemaBatch`): an owned record write is withdrawn when its statement throws, a failed batch commit marks written tables to re-persist on their next touch, a change the record already holds is adopted with nothing written and its undo touches this machine's catalog only, and `drop column` is irreversible in Quereus, so after a failed apply the re-run's diff no longer lists it and the record is brought to it by the re-persist. The docs section is renamed "Control schema versions and migrations" with the old anchor kept through an `<a id>` element, as the doc does elsewhere.
- **Release notes.** Two "Upgrading" entries: stores from 1.17.0 on migrate; a machine refused as `newer-release` should be updated, and 1.17.0's own wording ("created by a newer release", advising a recreate) means the same.

## The finding the reviewer should start from: one catalog lineage per machine

The ticket's design, and its integration step 4 ("B restarts under the baseline fixture and is refused with `newer-release`"), assumed the optimystic catalog collection `optimystic/schema` is one replicated collection per party. It is not. `CadreNode.start()` initializes the control database inside the bring-up quiet period with no connection open, so every start-time apply commits alone, and every machine that joins with an empty store commits the catalog collection by itself: a second lineage beside the founder's, under the same block id. `docs/architecture.md` → "Control tables are network-backed" names this exact fork as the one `commitEmptyControlCollections` prevents for the table collections; the catalog is not covered.

Measured in the new scenario with a temporary `readBlockIndex` print (removed): after A and B have converged every row and before any migration, `optimystic/schema` sits at revision 1 on both stores under different action ids. The catch-up push copies A's catalog blocks into B's store, but B's restart hydrates the lineage B's own header names. Consequences, all now stated in the docs:

- A migration by one machine never reaches another machine's lineage; each machine migrates its own lineage when it starts on the new release, with the same statements.
- A machine on the old release keeps working across restarts; it is not refused. The `newer-release` refusal and the plugin's adopt-without-writing arms are reached only by machines sharing a lineage, which none does today.
- The scenario's steps 4 and 5 were changed to what holds: B restarts on the old release, starts on its own lineage and reads every row; B restarts on the new release, migrates its own lineage and reads every row including the new column's value. The scenario's header and a step-4 comment say which assertion replaces step 4 once lineages are shared.

Filed as `blocked/decide-control-catalog-lineage-per-machine`: accept per-machine lineages as the design (recommended; no code), have a joiner adopt the party's lineage at first connection (a Sereus bring-up change, needs a plan pass), or have Optimystic merge identical lineages (upstream). The reviewer should check the reasoning against the plugin source and decide whether the docs' current wording is the right default while the decision is open.

## Other judgment calls

- **The next release's new column is `ValidationKey.Note`, not a `CadrePeer` column.** The integration scenario must write a value into the new column, and both "releases" run this build's writers, which name their columns; so the value is written by hand. A hand-written `CadrePeer` insert is refused by the repo's lint rule (it would skip the membership snapshot refresh), and `ValidationKey`'s insert needs one owner signature over two fields. The store variant's extra, dropped column is on `CadrePeer` (`Obsolete`), so the drop is exercised on a table holding rows; the CHECK change is `OwnerKey.LabelLength` widened to 96. Both suites build the releases from `test-harness/control-schema-releases.ts`, imported by relative path as the stale-build guard is.
- **"Nothing was applied" for `before-migrations` is proved by a second refused start** reporting the same version 0 and the same pending DDL. The ticket's "the store schema still starts afterwards" cannot work for this reason: a version-0 schema file run on this build is itself refused as `before-migrations`.
- **"The tag was saved" is proved by a refused start under the previous release** reading `storeVersion` 4 from the hydrated catalog. After an apply the in-memory tag reads the build's version whether or not it was saved, so the ticket's post-apply read could not tell.
- **`refusalMessage` is a `switch` with no default**, so adding a reason fails typecheck until it has a message.

## Tests

`control-store-migration.spec.ts` (renamed; one storage across starts, one libp2p node at a time, `schemaPath` picks the schema):

- **from the previous version: migrates on start and keeps its rows** — write an owner key with a label, a peer row and a validation key under `previous`; restart under `next`: the owner key reads with label and stamp, the peer row and the validation key read back, `Annotation` exists, the pending diff is empty and the tag reads 4; a second `next` start finds nothing pending; a start under `previous` is refused `newer-release` with `storeVersion` 4, which shows the tag was saved. The contract the ticket exists for.
- **migrated by a newer release: refused as newer-release, without recreate advice, even when the pending changes only add** — the existing newer-store case, plus `reason` and the message check; the newer release still starts on its store.
- **from before migrations: refused as before-migrations even when the pending changes only add** — the case that used to start; now version 0 is refused, with the second-start probe above.
- **with a change that rewrites or discards rows: refused as not-migratable, and nothing is dropped** — the existing `drop table` case at the build's version, plus `reason` and the recreate advice.

`control-schema-migration-mixed-releases.integration.ts` (two machines, each on its own storage capture and its own `schemaPath`; 240 s budget, runs in about 20 s): the five steps in the file header. It pins mixed-release operation (rows cross releases both ways, a value in a column the old release does not know reads as absent there and is intact after the old machine updates) and the per-machine lineage behaviour at steps 4 and 5.

`ControlNodeOpts.schemaPath` in the harness is wiring and has no test. The CHECK-body change is covered only by the apply succeeding with an `OwnerKey` row present (Quereus validates stored rows against the re-added CHECK).

## Validation run

- `yarn lint`: clean. `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`: clean.
- `yarn workspace @serfab/cadre-core test`: 187 files, 2523 passed, 1 skipped (the skip predates this ticket). `control-start-storage-op-budget.spec.ts` passes unchanged: a warm start still runs one `diff schema`.
- The new scenario: passed 3 of 3 runs (two with diagnostics, one final).
- `node scripts/check-dep-ranges.mjs`: all 10 linked ranges admit their workspace version.

## Known gaps

- **The concurrent-migration race and the adopt arms are not exercised** by any Sereus test, and with per-machine lineages they are not reachable either; the plugin's idempotency was checked by reading `alterCatalogOnly`/`saveCatalogOnly` only.
- **An older machine's first touch of a table after a migration writes its older description back** (Optimystic's `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record`). With per-machine lineages it writes it over its own lineage, so it is moot today; the docs bullet keeps it for the shared-lineage case. The scenario has B touch `ValidationKey` before the migration on purpose.
- **A failed apply that reached `drop column`** leaves this machine's catalog without the column while the record keeps it until the next touch re-persists it; argued from the plugin source, not tested (`control-schema-apply-unwind.spec.ts` injects a refusal at `create`, before any alter arm).
- **The `before-migrations` message points at "the baseline paragraph of docs/architecture.md"** in prose; there is no anchor for that paragraph.

## Tripwires recorded

- Docs → "Mixed versions in one party": an older machine's row update clears a new column's value until that machine updates (`NOTE:` bullet).
- Docs → "Row rewrites": the plan for a version that needs rows rewritten (`NOTE:` paragraph).
- `applyControlSchema` comment: the irreversible `drop column` arm and the re-persist that follows a failed apply.
