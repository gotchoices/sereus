description: The integration test that runs two machines on different control schema releases now builds both releases from the current schema version, so its nodes start; the shared test helper's fields were renamed to match.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts, test-harness/control-schema-releases.ts, packages/cadre-core/test/control-store-migration.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts
----
# Mixed-releases scenario: releases built from the current control schema

## What was wrong

`control-schema-migration-mixed-releases.integration.ts` built its `previous` and `next` releases from fixture `v3.qsql` (`CONTROL_SCHEMA_BASELINE_VERSION`). v3 has no `StrandPeer` or `PendingStrandPartyKey` table. `CadreNode.start` watches those tables, and `Database.watch` throws on a table the catalog lacks, so A's first `start()` failed with `watch: table CadreControl.StrandPeer does not exist`.

## What changed

- **Scenario**: calls `controlSchemaReleases(CONTROL_SCHEMA_VERSION)` (v4), so `previous` is v4 plus `CadrePeer.Obsolete` and `next` is a v5 that exists only in the test. The file header says why: both releases run this build's `CadreNode`, which watches every table of this build's schema at start. The five steps are unchanged.
- **Harness** (`test-harness/control-schema-releases.ts`): `controlSchemaReleases`'s parameter and the `ControlSchemaReleases` fields were renamed `baseline` → `base` and `baselineVersion` → `baseVersion`, because the value is no longer always the cadre-core baseline. The header states the rule: a release a `CadreNode` starts on must declare every table this build reads, so such suites build from `CONTROL_SCHEMA_VERSION`; a suite that opens only a `ControlDatabase` may build from any fixture from the baseline on.
- **`control-store-migration.spec.ts`**: follows the rename only. It still builds from the baseline (v3), because it never starts a `CadreNode`.
- **`schemaPath` doc comments** (`ControlNetworkConfig` in `types.ts`, `ControlDatabaseConfig` in `control-database.ts`): the option is for tests that vary the schema, and under a node the file must declare every table of this build's control schema.
- `CadreNode.start` and `docs/architecture.md` are unchanged.

## Review findings

Read the diff of `ticket(implement): mixed-releases-scenario-builds-releases-from-current-schema` first, then the full scenario, the harness, the spec call sites, and the docs.

- **Correctness of the fix**: confirmed. The scenario passes (1 test, body 1.8 s). The cadre-core specs `control-store-migration` and `control-schema-versions` pass (10 tests). `control-schema-versions.spec.ts` already requires a fixture for every version up to `CONTROL_SCHEMA_VERSION` and requires the last one to match the declared schema, so `controlSchemaReleases(CONTROL_SCHEMA_VERSION)` always has a fixture to read.
- **Is the 1.8 s run doing real work?** The implementer asked this, so I checked it with a throwaway copy of the scenario that logged the raw block stores. That copy has been deleted. A's store holds 108 blocks at every `awaitBlockCoverage`, so none of the waits passes on an empty source. A's restart under `next` moves 2 blocks from rev 1 to rev 2 while B still holds rev 1, so the migration really writes to A's store. By the time `connectControlNodes(B, A)` returns, B's store already holds both blocks at rev 2, plus A's other newer blocks. So the step 2 catch-up claim is real; it just finishes inside the connection wait. Each coverage wait found no gap on its first poll. They still guard against regressions, because they would time out and name the missing blocks if the catch-up stopped working. No change.
- **Naming (`base` / `baseVersion`)**: reads correctly at both call sites. In `control-store-migration.spec.ts`, "from the baseline fixture" keeps the local name `baseline`. That name is accurate there, because the call site passes `CONTROL_SCHEMA_BASELINE_VERSION`. No change.
- **Step 4's version assertion**: `releases.baseVersion` (4) differs from `releases.nextVersion` (5), so the assertion still tells "B stayed on previous" apart from "B migrated". No issue.
- **Future version bump**: when `CONTROL_SCHEMA_VERSION` goes to 5, `next` becomes a synthetic v6. If a new fixture loses any anchor, `replaceOnce` throws with that anchor's text, so the failure is loud. A comment would add nothing to that, so I left no tripwire.
- **Docs**: `docs/architecture.md` mentions the scenario twice, and neither mention says it starts from the baseline. No doc mentions `test-harness/control-schema-releases.ts` or `schemaPath`. No doc change was needed.
- **Source hygiene (minor, fixed)**: the `ControlSchemaReleases.next` doc comment had a ragged line break left over from the edit. I reflowed it.
- **Tests**: none added and none cut. The repaired scenario is the check, and the implementer added no tests.
- **Error handling, resource cleanup, type safety**: unchanged by the diff. The scenario's `finally` still stops both nodes and removes the temporary schema directory.
- **Validation**: `yarn lint`, `yarn workspace @serfab/cadre-core typecheck` and `yarn workspace @serfab/integration-tests run typecheck` exit 0. The full `yarn test` was not run.
- **Tickets filed**: none. No finding met the filing bar.
