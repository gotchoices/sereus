description: A node restarting on a control store written under a different control schema now stops before changing anything and throws one recognisable error, instead of a raw database error that varied by release or, for an older build on a newer store, silently deleting tables (GitHub #46).
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts (new: error, check, additive classifier), packages/cadre-core/src/control-schema.ts (version constant and tag, declaration/apply split, `controlSchemaFileDeclaration`), schemas/control.qsql (`OwnerKey` tag), packages/cadre-core/src/control-database.ts (`loadSchema`, new `applyControlSchema`, `readSchemaFile`), packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-store-incompatible.spec.ts (new), packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-schema-apply-unwind.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, docs/architecture.md, tickets/plan/control-schema-versioned-migrations.md, tickets/plan/2-owner-grant-separate-from-machine-invitation.md
repro: verified
----

# Control store from another release fails with a typed error

## What landed

On every start `ControlDatabase.loadSchema` declares the control schema, runs `refuseIncompatibleControlStore` (`control-schema-version.ts`), then applies it through `applyControlSchema` (the retried distributed DDL, split out so its retry argument and the retry spec cover only the apply). The check does nothing on a cold store. On a warm store it compares the stored `sereus.controlSchemaVersion` tag on `OwnerKey` (absent = 0) with the build's `CONTROL_SCHEMA_VERSION`, lists the pending DDL with `diff schema CadreControl`, parses each statement with Quereus's parser, and throws `ControlStoreIncompatibleError` (party id, both versions, pending DDL, storage scope) when the store's version is higher than the build's or any statement is something other than `create table`, `create index` or `alter table … set tags`. `CadreNode.start()` rethrows it unchanged.

`CONTROL_SCHEMA_VERSION = 1` is pinned beside the `explain schema` hash in `control-schema-drift.spec.ts`, so a schema edit without a bump fails. A `schemaPath` file must hold exactly one `declare schema CadreControl` and one plain `apply schema CadreControl`.

Departure from the original design: the stored tag is the version the store was *created* under. The optimystic plugin keeps `set tags` changes in memory only, so an additive upgrade does not raise it. The check does not depend on it (an older build on an additively upgraded store sees a drop and is refused on that ground). This is recorded in the `NOTE:` at the top of `control-schema-version.ts`, in `docs/architecture.md`, and as an input in `plan/control-schema-versioned-migrations`.

`docs/architecture.md` → "Control schema changes and incompatible stores" describes the version, the check, the recreate procedure, and what is lost and what survives.

## Review findings

Read the diff of `ticket(implement): control-store-from-an-older-release-fails-with-an-untyped-error` before the handoff.

**Correctness, checked and holding.**
- The drift spec's claim that the hash leaves out comments and tags: confirmed in `../quereus/packages/quereus/src/schema/schema-hasher.ts` (`computeSchemaHash` strips table, column, constraint, index and view tags before rendering). So the version tag does not feed its own hash, and a schema edit without a bump fails the pin.
- That a `create index` let through by the check is safe on a populated store: the optimystic module backfills a new index from existing rows (`backfillIndexTrees` / populate in `optimystic-module.ts`). So "a new index applies" in the doc is accurate.
- `CadreNode.start()`'s catch block runs `cleanup()` and rethrows the original error (`cadre-node.ts` ~1423), so the typed error reaches the embedder unchanged.
- Reasoned through the version history: in a linear history each additive upgrade leaves the store a superset of the older schema, so an older build always sees a `drop` and is refused. The version branch is needed only when a newer release created the store and no longer declares something this build declares. That is the case spec case 2 covers. The created-not-upgraded tag does not open a hole.
- The retry after a transient apply failure re-diffs against a catalog that has only moved toward the declared schema, so a retried apply still runs only additive DDL. The check does not need to run again.
- `controlSchemaFileDeclaration` uses the declaration's AST offsets, and spec cases that pass `schemaPath` exercise it. The embedded path skips the parse.

**Found and fixed in this pass (minor).** The retry policy's call site moved from `loadSchema` to `applyControlSchema`, but several references still named `loadSchema` as the policy's consumer or as the site of the full re-run argument. Updated: `docs/architecture.md` (the two paragraphs on `SCHEMA_INIT_RETRY_POLICY`), `control-write-retry.ts` (three doc comments), `control-write-retry.spec.ts:416`, `control-schema-apply-unwind.spec.ts:9`. The storage-operation `NOTE:` that `docs/testing.md`, `cadre-node.ts` and the integration harness cite as "`loadSchema` note" is still at the `loadSchema` call in `initialize`, so those references are correct and were left alone.

**Tests.** The three `control-store-incompatible.spec.ts` cases each pin one branch of the check (the not-additive refusal, the version refusal, and the additive pass). The implementer mutation-checked the first two. Kept all three; none restates the implementation. The drift spec's version/hash pin is what enforces the bump rule. Kept. The retry and unwind spec changes are renames onto the new seam. Added no tests: nothing found in review is a defect a test would reproduce.

**Error handling.** `schemaVersionOf` throws a plain `Error` for a stored tag that is not a non-negative integer. Only a hand-made store or a future change of the tag's format can produce one, and the message names the tag and its value. Left as is, with no ticket: it is not reachable from any release.

**Type safety, DRY, modularity.** No `any`. Version constants live in one place (`control-schema.ts`) and are interpolated into the embedded text. `createControlNode` moved into the shared test helper instead of being copied. `readSchemaFile` was extracted from `loadSchema`. Nothing to change.

**Performance / resource cleanup.** A warm start runs one extra `diff schema`, which reads only the local catalog. `control-start-storage-op-budget.spec.ts` passes unchanged, so the storage-operation counts did not move. The refusal is thrown before the apply, through `initialize`'s existing failure path, which `CadreNode.cleanup()` already tears down. Nothing new to clean up.

**Docs.** Read `docs/architecture.md`, `docs/testing.md`, `docs/reference-app-rn.md` (its `loadSchema` mention concerns the `require('fs/promises')` guard, which now sits in `readSchemaFile` but is still reached from `loadSchema`, so it is still accurate), and the two plan tickets the implementer annotated. All are current after the fixes above.

**Tripwires / new tickets.** None added. The created-not-upgraded version tag is already recorded as a `NOTE:` at `control-schema-version.ts` and as a plan input for migrations.

**Not verified (carried from implement).** No run against a real store from the previous release, which has no tag and different constraint text and so would take the not-additive branch with `storeVersion 0`. The advice to delete the store on every machine is reasoned from the code, not run with two machines. Release notes still need to tell embedders to recreate the control store until versioned migrations land. `integration-tests` (real-network) not run.

**Runs.** `yarn lint` clean. `yarn workspace @serfab/cadre-core typecheck` clean. `yarn workspace @serfab/cadre-core test`: 177 files, 2476 passed, 1 skipped.
