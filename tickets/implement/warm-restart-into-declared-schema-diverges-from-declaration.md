description: Reopening an existing control database or strand used to fail, because the declared schema was compared against the stored tables and three upstream bugs turned that comparison into a broken migration. All three are now fixed upstream; this ticket confirms the restart tests pass and closes the issue out.
files:
  - tickets/.pre-existing-known.md (this ticket's 11 lines already removed)
  - packages/cadre-core/test/control-database-solo-warm-start.spec.ts, control-database-solo.spec.ts, control-database-offline-peers.spec.ts, control-start-storage-op-budget.spec.ts, discovered-strands-late-subscriber.spec.ts, strand-membership-writer.spec.ts, strand-transactor-handover.spec.ts
  - packages/cadre-cli/test/one-shot-node.spec.ts
  - packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, strand-two-party-two-machine.integration.ts
  - packages/quereus-plugin-sereus/src/compose-strand.ts (hydrate, then `apply schema` — unchanged)
difficulty: easy
repro: verified
----

# What was wrong

Since optimystic `6302f2e8`, a warm restart loads each stored table back into the schema it was declared in. `apply schema` then compares the declaration with those loaded tables and runs whatever migration the comparison produces. Three upstream bugs made that migration wrong:

- **A. Type aliases read as a type change (quereus differ).** A column declared `int` was compared by spelling against its stored logical type `INTEGER`, so an unchanged column produced `ALTER COLUMN … SET DATA TYPE int`, which the optimystic module refuses. Fixed by quereus `561195502` (compares logical types; released in v4.19.4).
- **B. CHECK constraints and `with context` lost on reload (optimystic catalog).** The stored table record kept neither, so the differ re-added the CHECKs without the context variables they read, and the first insert failed on `context.ManagerKey isn't a column`.
- **C. Stale connection arguments restored on reload (optimystic catalog).** A table written under the local transactor came back with `transactor = 'local'` even when the new session declared `'network'`, and read empty.

B and C were fixed by optimystic `complete/0-warm-restart-restores-a-table-that-disagrees-with-its-declared-schema` (review `06a938ed`): the catalog record now stores CHECKs, foreign keys, context variables and declared type spellings, and hydrate drops `transactor`/`keyNetwork`/`networkName`/`port`/`cache` and takes them from the current session. The follow-up the blocked ticket asked to watch (catalog bytes depending on declaration order, and a CHECK added by a later schema version not being stored) has also landed upstream: optimystic `complete/1-optimystic-catalog-record-canonical-list-order` and `complete/2-optimystic-alter-add-check-persists`.

No sereus code changed and none worked around the bugs (searched `packages`, `docs`, `schemas` for the failure strings and this slug: no hits).

# Verification done in the fix pass (2026-09-17)

Built `../quereus/packages/quereus` (at `b972dc976`, v4.19.4, contains `561195502`) and `../optimystic` (`yarn build` at `bf8b7a3a`), then:

- The seven cadre-core spec files listed under `files:`: 7 files, 44/44 passed (`tickets/.logs/warm-restart-into-declared-schema.core.log`).
- `yarn workspace @serfab/cadre-cli vitest run test/one-shot-node.spec.ts`: 7/7 passed, including both `cadre strand remove` cases (`….cli.log`).
- The two integration scenarios: 4/4 passed (`….integration.log`).
- Full `yarn workspace @serfab/cadre-core test`: 135 files, 2213 passed, 1 skipped, 0 failed (`….core-full.log`). This includes `control-start-storage-op-budget`, whose warm restart had last been seen tripping the spec's lower floor (13 ops).

The 11 lines in `tickets/.pre-existing-known.md` that pointed at this ticket were removed.

# TODO

- Re-run the seven cadre-core spec files, the cadre-cli spec and the two integration scenarios once more against the current upstream builds (rebuild `../quereus/packages/quereus` and `../optimystic` first if the stale-build guard complains). If any fails, identify the failure by its message before attributing it; a recurrence of the `SET DATA TYPE`, `context.ManagerKey` or empty-handover fingerprints is a regression of the upstream fixes above.
- Confirm `tickets/.pre-existing-known.md` has no remaining line for this slug.
- Hand off to review. No code or doc change is expected.
