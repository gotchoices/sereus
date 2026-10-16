description: A node restarting on a control store written under a different control schema now stops before changing anything and throws one recognisable error, instead of a raw database error that varied by release or, for an older build on a newer store, silently deleting tables (GitHub #46).
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts (new: error, check, additive classifier), packages/cadre-core/src/control-schema.ts (version constant and tag, declaration/apply split, `controlSchemaFileDeclaration`), schemas/control.qsql (`OwnerKey` tag), packages/cadre-core/src/control-database.ts (`loadSchema`, new `applyControlSchema`, `readSchemaFile`), packages/cadre-core/src/control-write-retry.ts (comment on `RETRIABLE_SCHEMA_INIT_MATCHERS`), packages/cadre-core/src/index.ts, packages/cadre-core/test/control-store-incompatible.spec.ts (new), packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-schema-apply-unwind.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, docs/architecture.md, tickets/plan/control-schema-versioned-migrations.md, tickets/plan/2-owner-grant-separate-from-machine-invitation.md
repro: verified
----

# Review: control store from another release fails with a typed error

## What changed

On every start `ControlDatabase.loadSchema` now runs three steps where it used to run one `exec` of the whole schema:

1. `declare schema CadreControl { … }` alone (no DDL runs).
2. `refuseIncompatibleControlStore(db, partyId)` (`control-schema-version.ts`). On a cold store (the hydrated catalog lists no `CadreControl` table) it returns at once. On a warm store it reads the store's version from the hydrated `OwnerKey` table's `sereus.controlSchemaVersion` tag (absent = 0), reads the build's version from the declared `OwnerKey` table's tag, runs `diff schema CadreControl`, parses each DDL row with Quereus's `Parser`, and throws `ControlStoreIncompatibleError` when the store's version is above the build's or any statement is not `createTable`, `createIndex` or `alterTable` with a `setTags` action.
3. `applyControlSchema()`: the old retry comment plus `lockedWithRetry(() => exec('apply schema CadreControl;'), SCHEMA_INIT_RETRY_POLICY, 'schema-init')`. Split out of `loadSchema` so the retried body is just the apply, and so `control-write-retry.spec.ts` can drive it over a stubbed `exec` as before.

`CONTROL_SCHEMA_VERSION = 1` and `CONTROL_SCHEMA_VERSION_TAG` live in `control-schema.ts` and are interpolated into the embedded text; `schemas/control.qsql` carries the literal `1` (the drift spec keeps the two identical). `CONTROL_SCHEMA` is now `CONTROL_SCHEMA_DECLARATION + APPLY_CONTROL_SCHEMA`. A `schemaPath` file is parsed by `controlSchemaFileDeclaration`, which refuses anything but one `declare schema CadreControl` plus one plain `apply schema CadreControl` and returns the declaration's source text sliced by its AST location.

`ControlStoreIncompatibleError` (exported from cadre-core with `CONTROL_SCHEMA_VERSION`) carries `partyId`, `storeVersion`, `buildVersion`, `pendingDdl` and `storageScope` (`controlStorageScope(partyId)`). No `cause`, by design: the refusal happens before Quereus runs anything. Its message names the direction ("created by a newer/older release", or "under the same control schema version") and the storage scope, not the DDL. `CadreNode.start()` and cadre-rn's `PhoneNode` pass it through unchanged (not re-tested here; the ticket established it by reading the code).

`docs/architecture.md`: the old one-paragraph recreate policy became the section "Control schema changes and incompatible stores" (what applies to a warm store, the version and bump rule, the check, the three-step recreate procedure, what is lost and what survives).

## Departure from the ticket's design: the stored version does not move on an additive upgrade

The ticket expected an additive upgrade to raise the stored tag in the same apply. It does not persist: Quereus applies `alter table … set tags` to its own catalog without calling the module, and the optimystic plugin follows tag changes in memory only (`followTags` in `../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts`, used for its network-watch tag). Measured: a store created with no tag, started under a schema with an extra table and version 2, read version 0 on the next start. So the stored tag is the version the store was created under.

The check does not depend on it. Every change it lets through only adds, so an older build started on an additively upgraded store sees a `drop table`/`drop index` in its diff and is refused on that ground (this is the first spec case). What the lag costs: after an additive upgrade, `storeVersion` and the message's direction describe the creation release, not the latest one. Recorded in a `NOTE:` at the top of `control-schema-version.ts`, in the architecture section, and as an input in `plan/control-schema-versioned-migrations` ("Where the version lives"), since a migration runner that starts from the stored version would need a durable one (optimystic persisting tag changes, or a different record).

## Tests

- `control-store-incompatible.spec.ts` (new), at the `ControlDatabase` layer over one `MemoryRawStorage` across several lifetimes, fixtures derived from `CONTROL_SCHEMA` by exact-once literal replacement and passed as `schemaPath`:
  - *Not additive:* store created with no version tag plus an extra table `Legacy`; this build is refused with `storeVersion 0 < buildVersion`, the right `storageScope`, non-empty `pendingDdl`; a later start under the store's own schema still has `Legacy` (without the check the apply runs `drop table`, as the original reproduction showed).
  - *Newer store, additive diff:* store created at version 2 without the `FormationUsageByToken` index; this build's diff is only `create index` plus a tag change, so only the version check refuses it (`storeVersion 2 > 1`); the newer schema still starts afterwards (had this build created the index, the newer build's diff would be `drop index`).
  - *Additive upgrade of a pre-version store:* store with no tag, started under version 2 plus `Legacy`: starts, `Legacy` exists, the in-memory `OwnerKey` tag reads 2.
  - Mutation-checked: removing the version condition fails only case 2; removing the additive condition fails only case 1.
