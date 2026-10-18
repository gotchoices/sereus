description: To upgrade a party's shared control database in place when a phone updates the app, Sereus needs the database library under it to accept three kinds of table change it refuses today (adding an optional column, removing a column, removing a check rule) and to keep a table's tags across a restart. Needs a change in Optimystic.
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (`alterTable` ~4673-4707, `addCheckConstraint` ~4717-4748, the `table_modified` listener ~3998-4008 and `followTags` ~1153, the catalog tree's options ~4024-4033; read only), ../optimystic/packages/quereus-plugin-optimystic/src/schema/row-codec.ts (`encodeRow`/`decodeRow` ~43-84, `denormalizeValue` ~262; read only), ../optimystic/packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`storeStoredSchema` ~842-869; read only), ../optimystic/tickets/backlog/bug-optimystic-table-tag-changes-lost-on-restart.md, ../quereus/packages/quereus/src/schema/schema-differ.ts (the `ALTER TABLE` statements `apply schema` emits ~3257-3327, with their undo steps; read only)
----

# Optimystic: the table alterations Sereus's control-store migrations need

**Blocked on a dependency outside this repo.** Unblocks when an Optimystic release ships the changes proposed below in a version Sereus can adopt. Read at Optimystic `a47731fb` (`@optimystic/quereus-plugin-optimystic` 1.15.0); recheck the cited sites after a bump.

GitHub gotchoices/sereus#46. The maintainer decided (2026-10-15) that a change to the control schema is applied to each machine's existing control store when that machine starts on the new release, instead of the party being recreated, because phones receive an app update one at a time. `implement/control-store-migrates-on-start` is the Sereus side and waits on this ticket.

**Upstream status (Optimystic main `0e71ee38`, unreleased).** Filed as Optimystic `2-catalog-only-alter-table` with `1-bug-optimystic-table-tag-changes-lost-on-restart` as its prereq. The tag persistence fix and catalog-only DROP CONSTRAINT for CHECK are done and reviewed. ADD nullable COLUMN and DROP COLUMN (Optimystic `implement/2.1`) are coded on main but not yet reviewed. Unblock only after a release that includes all of them.

**Quereus constraint.** Quereus's schema differ emits `create index` before the `add column` that index depends on, in both the memory and Optimystic modules, so one apply that adds a column and indexes it fails. Until Quereus orders these correctly, a control-schema version may not add a column and an index on it together. Either the migratability spec refuses that combination, or the index ships in the following version. This needs a Quereus ticket. Optimystic will not work around it.

## What Sereus needs to do

On a warm start `ControlDatabase.loadSchema` runs `apply schema CadreControl`, which diffs the declared schema against the catalog it hydrated and runs the difference as DDL. Between consecutive control-schema versions the difference is limited (enforced in Sereus by `implement/control-schema-versions-stay-migratable`) to:

- `create table`, `create index`, `drop index` (supported today);
- `alter table … add constraint <name> check (…)` (supported today);
- `alter table … set tags (…)` (runs, but is not saved; see 1);
- `alter table … add column <name> <type> null`, with no default, no generated expression and no inline constraint;
- `alter table … drop column <name>`, for a column in no index and not in the primary key;
- `alter table … drop constraint <name>`, for a CHECK constraint. A changed CHECK body is emitted by the differ as this drop followed by an add.

## What the plugin does today

- **Rows are name-keyed.** `RowCodec.encodeRow` stores a row as a JSON object keyed by column name and `decodeRow` reads each catalog column by name, turning a missing field into null (`denormalizeValue`, `if (value === null || value === undefined) return null`). A field with no column is ignored. So neither adding a nullable column nor removing a column needs any stored row rewritten, and a row written under either catalog reads under the other.
- **The three alterations are refused.** `alterTable` throws `Module for table '…' does not support ALTER TABLE ADD COLUMN` / `ALTER TABLE DROP COLUMN` / `ALTER TABLE DROP CONSTRAINT` (`StatusCode.UNSUPPORTED`).
- **Tag changes are not saved.** Quereus applies `set tags` to its own catalog and never calls the module; the plugin's `table_modified` listener only follows `optimystic.network_watch`. A later `add constraint` rewrites the record from the stored catalog, so it does not save them either. This is Optimystic's own `backlog/bug-optimystic-table-tag-changes-lost-on-restart.md`. Sereus records the control-schema version as a tag on its `OwnerKey` table, so today a store keeps the version it was created under.
- **The catalog is replicated.** The catalog tree `tree://optimystic/schema` is opened with the table's transactor, which for the control tables is the network transactor, so a catalog change one machine makes is what the party's other machines hydrate.

## Proposed change in Optimystic (the recommended default)

1. **Save table tag changes** to the table's catalog record, and keep the current tags whenever another statement rewrites the record. This is the backlog ticket above.
2. **Three catalog-only `alterTable` arms**, each written to the table's catalog record inside the open `beginSchemaBatch`/`endSchemaBatch` pair, so it commits with the rest of the apply. None rewrites a row:
   - **ADD COLUMN** of a column that is nullable with no DEFAULT, no GENERATED expression and no inline constraint. Existing rows read null for it. Anything else stays refused as today.
   - **DROP COLUMN** of a column in no index and not in the primary key. Rows keep the field, which is now ignored on read and dropped the next time the row is rewritten. A later ADD COLUMN under the same name would read those old values again. Sereus never reuses a dropped name, but the plugin should document the behaviour or refuse the re-add.
   - **DROP CONSTRAINT** of a CHECK constraint.
3. **Reversible inside a failed apply.** Quereus unwinds a failed `apply schema` by running each step's undo (`dropAddedColumn`, `droppedColumn`, `readdConstraint` in `schema-differ.ts`). Each new arm needs to go through the plugin's ordinary hooks when it runs as an undo step, as `create table`/`drop table` already do. A DROP COLUMN's undo re-adds the column, and because rows kept the field, their values come back.
4. **Applied twice, it changes nothing.** Two machines of one network can start on the new release at about the same time and run the same alteration. If the stored record already holds the change, a machine whose own catalog has not caught up must not fail permanently. Either the arm finds the record already matching and writes nothing, or it fails with an error Sereus's schema-init retry can classify as transient, and running the apply again succeeds.

## Alternatives rejected

- **Copy each changed table into a new collection and switch to it** (`create table … using optimystic('<new uri>')`, copy, drop, re-create over the new URI). Every copied row re-runs its insert CHECKs, which verify an owner signature passed as write context. `ValidationKey`, `Strand`, `StrandPartyKey` and `JoinedStrand` rows do not store that signature, so they cannot be copied without an owner's key. An `OwnerKey` copy also needs its signer to be an owner already, so those rows would have to be replayed one transaction at a time, in the order they were seated. Machines still on the old release would also keep writing the old collection, so during a staggered update the two halves of the party would stop seeing each other's writes.
- **A period in which new builds read both the old and the new tables.** Same split of writes, and every reader does double the work.
- **Additive-only schema changes.** Declined by the maintainer on #46.

## If nothing changes

Every release that changes an existing control table keeps requiring each party to delete its control store on every machine and found the party again (`docs/architecture.md` → "Recreating a control store"). That loses every owner key row, every machine row, and the read secrets of the party's own closed strands.

## Reversibility

All four changes only add support. Callers that never issue these statements see no difference, and the new arms touch only the catalog record.
