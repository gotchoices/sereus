description: A node whose control schema predates version 4 fails its start with `watch: table CadreControl.StrandPeer does not exist`, because cadre-node now watches `StrandPeer`, `StrandPartyKey` and `PendingStrandPartyKey` unconditionally; the mixed-releases migration scenario fails on it.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/table-change-watch.ts, test-harness/control-schema-releases.ts, packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts
repro: verified
----
# Control start watches tables an older control schema does not have

## Failure

`control-schema-migration-mixed-releases.integration.ts` fails 252 ms into the run, in the full `yarn test` of 2026-11-07 (`tickets/.logs/adopt-quereus-5-optimystic-1-26.test.log`):

```
QuereusError: watch: table CadreControl.StrandPeer does not exist
 ❯ subscriptionFromChangeScope  quereus/src/runtime/delta-executor.ts:386
 ❯ Database.watch               quereus/src/core/database.ts:3126
 ❯ TableChangeWatcher.subscribe cadre-core/src/table-change-watch.ts:183
 ❯ ControlDatabase.watchTables  cadre-core/src/control-database.ts:4503
```

## Cause

The scenario boots machines with `controlNetwork.schemaPath` set to the harness's `previous` release, built from the baseline fixture `v3.qsql` (`CONTROL_SCHEMA_BASELINE_VERSION = 3`). v3 has no `StrandPeer`, `StrandPartyKey` or `PendingStrandPartyKey`. `CadreNode` start subscribes to all three (`strandPartyPeersWatch`, added in `2164680c` `strand-peer-rows-and-sibling-binding`; `strandPartyKeyWatch`, added in `b1cb4c17` `machine-removal-rotates-party-member-key`, both 2026-11-03 evening). `Database.watch` refuses a table the catalog does not hold.

The bump to Quereus 5.0.0 / Optimystic 1.26.0 is not the cause: the same throw is at the same place in Quereus v4.25.0 (`delta-executor.ts:382`), and the two commits came after the last green integration run (the 1.21.0 gate, 2026-11-03 06:04). No integration run happened between them and this one.

## Decide in the fix stage

Which side is wrong:

- **The scenario's premise.** Both "releases" run this build's code (`control-schema-releases.ts` header). A real older release runs older code, which does not watch these tables, and this build always applies schema v4 before the watches. If so, the harness's `previous` must carry what this build's code reads (build it from v4, or add the v4 tables to the v3 variant) and the header must say so.
- **Start itself.** If any real path brings up a control database whose catalog lacks a table this build watches (a start-time apply that is deferred or refused without failing the start, for one), the watch must skip or retry a table not yet in the catalog, not fail the start. Check `applyControlSchema` and the `newer-release` refusal for such a path before choosing the first option.

## Test

The scenario passes whole. If start is changed, a cadre-core spec that starts a node on a schema without `StrandPeer` and asserts the start succeeds and the watch begins once the table appears.
