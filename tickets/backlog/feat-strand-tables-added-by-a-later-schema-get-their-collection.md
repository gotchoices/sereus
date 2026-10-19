description: A table that a newer version of an app adds to an existing strand starts with no storage behind it, so until someone writes to it every read has to ask another member and fails while the others are offline; decide who creates its storage when the app's schema is upgraded.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/quereus-plugin-sereus/src/compose-strand.ts (`applyAppSchema`, `createEmptyCollections`), packages/cadre-core/src/strand-database.ts (`attachAppSchema`), schemas/strand.qsql (`Header`, `-- TODO: revisit for versioning`)
tradeoffs: There is no strand schema-versioning design yet, so whatever is chosen here may be redone when one exists, and apps can avoid the cost meanwhile by writing to a new table once when they introduce it.
----

# Tables added by a later app schema version get no collection

`strand-founder-commits-every-table-collection` makes the founder commit an empty storage collection for every table declared at founding, so reads of a table nobody has written are answered locally and work offline. A table that a later app version adds is applied by every member independently, at connect (`applyAppSchema` runs on every node at every bring-up), and its collection does not exist until someone writes to it. Until then:

- every read of it asks the cohort to prove it absent, about two round trips to another member per read (gotchoices/sereus#47 measured 217 ms per read on a 100 ms link, up to 31.7 s on a phone-shaped link);
- with no other member reachable, the read throws `BlockUnavailableError` (`cohort-unreachable`);
- two members that each write to it first, before seeing the other's write, create two histories of one collection, and Optimystic keeps one and drops the other's rows (docs/strands.md, first residual under "Joining").

Eager creation at upgrade was rejected for the founding change: no member is privileged to create, and a member that upgrades while it cannot reach the others would commit an empty collection beside one another member already created and wrote, forking the table even if it never writes.

## What is wanted

A rule for who commits a new table's empty collection when an app's schema version adds one, such that a member that cannot rule out another member having created it never does. Candidates to weigh when strand schema versioning is designed (the `Header` table is insert-only with `-- TODO: revisit for versioning`):

- the member that records the new schema version in the strand (a manager, if versioning is manager-signed) creates the new tables' collections in the same founding-style step, before the version record that lets others use the new tables;
- a member creates it only after a read of it settled "absent" with every other member connected.

Out of scope until there is a versioning design to attach it to.

## The control database has the same gap

`control-collections-created-at-cadre-founding` commits every control table's empty collection at party genesis (`ControlDatabase.ensureOwnerKey`). A table that a later control schema version adds is created by `control-store-migrates-on-start`'s start-time apply, which every machine runs for itself, with no owner key and possibly while alone, so the same rule is needed there: no machine that cannot rule out another having created the collection may commit it. The control schema has a version (`CONTROL_SCHEMA_VERSION`), so a rule chosen for strands may apply to it first.
