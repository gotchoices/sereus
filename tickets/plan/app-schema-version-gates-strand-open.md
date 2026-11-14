description: Make every member of a shared workspace run the same version of the app's tables: a member whose app is older than the version the workspace has reached cannot open it until it updates, so an older app can no longer remove a column a newer one added. A stop-gap until app versions can each keep their own view of shared tables.
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: packages/cadre-core/src/types.ts (`SAppConfig`), packages/quereus-plugin-sereus/src/app-schema.ts (`applyAppSchema`, `checkAppSchema`, `applyAppSchemaOrDefer`, `AppSchemaRefusedError`, `appSchemaRefusalOf`), packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts (`AppSchemaOutcome`), packages/cadre-core/src/strand-database.ts (`attachAppSchema`, `appSchemaState`), packages/cadre-core/src/strand-instance-manager.ts (`attachSApp`, the refusal suppression), packages/cadre-core/src/cadre-node.ts (`suppressIfAppSchemaRefused`), packages/cadre-core/src/control-schema-version.ts (the control database's version tag and `newer-release` refusal: the model), packages/reference-app-rn, packages/reference-app-web, packages/reference-app-ns (their `SAppConfig`s), docs/strands.md, docs/schema-guide.md
----

# The strand's app schema version gates opening it (gotchoices/sereus#59)

The decision and the rules are in docs/strands.md → "App schema versions across a strand's members". In short: `SAppConfig.schemaVersion` is an integer the app raises with every `App` schema change. The strand records the highest version applied. A lower version is refused at connect and not retried; the same version applies its diff; a higher one applies and records. A member already running stops writing app tables when a higher version is recorded. The long-term mechanism (Quereus lenses) is backlog `feat-app-schema-migration-through-lenses` and out of scope here. A versioned network name was rejected (the doc says why).

## Reproduction

The reporter's script in gotchoices/sereus#59 (`PHASE=column`): A re-opens on a schema with an added nullable column, then B re-opens on the old schema and fails with `Failed to get super-majority`, and the drop it attempted cannot be undone. With this change, if B's config carries the lower `schemaVersion` it must fail with the typed version refusal before any DDL runs, and A must keep the column and its values.

## What the plan must settle

- **Where the version is recorded** so that every member reads the same value and it replicates with the catalog: a tag Sereus owns (the control database uses a tag on `OwnerKey`, `sereus.controlSchemaVersion`). The `App` schema has no table Sereus owns, and a tag on a `Strand` table would be removed by the next `apply schema Strand` diff unless it is declared. Record it in the same commit as the schema change, so a reader never sees the new schema under the old version or the reverse.
- **How a running member learns of a higher version**, and what "stops writing app tables" does: close the app database with the refusal, or fail each write. The candidates are a catalog change event, or a check at each transaction.
- **Whether `schemaVersion` is required.** The project takes no backwards compatibility yet. Required makes every config state it. Defaulting it hides a forgotten bump.
- **Whether the author's signature covers `schemaVersion`.** If it does not, a host can give a signed schema any version, including one that locks other members out.
- **The typed refusal.** A refusal kind or subclass the app can branch on ("update the app"), that `appSchemaRefusalOf` still finds and that cadre-core's launch suppression treats as not retryable. It should name both versions.

## Edge cases & interactions

- A strand with no recorded version, which is every existing strand: the first apply records it. Members on Sereus 1.23.0 or earlier keep today's full diff and are not gated. The release notes must say so.
- Equal version, different schema text (a developer iterating): today's behaviour, full diff.
- The same machine downgraded: refused like any lower version.
- A deferred apply (`applyAppSchemaOrDefer`, waiting for the queue or the cohort) while another member records a higher version: the retry must re-check the version rather than apply.
- Offline mode: transactions queued under the lower version that drain after a higher version is recorded. Rows are keyed by column name, so an insert lands with the new columns null, but an update rewrites the row without them. Decide whether the queue is held, and test it if it is.
- A storage replica (a cadre node with no app claiming the strand) has no app version. It must keep replicating whatever the members write.
- A claim on a live or hibernating replica (`attachSApp`) at a lower version: refused like a connect, leaving the replica as it was (docs/strands.md, "A refused claim leaves a storage replica as it was").
- The three reference apps declare a `schemaVersion`, and their docs say when to raise it.

## Tests that pay

- The reproduction above, at the lowest layer that shows it: two members, a higher version adds a nullable column, and a lower version is refused before any DDL runs while the column and its values survive.
- A running member at the lower version stops writing app tables once the higher version is recorded.
