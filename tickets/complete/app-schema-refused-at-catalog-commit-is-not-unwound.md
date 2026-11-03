description: An app schema change refused at its closing catalog commit no longer leaves the database on a schema the store never received, so `appSchemaState()` reads `applied` only when the change is saved, and a query through a new index works.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/test/app-schema-deferral.spec.ts, packages/integration-tests/src/scenarios/strand-app-schema-change-while-partner-offline.integration.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/cadre-core/src/control-database.ts, docs/strands.md
----
# A schema apply refused at its catalog commit is unwound

## What landed

The fix is upstream: Quereus 4.25.0 (`apply-schema-unwinds-a-refused-end-batch`) undoes an apply whose `endSchemaBatch` was refused, and Optimystic 1.25.0 refuses it there. Sereus adopted both.

- **The unwind works with the cohort down.** Adding an index, a table or a nullable column, refused at the commit, leaves the earlier schema in place, and a retry saves the change. The concern that Optimystic's `dropIndex` could refuse the undo did not appear in these cases.
- **A refusal that leaves a retry nothing to send is a failure.** After `drop table` or `drop column`, Quereus cannot undo, so the database can hold the whole new schema. `retryableRefusalOf` checks `diff schema App`: when it is empty, the connect throws or a retry settles `failed`. Quereus has no typed "not restored" error, and this avoids reading its message text.
- **The `Strand` and control applies are unchanged in shape.** Neither is deferred. A refused `Strand` apply already failed the connect.

## Behavior to know

**`applied` with the other member offline is real.** On a two-member strand the first retry lands about 15 s after the refusal, because the member has been marked dead and the survivor commits without it. The scenario proves it by restarting B with A still offline: B plans nothing, serves a query through the index and takes a write, and A reads that write when it returns.

## Validation

| Test | Verifies |
| --- | --- |
| `app-schema-deferral.spec.ts`, added index, table and nullable column | earlier schema kept while refused, a retry that is still refused keeps waiting, and a fresh database with writes refusing finds the change in the store |
| `app-schema-deferral.spec.ts`, dropped column | the connect rejects. Fails with the `diff schema` check disabled |
| `strand-app-schema-change-while-partner-offline`, both arms, 3 of 3 runs | the real-network flow above |

## Gaps

- A dropped column refused on the real network was not run; only the unit test covers it. A dropped table was not run at all.
- **Conditional:** a machine migrating its control store with its siblings offline now fails its start once the retries run out, where the old retry reported a false success. No release has migrated yet. `NOTE:` at `applyControlSchema`.
