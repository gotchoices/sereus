description: When a machine starts on a release whose control schema is newer than the one its control database was written under, it upgrades that database in place and keeps every row; a database a newer release upgraded, one from before upgrades existed, or one no upgrade can handle is refused with a reason an app can show.
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/index.ts, test-harness/control-schema-releases.ts, packages/cadre-core/test/control-store-migration.spec.ts, packages/cadre-core/test/control-schema-versions.spec.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts, docs/architecture.md ("Control schema versions and migrations"), .release-notes.pending.md, tickets/blocked/decide-control-catalog-lineage-per-machine.md
----

# The control store migrates when a machine starts on a newer release

GitHub #46. The runtime half of versioned control-schema migrations, on top of `control-schema-versions-stay-migratable` (edit-time guard and fixtures) and Optimystic's catalog-only `alter table` arms (adopted with Optimystic 1.17.0).

## What shipped

- **The start-time apply is the migration.** `ControlDatabase.loadSchema` declares, checks and applies as before; `refuseIncompatibleControlStore` now lets `additive` and `catalog-only` changes through, so `apply schema CadreControl` runs each version's changes in order and ends with `alter table OwnerKey set tags`, which persists. No per-version migration code.
- **Three refusal reasons**, in this order (`incompatibilityOf`): `newer-release` (store version above the build's; message says to update, no recreate advice), `before-migrations` (store version below `CONTROL_SCHEMA_BASELINE_VERSION`, whatever the diff; recreate advice), `not-migratable` (an `unmigratable` pending statement; recreate advice). `ControlStoreIncompatibleError.reason` carries it; `ControlStoreIncompatibility` and `CONTROL_SCHEMA_VERSION_TAG` are exported from the package entry. `CadreNode.start()` rethrows unchanged, so the kits' `status.error` carries `reason`.
- **Each machine migrates its own catalog lineage.** Every start-time apply commits alone (no control connection is open during bring-up), so a joiner's first start commits the optimystic catalog collection a second time beside the founder's. A migration on one machine therefore never reaches another's catalog; a machine on the old release keeps working across restarts and migrates its own lineage when it updates. Documented in docs/architecture.md → "Every machine migrates its own catalog"; whether that is the design is `blocked/decide-control-catalog-lineage-per-machine`.
- **Tests.** `control-store-migration.spec.ts` (renamed from `control-store-incompatible.spec.ts`): the migration keeps rows and saves the version, and one case per refusal reason. `control-schema-migration-mixed-releases.integration.ts`: two machines of one party on different releases, rows crossing both ways, the second machine restarting on the old release and then updating. Both build their two "releases" from `test-harness/control-schema-releases.ts`.
- **Docs and release notes.** docs/architecture.md section renamed "Control schema versions and migrations" (old anchor kept), with the check, the per-machine lineage, mixed-version behaviour and the row-rewrite plan; two "Upgrading" entries in `.release-notes.pending.md`.

## Review findings

Read the `ticket(implement): control-store-migrates-on-start` diff first, then the plugin source it argues from (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts`: `alterCatalogOnly`, `saveCatalogOnly`, `dropColumn`, `endSchemaBatch`) and Quereus's apply loop (`../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts`, `runStepsWithUndoJournal`).

**Correctness — fixed inline.**
- The `newer-release` message said "another machine of the party is already on that release". With per-machine catalog lineages that is false today: the only way to reach the refusal is this machine having run the newer release on its own store and then being downgraded. The message now says only that a newer release migrated the store and to update to that release or a later one; the `ControlStoreIncompatibility` doc and the docs bullet ("Reached today only when this machine itself ran the newer release … and was then downgraded") say the same. The blocked ticket's claim that the refusal is unreachable was corrected the same way.
- `applyControlSchema`'s comment said that after a failed apply that reached `drop column`, "the record is brought to it by that re-persist". Quereus marks `drop column` irreversible, which poisons the undo journal: a later failure unwinds nothing, and the plugin's `endSchemaBatch` commits the steps that landed (re-persist on next touch applies only when that commit itself fails). The comment now states that, and that the retry's diff runs only the missing steps.

**Docs and comments the change should have touched — fixed inline.**
- `control-write-retry.ts` (`RETRIABLE_SCHEMA_INIT_MATCHERS` doc) still said no irreversible step reaches a `CadreControl` apply because the start-time check refuses anything but creates and tag changes. Now `drop column` does reach it, as a catalog-only migration step; the comment says so.
- `index.ts`'s export comment described only the recreate case; it now describes the migration and the refusal reasons.
- Every other file naming the old section title or spec name was checked (`grep` across packages, docs, tickets); only historical garden-report lines remain.

**DRY / hygiene — fixed inline.**
- `control-schema-versions.spec.ts` kept its own copies of `replaceOnce` and `withItems`, identical to the new harness module's; it now imports them (and `withLegacyTable`) from `test-harness/control-schema-releases.ts`.
- The integration scenario redeclared the `sereus.controlSchemaVersion` string; `CONTROL_SCHEMA_VERSION_TAG` is now exported from cadre-core and used there. The harness keeps its own copy, with a comment naming the source, since it reads fixtures as text and imports nothing from cadre-core.
- `readControlSchemaFixture` was exported but used only inside the harness module (knip flagged it); now module-private.

**Contract checked without a new test.** The shipped tests prove the version tag is saved only on a migration that also alters `OwnerKey`. A throwaway spec (deleted) migrated the embedded schema to version+1 by adding a table alone and restarted under the build: refused `newer-release` with `storeVersion` 4, so a tag-only change to an untouched `OwnerKey` persists too. Not kept: Optimystic's own tests own that behaviour, and the migration case already pins the version Sereus relies on.

**The per-machine lineage finding.** Checked the reasoning against the plugin source: `saveCatalogOnly` reads the record fresh through the current transaction's transactor, which at start time is local, so each machine's apply reads and writes the lineage its own store names; the scenario's step 4 (B restarts on the old release and reads its own version) confirms it, and the scenario passes. The docs' current wording (option 1 as the running behaviour, the question pointed at the blocked ticket) is the right default while the decision is open. No ticket filed beyond the existing blocked one.

**Tests.** Kept as written: the migration case is the contract the ticket exists for, and each refusal case pins one branch of `incompatibilityOf` with a distinct message. The integration scenario (about 8 s of test time) is the only coverage of rows crossing releases. Nothing restates the implementation or verifies a mock.

**Error handling, resource cleanup, types.** `refusalMessage` is an exhaustive `switch` with no default, so a new reason fails typecheck until it has a message. Temporary schema directories are removed in `afterAll`/`finally` and hold only `.qsql` files (no junctions). The constructor's reason-first argument order has one caller.

**Performance.** A warm start still runs one `diff schema`; `control-start-storage-op-budget.spec.ts` passes unchanged.

**Tripwires.** None new. The implementer's three stand: docs "Mixed versions in one party" (an older machine's row update clears a new column), docs "Row rewrites" (plan if a version ever needs one), and the `applyControlSchema` comment on the irreversible `drop column` arm (now corrected).

**Known gaps carried forward (no ticket; reasons given).**
- The adopt-without-writing arms and a concurrent migration on a shared lineage are not exercised; with per-machine lineages they are unreachable, and the blocked ticket owns whether that changes.
- A failed apply that reached `drop column` is argued from the source, not tested; `control-schema-apply-unwind.spec.ts` injects its failure before any alter arm. Reaching it needs a schema version with a dropped column, which none has yet.
- The `before-migrations` message points at "the baseline paragraph of docs/architecture.md" in prose, without an anchor.

## Validation

- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`: clean (after `yarn workspace @serfab/cadre-core build` for the new export).
- `yarn workspace @serfab/cadre-core test`: 187 files, 2523 passed, 1 skipped (predates this ticket).
- `control-schema-migration-mixed-releases.integration.ts`: passed.
- `check-test-file-typecheck-coverage`, `check-vitest-typecheck-coverage`: pass. `yarn knip` reports nothing new for the touched files beyond the pre-existing `ControlSchemaChangeKind` type.
