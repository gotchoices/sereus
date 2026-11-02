description: When an app's schema change cannot reach a strand's other member, this machine already runs the new schema in memory and soon reports the change as applied although it was never saved, and queries that use a new index throw until the app restarts. Fixing this properly needs a change in Quereus, which this repository does not own.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/cadre-core/src/strand-app-schema-report.ts, packages/integration-tests/src/scenarios/strand-app-schema-change-while-partner-offline.integration.ts, ../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts (`runBatchedMigrationLoop`), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (`endSchemaBatch`, `markSchemaUnpersisted`)
repro: verified
----
# A schema apply refused at its catalog commit is not unwound

**Blocked: dependency outside this repo. Unblocked by a Quereus release that restores its catalog when `endSchemaBatch` fails after a clean migration loop (the recommended change below), or by a maintainer choosing the Sereus-only alternative.**

## What happens

The fix for gotchoices/sereus#55 lets a strand open while an `App` schema change cannot reach the other member, and retries the change. Its design assumes Quereus unwinds a refused apply, so the database stays on the earlier schema and a retry plans the change again. That holds when a migration step throws, which is how the offline queue refuses.

A cohort refusal usually lands somewhere else. Optimystic coalesces an apply's catalog writes and commits them in `endSchemaBatch`, after every step has already succeeded. Quereus's undo journal runs only when a step fails, so a throw from `endSchemaBatch` passes through with nothing undone. From there:

- The engine's catalog holds the new schema while the store holds the old one.
- A retry's `apply schema` finds no difference and writes nothing, so `appSchema` settles `{ state: 'applied', deferred: true }`.
- `appSchemaState()` then reads `'applied'` and `strand:app-schema-applied` fires, even with the other member still offline.

## Evidence

Measured at Optimystic 1.24.0 and Quereus 4.24.0, on the linked sibling checkouts.

**Real network.** A temporary copy of `strand-app-schema-change-while-partner-offline` used a v2 adding an index and a table, and kept A offline after B's claim. With offline mode off and on, B read `waiting-for-cohort` at 5 s and `applied` at 17 s and 25 s, with A offline throughout. In the offline-off arm an insert on B then succeeded at about 25 s, which docs/strands.md describes: once a run of failed contacts marks a member dead, the remaining member commits without it. So in that arm the cohort refuses only until that point, while a catalog write the engine thinks it already made is still not re-sent.

**Unit.** A spec registered a proxy over the `local` transactor with `collectionFactory.registerTransactor('local:libp2p', proxy)`. The proxy threw `PromiseShortfallError` from `pend` and `commit` while "down". The database was fresh and hydrated from the store, as a restart is. This is a cheaper reproduction than the integration scenario.

| v2 changes | engine right after the refusal | transactor calls during the retry | store after the partner returns |
| --- | --- | --- | --- |
| a column tag | new tag present | 0, settled `applied` | written by the next read of the table |
| a nullable column | new column present | 0, settled `applied` | written by the next read of the table |
| a new table | new table present | 0, settled `applied` | not written by reads or writes of other tables |
| a new index | new index listed | 0, settled `applied` | not written by reads or writes of the table |
| dropped column | column gone | 0, settled `applied` | not measured |

On the `local` transactor, with the cohort down:

- A read of a table with a changed tag or column threw `Module 'optimystic' connect failed … Failed to get super-majority`. On the real network the same read of a tag change succeeded (the #55 scenario), so this was not seen there.
- A query routed through the new index threw `Table 'Note' does not maintain index 'NoteByBody'`, and still threw after the partner returned. Optimystic's `markSchemaUnpersisted` documents this: the engine lists the index, the table does not maintain it, and only a fresh `Database` or a drop and re-create clears it.

## Proposed change (recommended default)

Quereus's `runBatchedMigrationLoop` treats a throw from `endSchemaBatch` after a clean loop as a failed apply. It runs the undo journal inside a new module batch, tolerates a refusal of that batch's own commit (the store already holds the pre-apply state), verifies the catalog against the pre-apply fingerprint, and rethrows the original error. Optimystic drops the index trees it deferred for that apply. This is Quereus's existing "unwind, verify, then end the batch" contract, extended to the last step of the apply.

On the Sereus side `applyAppSchemaOrDefer` then behaves as written. What remains:

- Remove the known-defect `NOTE:` in `app-schema.ts` and the known-defect wording in `docs/strands.md`, the scenario header and the release notes.
- Extend the scenario: v2 adds an index, `appSchemaState()` stays `waiting-for-cohort` past the first retry with A offline, and a query through the index works once B reports `applied`.
- Decide what an irreversible step does here. `deferralOf` walks through Quereus's "schema is partially migrated" wrapper by `cause`, so a refusal after a dropped table or column defers and retries a partly migrated schema. It should probably fail the connect.

## Alternatives considered

- **Optimystic keeps the failed batch as owed work** and commits it when the cohort returns. The engine would honestly run the new schema, and Sereus would wait for a "catalog persisted" signal instead of retrying. This is viable, but it changes the meaning of `waiting-for-cohort` and needs the same treatment for deferred index trees. An app would also use new tables whose records are not saved.
- **Rebuild the strand's database for each retry (Sereus only).** A fresh `Database` hydrates from the store, so each attempt plans the real change. This is the fallback if upstream declines. It swaps the app's database handle and costs a full composition per attempt, and attempts cannot be aimed, as the next item explains.
- **Ask the reachability gate before applying.** Rejected: `KeyNetworkCohortReachability.reachable` answers true after a restart while the partner is offline (its own `NOTE:`), which is exactly this case.
- **Re-apply the previous schema to rewind.** Rejected: Sereus does not hold the previous declaration, and the undo steps would write through the same refused path.
- **Clear the `App` schema and hydrate again.** Rejected: it depends on clearing the Optimystic module's private table-instance cache.

## If nothing is done

The strand still opens, so #55's reported failure stays fixed, and the next connect (restart or hibernation wake) plans from the store and lands the change. Until then an app that trusts `appSchemaState()` is misinformed, and an upgrade that adds an index breaks queries using it on that machine. Nothing here changes a stored format, so any of these choices can be reversed later.
