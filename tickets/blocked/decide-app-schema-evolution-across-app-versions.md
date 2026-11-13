description: When one member of a shared workspace updates its app and the new version adds a column, a member still on the old version can no longer open the workspace, because opening it tries to remove the column the old version does not know about. If that removal were ever accepted, the newer version's column and its data would be gone for everyone. Sereus has no rule for how an app's tables may change between versions; this proposes one.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort
files: packages/quereus-plugin-sereus/src/app-schema.ts (`applyAppSchema`, `applyOutsideOpenTransaction`, `retryableRefusalOf`), packages/quereus-plugin-sereus/src/compose-strand.ts, packages/cadre-core/src/control-schema-version.ts (`classifyControlSchemaChange`, the control database's version check, the model for this one), docs/strands.md, docs/architecture.md ("Schema version", "Mixed versions in one party")
repro: static
----

# Decide how an app's `App` schema may change between app versions (gotchoices/sereus#59)

**Blocked: the specification is silent.** Unblocked by a maintainer accepting or editing the rule under *Proposed text*.

## What happens today

Every time a machine opens a strand, it runs `declare schema App { <the app's schema> }` then `apply schema App` (`applyAppSchema` in quereus-plugin-sereus). `apply schema` is a full declarative diff: it makes the stored catalog equal the declaration, including dropping any table, column or index the declaration lacks.

So with two members on different app versions:

1. Version 1.1 adds a nullable column `Nick` to `App.Contact`. Its members apply that, and rows converge both ways. A member still on 1.0 reads and writes without the column.
2. The 1.0 member restarts. Its apply computes `alter table App.Contact drop column Nick` and tries to commit it.
3. On a two-member strand the 1.1 member does not approve the catalog write, so the commit fails (`Failed to get super-majority: 1/2 approvals`). Quereus cannot undo a dropped column, so the in-memory catalog is left without `Nick` while the store still has it. `retryableRefusalOf` counts that as a failure, and the strand does not open on that machine.

The reporter's script reproduces it with and without offline mode. A control run where neither member adds the column opens fine.

**Worse when the drop is approved.** Nothing stops the drop from committing when the members whose approval it needs are the older version's own: a party with several 1.0 machines, or a moment when the newer member is marked dead (a two-member strand commits alone after the other member is marked dead; docs/strands.md, "A retry can land with the other member still offline"). Then `Nick` and its values are dropped from the strand for every member. Not run; inferred from the apply path.

Quereus's `docs/migration.md` describes the intended pattern for sharing one database across app versions: each version keeps its own logical schema and lens locally, over a shared basis that evolves additively only. The reporter showed that lenses over `App` work on a strand. Only the basis apply breaks the pattern.

## Proposed text (recommended)

For docs/strands.md, a new section "An app version older than the strand's schema":

> Each strand records the version of the app that last applied its `App` schema, as a tag on the strand's catalog (`sereus.appSchemaVersion`, the app's `SAppConfig.version`, compared as semver). A connect whose app version is **older** than the recorded one applies nothing: the strand opens on the stored schema, which a newer version wrote, and `appSchemaState()` reads `'older-app'`. An older app keeps working on the tables and columns it knows, because a column a newer version added must be nullable or carry a default for the older version's inserts to succeed. A connect at the **same or a newer** version applies its full diff, as today, and records its version.
>
> A version that adds a table, column or index changes the strand for every member at once, older ones included. A version that drops one removes it for every member, older ones included, so an app that wants older versions to keep working only adds, as Quereus's `migration.md` recommends, and maps removals in its lens.

This mirrors the control database's `newer-release` rule (docs/architecture.md, "Schema version"), but opens the strand instead of refusing it. An older app opening a strand that a newer one migrated is the normal state while members upgrade, not a downgrade.

Consequences to accept with it:

- Strands written before this ships carry no version. The first apply after it records one, so the protection starts at each strand's next connect on the new Sereus. A machine still on Sereus 1.22 or earlier keeps today's full diff.
- `SAppConfig.version` must parse as semver. Today it is free text, so a version that does not parse would be refused at connect.
- Two builds of an app under the same version string with different schemas still fight over the catalog, as today. That is a developer workflow, not a deployed state.
- A newer version that drops a column takes it from older members too. That is the app developer's explicit choice, made by shipping the drop.

## Alternatives rejected

- **Additive-only apply, whatever the version** (the reporter's ask (a)). The apply would run only the `additive` and nullable-column statements of the diff (the classification `classifyControlSchemaChange` already makes for the control schema) and skip every drop. It fixes the reported case and needs no version, but then no app version can ever drop or rename anything through its schema, and a removal needs a separate "retire" API that does not exist. An older version would also re-create a table a newer version deliberately dropped. Choose this only if versions in `SAppConfig` should not carry meaning.
- **Refuse an older version outright**, as the control database does. Safe for data, but it leaves an un-upgraded member unable to open the strand, which is the failure #59 reports.
- **Document "upgrade every member together"** and change nothing. Members are separate people on separate phones and cannot upgrade together, and a drop that does get approved loses data.

## If nothing is decided

The reported failure stays: whoever upgrades first locks every older member out of the strand until they upgrade, and a drop that gets approved removes the newer version's data for everyone.

## Reversibility

Storing a version tag is a catalog change that a later decision can ignore. The behaviour is reversible in later releases. Data dropped by an approved drop cannot be recovered.

## Also raised in #59, not part of this decision

- **A materialized view over a strand table is maintained only for local writes.** Rows arriving from another member are never derived into it. That is gotchoices/optimystic#58, filed by the same reporter; nothing to do here until it is fixed.
- **`create materialized view … as …` inside `declare schema` is refused.** Sereus refuses any declaration item the Quereus parser skipped (`assertNoIgnoredItems`), and the parser accepts `materialized view … as …` there, not the `create` form shown in Quereus's `docs/migration.md`. That is a Quereus documentation fix.
