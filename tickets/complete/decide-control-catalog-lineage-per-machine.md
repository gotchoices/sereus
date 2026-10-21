description: Every machine that joins a party keeps its own copy of the party's control-table catalog, so a schema upgrade made by one machine never reaches the others' copies and each machine upgrades its own copy when it updates. Decide whether that is the design, or whether a joining machine should take over the founder's copy.
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-database.ts (`loadSchema`, `applyControlSchema`, `commitEmptyControlCollections`), packages/cadre-core/src/control-schema-version.ts (`refuseIncompatibleControlStore`, the `newer-release` reason), packages/cadre-core/src/cadre-node.ts (`start()`, the bring-up quiet period before `controlDatabase.initialize()`), packages/cadre-core/src/peer-join-backfill.ts, packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts, docs/architecture.md ("Every machine migrates its own catalog", "Control tables are network-backed"), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (`endSchemaBatch`, `alterCatalogOnly`; read only)
difficulty: medium
----

# Decide: one control catalog per party, or one per machine

**Blocked category: the architecture is contradictory.** Unblocks when the maintainer picks one of the three options below (the first is the recommended default and needs no code).

## What was found

`control-store-migrates-on-start` made the start-time `apply schema CadreControl` the migration of a control store: between consecutive control schema versions the difference is catalog-only, so the apply brings a store's catalog to this build's version and records it. The ticket's design assumed the optimystic catalog collection (`optimystic/schema`, where every table's description is filed) is one replicated collection per party, so that the first machine to start on a new release changes the catalog the others hydrate, and a machine still on the old release is refused with `newer-release` when it restarts.

That assumption does not hold. `CadreNode.start()` brings the control database up inside the bring-up quiet period, with no control connection open, so every start-time apply commits alone. A machine whose store was empty at its first start, which is every machine that joins a party, therefore commits the catalog collection by itself: a second lineage of the collection beside the founder's, with the same block id. `docs/architecture.md` → "Control tables are network-backed" names this exact fork as the one `commitEmptyControlCollections` keeps the *table* collections from; the catalog collection is written by the apply, not by that step, and is not covered.

Measured in `control-schema-migration-mixed-releases.integration.ts` (2026-10-21): after founder A and joiner B have formed a party and converged every row, `readBlockIndex` of each store lists `optimystic/schema` at revision 1 under a different action id on A and on B. The peer-join catch-up copies A's catalog blocks into B's store, but B's restart hydrates the lineage B's own header names. So after A migrates:

- B keeps running on the old release, before and after a restart, on its own unmigrated lineage. Rows still cross releases, because rows are stored keyed by column name.
- B migrates its own lineage when it starts on the new release, running the same statements A ran, and reaches the same catalog because the version fixtures fix the statements.
- The optimystic module's adopt-without-writing arms (a change the record already holds) are reached only when two machines share a lineage, which no machine does today. The `newer-release` refusal is reached today only by a machine downgraded after a newer release migrated its own store (review of `control-store-migrates-on-start`).

## Options

**1. Accept one catalog lineage per machine (recommended default; no code).** Each machine migrates its own lineage when it updates; the docs already describe this. Machines on the old release keep working after a restart, which for a phone is better than a refusal. Costs: the catalog is per-machine state in a collection that looks replicated, so any read of `optimystic/schema` through the network transactor while connected could meet the other lineage at the same revision (none has in the suite so far); the adopt arms stay dead paths and the refusal guards only a downgrade; an older machine enforces its own CHECK bodies and column list on its writes until it updates (the mixed-versions bullets in the docs). Reversible: options 2 and 3 can be adopted later without changing what this one shipped.

**2. A joiner adopts the party's lineage at its first connection (Sereus mechanism).** After the quiet period ends, a machine whose catalog lineage was committed alone re-hydrates the catalog from the cohort and, when the party's lineage differs, replaces its own header and blocks with the founder's, or defers its cold-start apply until a connection exists. Gives one catalog per party, so a migration propagates and an old-release machine is refused on restart as `control-store-migrates-on-start` intended. Costs: a new bring-up step that changes the quiet-period invariant or rewrites raw blocks under a running database; the first touch of a table after adoption may write the machine's older description back (Optimystic's `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record`); needs a design pass (`plan/`). The analogous fork for tables a later version adds is `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`.

**3. Optimystic merges identical lineages (upstream).** Two lineages of one collection with the same content would converge on their own. Outside this repo; nothing on Optimystic's board asks for it.

## If nothing is decided

Option 1 is what runs. Nothing breaks: the scenario pins it, and the docs say so.

## Proposed text

For option 1, `docs/architecture.md` → "Every machine migrates its own catalog" stands as written and the question sentence naming this ticket is replaced by: "This is by design: a catalog is the description of the tables a machine runs, and every machine reaches the same description by running the same version's statements." The `newer-release` reason stays, as the guard the upstream module needs against applying an older declaration over a newer lineage.

## Decision (2026-10-21)

Option 1, chosen by the maintainer. `docs/architecture.md` → "Every machine migrates its own catalog" now states one lineage per machine as the design and keeps `newer-release` as the downgrade guard; the comment in `control-schema-migration-mixed-releases.integration.ts` says the same. No code changed.
