description: The integration test that runs two machines on different control schema releases builds both releases from an old schema version that lacks tables the current node code reads, so every node start in it fails; build the releases from the current schema version instead.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts, test-harness/control-schema-releases.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts
repro: verified
----
# Mixed-releases scenario: build its releases from the current control schema

## Failure

`control-schema-migration-mixed-releases.integration.ts` fails at A's first `start()` (full `yarn test`, 2026-11-07, `tickets/.logs/adopt-quereus-5-optimystic-1-26.test.log`):

```
QuereusError: watch: table CadreControl.StrandPeer does not exist
 ❯ TableChangeWatcher.subscribe cadre-core/src/table-change-watch.ts:183
 ❯ ControlDatabase.watchTables  cadre-core/src/control-database.ts:4503
```

## Cause

The scenario calls `controlSchemaReleases(CONTROL_SCHEMA_BASELINE_VERSION)`, so both its `previous` and `next` releases are built from fixture `v3.qsql`. v3 has no `StrandPeer`, `StrandPartyKey` or `PendingStrandPartyKey`. Each machine starts with `controlNetwork.schemaPath` pointing at one of those files, so its catalog holds only v3's tables (plus the variant's edits). `CadreNode.start` watches all three tables unconditionally (`strandPartyPeersWatch` and `strandPartyKeyWatch`, `cadre-node.ts` around line 1608), and `Database.watch` throws on a table the catalog does not hold.

## Why the scenario, not `start`, is what changes

Fix-stage research: no real path brings a control database up with a catalog missing a table this build reads.

- `ControlDatabase.loadSchema` (`control-database.ts` ~1529) declares the schema, then `refuseIncompatibleControlStore` either throws (`newer-release`, `before-migrations`, `not-migratable`) or returns, and `applyControlSchema` then applies the declared schema in full or throws after its retries. Every throw fails the start; there is no deferred or skipped apply, unlike the `App` schema's `applyAppSchemaOrDefer`.
- Without `schemaPath` the declaration is this build's embedded schema (v4), which holds every table the code reads.
- `schemaPath` has no caller outside tests (grep of cadre-core, cadre-cli, cadre-host, cadre-provider sources: only `types.ts`, `control-database.ts` and the `cadre-node.ts` pass-through).

So a catalog without `StrandPeer` exists only when a test hands a node a schema file that is older than the code running it. A real older release runs older code, which does not watch those tables. Both of the harness's "releases" run this build's code (its header says so), so each must declare every table this build's code reads: build them from the fixture of `CONTROL_SCHEMA_VERSION` (v4, byte-identical to `schemas/control.qsql` today), making `next` a v5 that exists only in the test.

Checked: every anchor `controlSchemaReleases` replaces occurs exactly once in `v4.qsql` (the `CadrePeer` and `ValidationKey` openings, the `OwnerKey.LabelLength` CHECK with its comment line, the version tag, `apply schema CadreControl;`). `refuseIncompatibleControlStore` takes the build version from the declared schema (`declaredSchemaVersion`), not the `CONTROL_SCHEMA_VERSION` constant, so a v4 store restarted under the v5 `next` migrates, and B restarted under the v4 `previous` on its own v4 lineage starts, as the scenario's steps expect.

`packages/cadre-core/test/control-store-migration.spec.ts` keeps the baseline (v3): it opens a `ControlDatabase` alone, never a `CadreNode`, so nothing watches the v4 tables, and migrating from the oldest migratable version is what it pins.

## Expected behaviour

The scenario passes whole, unchanged in its five steps. Not changed: `CadreNode.start` (no skip or retry for a watched table missing from the catalog; that would hide a misconfigured `schemaPath`).

## TODO

- In the scenario, call `controlSchemaReleases(CONTROL_SCHEMA_VERSION)` instead of `CONTROL_SCHEMA_BASELINE_VERSION` (import `CONTROL_SCHEMA_VERSION` from `@serfab/cadre-core`; drop the baseline import if unused). Adjust the file header's "built ... from the baseline fixture" wording to "from the fixture of this build's control schema version" and say why in one sentence: both releases run this build's `CadreNode`, which watches every table of this build's schema at start.
- In `test-harness/control-schema-releases.ts`, add to the header: a release a `CadreNode` starts on must declare every table this build's code reads, so suites that start a node build from `CONTROL_SCHEMA_VERSION`; a suite that opens only a `ControlDatabase` may build from any fixture from the baseline on. Rename the `controlSchemaReleases` parameter and the `baseline`/`baselineVersion` fields only if the wording now misleads (e.g. to `base`/`baseVersion`, updating `control-store-migration.spec.ts` and the scenario); otherwise leave the names and fix the doc comments (`baseline` currently says "`schemas/control.qsql` as it was at `baselineVersion`", which stays true).
- On `ControlNetworkConfig.schemaPath` (`packages/cadre-core/src/types.ts` ~750) and `ControlDatabaseConfig.schemaPath` (`control-database.ts` ~1310), state in the doc comment that the file must declare every table of this build's control schema, because the node watches and writes them; it is for tests that vary the schema.
- If `docs/architecture.md` (line ~88 or ~90, the mixed-releases mentions) says the scenario starts from the baseline, correct it; today it does not.
- Run the scenario alone, foreground, from `packages/integration-tests` (see `docs/testing.md` for the single-scenario command; the stale-build guard needs current cadre-core `dist` — build this repo's packages only, never the sibling repos), and confirm it passes. Then run `yarn workspace @serfab/cadre-core test control-store-migration control-schema-versions` to confirm the harness edit did not break the cadre-core suites. If the scenario then fails at a later step for a different reason, record it in the review handoff rather than widening this ticket.