- `control-schema-drift.spec.ts`: new case pinning `{ version: 1, schema: 'hash:ceU-1DFc' }` (`explain schema CadreControl`, which hashes with comments and tags stripped). A schema edit without a bump fails it; a Quereus upgrade that changes its schema rendering would also move the hash (the comment says to re-pin without a bump then).
- Changed, not added: `control-write-retry.spec.ts` drives `applyControlSchema` instead of `loadSchema`; `control-schema-apply-unwind.spec.ts` re-applies through `applyControlSchema`; `createControlNode` moved from the apply-unwind spec into `control-db-node-helpers.ts` for both specs.
- Deliberate deviations from the ticket's test list: case 1 uses an extra-table store rather than an edited constraint, because with a constraint edit a later start under the old schema succeeds whether or not the check exists (the module refuses `drop constraint` and the unwind restores everything), so it proved nothing. Case 2 drops an index rather than adding a table, because an extra table makes the diff non-additive and the version branch would go untested.

Runs: `yarn workspace @serfab/cadre-core test` (177 files, 2476 passed, 1 skipped), `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, all clean. `control-start-storage-op-budget.spec.ts` passes unchanged (the check reads only the local catalog). cadre-core `dist` rebuilt. `integration-tests` (real-network scenarios) not run.

## Known gaps and things to look at

- The "equal version but not additive" message variant and the malformed-tag error (`schemaVersionOf` throws a plain `Error` for a non-integer tag) are untested; both are reachable only by a schema edit without a bump or a hand-made store.
- The recreate instruction to delete the store on **every** machine is reasoned from the code (collection ids are fixed by table name), not run with two machines; the doc says it is a precaution.
- No run against a real store from the previous release. Such stores have no tag and different constraint text (the owner-key series), so they take case 1's branch with `storeVersion 0`. Release notes still need to tell embedders to recreate until migrations land.
- `isAdditiveStatement` accepts every `setTags` action (table, column or constraint target, replace or merge). `dropTags` is refused. Tags are catalog-only metadata, but check that this boundary is right.
- Warm starts now run one extra `diff schema` (local catalog only). Not timed separately; the storage-operation counts are unchanged.
