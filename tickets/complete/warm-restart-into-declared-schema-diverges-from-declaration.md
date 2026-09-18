description: A warm restart of an existing control database or strand used to fail because three separate upstream bugs made the schema-reconciliation step run the wrong migration; all three are fixed upstream and confirmed by three independent test passes, with no sereus code change needed.
files:
  - packages/cadre-core/test/control-database-solo-warm-start.spec.ts, control-database-solo.spec.ts, control-database-offline-peers.spec.ts, control-start-storage-op-budget.spec.ts, discovered-strands-late-subscriber.spec.ts, strand-membership-writer.spec.ts, strand-transactor-handover.spec.ts
  - packages/cadre-cli/test/one-shot-node.spec.ts
  - packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, strand-two-party-two-machine.integration.ts
  - packages/quereus-plugin-sereus/src/compose-strand.ts (hydrate, then `apply schema` — unchanged)
----

# What was wrong

Since optimystic `6302f2e8`, a warm restart loads each stored table back into the schema it was declared in, and `apply schema` compares the declaration against the loaded tables to compute a migration. Three upstream bugs made that migration wrong:

- **A. Type aliases read as a type change (quereus differ).** `int` vs. stored `INTEGER` produced a spurious `ALTER COLUMN … SET DATA TYPE`, which optimystic refuses. Fixed by quereus `561195502` (v4.19.4).
- **B. CHECK constraints and `with context` lost on reload (optimystic catalog).** The differ re-added CHECKs without their context variables; first insert failed on `context.ManagerKey isn't a column`.
- **C. Stale connection arguments restored on reload (optimystic catalog).** A table written under `transactor = 'local'` came back that way even when the session declared `'network'`.

B and C were fixed by optimystic `0-warm-restart-restores-a-table-that-disagrees-with-its-declared-schema` (review `06a938ed`); follow-ups `1-optimystic-catalog-record-canonical-list-order` and `2-optimystic-alter-add-check-persists` also landed. No sereus code changed and no workaround was added.

# Verification

Three passes, all against `../quereus` `b972dc976` and `../optimystic` `bf8b7a3a`:

- Pass 1 (fix stage): the seven cadre-core specs 44/44, cli spec 7/7, two integration scenarios 4/4, full `@serfab/cadre-core` suite 2213 passed / 1 skipped / 0 failed.
- Pass 2 (implement stage): same targeted specs, same results.
- Pass 3 (review stage): same targeted specs — cadre-core 7 files / 44 tests, cadre-cli 7/7, integration 2 files / 4 tests — all green; `yarn lint` exit 0.

The eleven `.pre-existing-known.md` entries for this slug were removed in the fix stage (commit `469dea99`).

## Review findings

- **Diff reviewed:** implement commit `69f50726` and fix commit `469dea99` touch only ticket files and `tickets/.pre-existing-known.md` — no source, test, or doc change to scrutinize for SPP/DRY/type-safety/resource-cleanup. Nothing to find in those categories because there is no code.
- **Known-failures ledger:** checked that all eleven entries removed from `.pre-existing-known.md` correspond exactly to the tests re-run here; each passes. The remaining neighbouring entry (`strand-solo-write-budget`, a different slug) was correctly left in place.
- **Leftover workarounds:** grepped `packages`, `docs`, `schemas` for `SET DATA TYPE`, `ManagerKey isn't`, and this slug — no hits, so no temporary workaround remains to remove.
- **Docs:** `docs/architecture.md` describes the warm-restart flow (hydrate, then apply schema in `composeStrand`); that description is still accurate since no sereus behaviour changed. No doc update needed.
- **Tests:** no new sereus test added — the existing warm-restart specs listed above are the regression coverage for all three upstream bugs, and the upstream fixes carry their own tests in quereus/optimystic.
- **Tripwires / new tickets:** none; no major or conditional findings.
