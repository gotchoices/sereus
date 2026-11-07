description: The integration test that runs two machines on different control schema releases now builds both releases from the current schema version, so its nodes start; review the change and the renamed test-helper fields.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts, test-harness/control-schema-releases.ts, packages/cadre-core/test/control-store-migration.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts
----
# Mixed-releases scenario: releases built from the current control schema

## What was wrong

`control-schema-migration-mixed-releases.integration.ts` built its `previous` and `next` releases from fixture `v3.qsql` (`CONTROL_SCHEMA_BASELINE_VERSION`). v3 has no `StrandPeer` or `PendingStrandPartyKey` table (the fix ticket also listed `StrandPartyKey`, but v3 does have that one). `CadreNode.start` watches those tables, and `Database.watch` throws on a table the catalog lacks, so A's first `start()` failed with `watch: table CadreControl.StrandPeer does not exist`.

## What changed

- **Scenario**: calls `controlSchemaReleases(CONTROL_SCHEMA_VERSION)` (v4, byte-identical to `schemas/control.qsql` apart from line endings), so `previous` is v4 plus `CadrePeer.Obsolete` and `next` is a v5 that exists only in the test. The header says why: both releases run this build's `CadreNode`, which watches every table of this build's schema at start. The five steps are unchanged.
- **Harness** (`test-harness/control-schema-releases.ts`): the `controlSchemaReleases` parameter and the `ControlSchemaReleases` fields were renamed `baseline` → `base` and `baselineVersion` → `baseVersion`. Under the old names the scenario's step 4 would have asserted `storeVersionOf(B)` equals `releases.baselineVersion` while that value was 4, not the cadre-core baseline (3). The header now states the rule: a release a `CadreNode` starts on must declare every table this build reads, so such suites build from `CONTROL_SCHEMA_VERSION`; a suite that opens only a `ControlDatabase` may build from any fixture from the baseline on. The `next` doc notes that `nextVersion` may exist only in the test.
- **`control-store-migration.spec.ts`**: follows the rename only (`releases.base`, `releases.baseVersion`); it still builds from the baseline (v3), because it never starts a `CadreNode`.
- **`schemaPath` doc comments** (`ControlNetworkConfig` in `types.ts`, `ControlDatabaseConfig` in `control-database.ts`): the option is for tests that vary the schema, and under a node the file must declare every table of this build's control schema.
- **`docs/architecture.md`**: unchanged. Its two mentions of the scenario never said it starts from the baseline.
- `CadreNode.start` is unchanged, as the ticket required.

## Validation run

- `yarn workspace @serfab/cadre-core build`, then `yarn workspace @serfab/integration-tests exec vitest run control-schema-migration-mixed-releases`: 1 passed. The test body ran in 1.8 s and the log has no errors or warnings. That seemed fast for two nodes and three restarts. A reviewer may want to confirm that each `awaitBlockCoverage` and convergence wait is doing real work, not passing trivially.
- `yarn workspace @serfab/cadre-core test control-store-migration control-schema-versions`: 2 files, 10 tests passed.
- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests run typecheck`: clean.
- The full `yarn test` was not run.

## Tests added

None. The change repairs an existing scenario, and that scenario is the check.

## For the reviewer

- Check whether `base`/`baseVersion` reads well in `control-store-migration.spec.ts`'s "from the baseline fixture" case. There the call site passes `CONTROL_SCHEMA_BASELINE_VERSION`, and the local variable is still named `baseline`.
- When `CONTROL_SCHEMA_VERSION` moves to 5, `next` becomes a synthetic v6. The anchors `controlSchemaReleases` replaces (the `CadrePeer`/`ValidationKey` openings, the `OwnerKey.LabelLength` CHECK with its comment line, the version tag, `apply schema CadreControl;`) must still occur exactly once in the new fixture. `replaceOnce` throws with the anchor text if one does not, so that breakage is loud.
