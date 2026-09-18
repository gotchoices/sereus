description: A warm restart of an existing control database or strand used to fail because three separate upstream bugs made the schema-reconciliation step run the wrong migration; all three are now fixed upstream and confirmed fixed by two independent test passes.
files:
  - packages/cadre-core/test/control-database-solo-warm-start.spec.ts, control-database-solo.spec.ts, control-database-offline-peers.spec.ts, control-start-storage-op-budget.spec.ts, discovered-strands-late-subscriber.spec.ts, strand-membership-writer.spec.ts, strand-transactor-handover.spec.ts
  - packages/cadre-cli/test/one-shot-node.spec.ts
  - packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, strand-two-party-two-machine.integration.ts
  - packages/quereus-plugin-sereus/src/compose-strand.ts (hydrate, then `apply schema` — unchanged, no sereus code touched)
difficulty: easy
----

# What was wrong

Since optimystic `6302f2e8`, a warm restart loads each stored table back into the schema it was declared in, and `apply schema` compares the declaration against the loaded tables to compute a migration. Three upstream bugs made that computed migration wrong:

- **A. Type aliases read as a type change (quereus differ).** `int` vs. stored logical type `INTEGER` produced a spurious `ALTER COLUMN … SET DATA TYPE int`, which optimystic refuses. Fixed by quereus `561195502` (compares logical types; released v4.19.4).
- **B. CHECK constraints and `with context` lost on reload (optimystic catalog).** The stored table record dropped both, so the differ re-added CHECKs without their context variables, and the first insert failed on `context.ManagerKey isn't a column`.
- **C. Stale connection arguments restored on reload (optimystic catalog).** A table written under `transactor = 'local'` came back with that value even when the new session declared `'network'`.

B and C were fixed by optimystic `complete/0-warm-restart-restores-a-table-that-disagrees-with-its-declared-schema` (review `06a938ed`). Two related follow-ups this ticket's predecessor flagged as open have also since landed: `complete/1-optimystic-catalog-record-canonical-list-order` and `complete/2-optimystic-alter-add-check-persists`.

No sereus code changed and no workaround was added for any of these three bugs (`packages`, `docs`, `schemas` were searched for the failure strings and this ticket's slug — no hits, confirmed again in this pass).

# Verification (two independent passes)

**Pass 1 (2026-09-17, fix stage).** Built `../quereus` at `b972dc976` (v4.19.4) and `../optimystic` at `bf8b7a3a`, then ran the seven cadre-core spec files (7/7 files, 44/44 tests), the cadre-cli spec (7/7), the two integration scenarios (4/4), and the full `@serfab/cadre-core` suite (135 files, 2213 passed, 1 skipped, 0 failed — this includes `control-start-storage-op-budget`, whose warm restart had previously tripped the spec's lower op-count floor).

**Pass 2 (2026-09-17, this implement stage, re-verification only — no code changed).** Same upstream commits (`../quereus` still at `b972dc976`, `../optimystic` still at `bf8b7a3a`; `../optimystic` had one uncommitted tickets-only change, no source diff). Re-ran:

- The seven cadre-core spec files: 7/7 files, 44/44 tests (`tickets/.logs/warm-restart-into-declared-schema.core.log`).
- `@serfab/cadre-cli` `test/one-shot-node.spec.ts`: 7/7 (`….cli.log`).
- The two integration scenarios: 2/2 files, 4/4 tests (`….integration.log`).

Zero occurrences of the `SET DATA TYPE`, `context.ManagerKey`, or empty-handover fingerprints in either pass.

`tickets/.pre-existing-known.md` has no remaining entry for this ticket's slug (confirmed by grep in both stages).

# Suggested review focus

- This ticket made no code or doc changes — the "diff" to review is the verification methodology and log evidence above, not a patch.
- If a reviewer wants a third data point, re-running the same seven cadre-core spec files plus the cli spec and the two integration scenarios takes under three minutes total and needs no rebuild if `../quereus` and `../optimystic` are still at the commits named above (stale-build guard will complain and tell you if not).
- No known gaps: both verification passes are full green with matching upstream commits and independent log files.
