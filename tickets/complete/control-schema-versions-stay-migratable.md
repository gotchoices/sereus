description: Every version of the control schema is now kept as a test fixture, and a test checks that each version differs from the one before only in ways a running party could apply to its existing data, so a schema edit that would force users to recreate their party fails when it is made.
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts (`classifyControlSchemaChange`, `refuseIncompatibleControlStore`; `pendingControlSchemaChanges` and `declaredSchemaVersion` exported), packages/cadre-core/src/control-database.ts (`loadSchema` comment), packages/cadre-core/src/control-schema.ts (`CONTROL_SCHEMA_BASELINE_VERSION`, `CONTROL_SCHEMA_VERSION` doc), packages/cadre-core/src/index.ts, packages/cadre-core/test/fixtures/control-schema/v3.qsql (new), packages/cadre-core/test/control-schema-versions.spec.ts (new), packages/cadre-core/test/control-schema-drift.spec.ts (version/hash pin removed), docs/architecture.md ("Control schema changes and incompatible stores"), .release-notes.pending.md
----

# Every control-schema version stays migratable from the one before it

GitHub #46. The maintainer decided that a control-schema change is applied to each machine's existing control store when it starts on the new release, instead of recreating the party. The runtime half waits in `implement/control-store-migrates-on-start` (needs `blocked/optimystic-catalog-only-alter-table`). This ticket is the edit-time half: keep every version, and refuse a change between consecutive versions that could never be applied in place.

## What changed

- **`CONTROL_SCHEMA_BASELINE_VERSION = 3`** in `control-schema.ts`, exported from `index.ts` beside `CONTROL_SCHEMA_VERSION`. The `CONTROL_SCHEMA_VERSION` doc comment no longer carries the bump rule; it points at the docs section and the new spec.
- **Fixture** `packages/cadre-core/test/fixtures/control-schema/v3.qsql`, a byte-for-byte copy of `schemas/control.qsql` (checked with `cmp`). It is under `test/`, which `package.json` `files` does not publish, and nothing in `src/` reads it.
- **Classifier** in `control-schema-version.ts` (`classifyControlSchemaChange` is module-private after review; `pendingControlSchemaChanges` is the export), replacing `isAdditiveStatement`/`isAdditiveDdl`/`pendingSchemaDdl`:
  - `classifyControlSchemaChange(statement, catalog: SchemaManager)` returns `additive` | `catalog-only` | `unmigratable`, as the plan ticket specified. A dropped constraint or column is resolved against the catalog passed in.
  - `pendingControlSchemaChanges(db)` runs `diff schema CadreControl` and returns one `{ ddl, kind }` per row (the least migratable kind if a row ever parses to several statements).
  - `refuseIncompatibleControlStore` still accepts only `additive`, so runtime behaviour is unchanged. `ControlStoreIncompatibleError.pendingDdl` is still the list of diff rows.
- **Spec** `control-schema-versions.spec.ts` (in-memory Quereus, no libp2p and no optimystic). `control-schema-drift.spec.ts` lost its version/hash pin `it`, which the first case below replaces.
- **Docs**: the "Schema version" paragraph is split into Schema version / Version fixtures / Baseline / What a new version may change / Signed digests / Until in-place migration lands. "The check" now says "not `additive`". "Recreating a control store" no longer names the retired `plan/control-schema-versioned-migrations` ticket.
- **Release notes**: an "Upgrading" entry saying stores written by 1.16.0 or earlier are refused with `ControlStoreIncompatibleError` and must be recreated on every machine.

## Tests added (all in `control-schema-versions.spec.ts`)

- **keeps a fixture for every version from the baseline to this build, the last one being this build**: fixture versions equal the range baseline..current with no gaps and none above; each fixture's `OwnerKey` version tag, read with `declaredSchemaVersion` after `declare`, equals its file number; the last fixture's `explain schema` hash equals the embedded declaration's. This replaces the drift spec's pin, catches a bump with no fixture, and no longer needs re-pinning after a Quereus upgrade.
- **lets each version differ from the one before only by changes a store can be migrated across**: for each consecutive pair, exec fixture N-1, declare fixture N, and fail on any `unmigratable` diff row. It loops zero times while only v3 exists.
- **classifies the changes of a synthetic next version**: table-driven over two (store, next) variants built from the baseline fixture with `replaceOnce`.
  - A migratable variant gives create table and create index → `additive`; add nullable column, drop column, drop CHECK, add CHECK (a changed CHECK body) and drop index → `catalog-only`. I added the `drop index` row beyond the plan's list, because it costs nothing and covers that branch.
  - An unmigratable variant gives drop table, NOT NULL add column and `alter column … set data type` → `unmigratable`.
- **changes no signed digest between versions without recording it**: walks the parsed CHECK expressions of every declared table (a generic walk over the AST objects, no regex over the text), keys each `digest('CadreControl.<T>', '<action>', …)` call by (table, action), and renders its remaining arguments with Quereus's `expressionToString`. For each consecutive pair, the set of (table, action) whose argument lists changed must equal the `CHANGED_DIGESTS` entries for that version. Both directions are checked, so a stale entry fails too. Anti-vacuity: in every fixture the walk finds at least as many calls as the drift spec's tag-pair regex counts (33 = 33 in v3).

**Mutation check I ran and then reverted.** I temporarily set `CONTROL_SCHEMA_VERSION = 4` and added a `v4.qsql` that changes the `ValidationKey 'add'` digest, drops an index and changes a column's type. All three fixture cases failed, each with a message naming the docs section: the hash mismatch, the `alter column` row as unmigratable, and `ValidationKey 'add'` missing from `CHANGED_DIGESTS`. Both files are back to their committed state.

## Validation run

- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core typecheck`: clean.
- `yarn workspace @serfab/cadre-core test`: 185 files, 2526 passed, 1 skipped. The skip is not from this ticket. `control-store-incompatible.spec.ts` is unmodified and passes. `control-start-storage-op-budget.spec.ts` passes; this change adds no storage operation, because `diff schema` was already run once per warm start and still is.

## Known gaps / judgment calls (from the implement handoff)

- **The two pairwise cases loop zero times today.** Until a v4 exists they are exercised only by the reverted mutation check above. The synthetic case is what covers the classifier meanwhile, as the plan intended.
- **A dropped column is judged against the catalog before the apply.** A column covered by an index that the same diff drops is classified `unmigratable`, even though the module would run the `drop index` first. This is conservative. If a future version needs that, the classifier would have to judge the diff as a sequence.
- **A column referenced only by a partial index's `where` predicate counts as uncovered.** The control schema has no partial index. Quereus would probably refuse that drop itself.
- **An added nullable column that carries `with tags (…)`** is still `catalog-only`. Tags are not constraints, and the plan's wording ("no column constraint other than `null`") allows it.
- **`alter table … drop tags`** stays `unmigratable`, as it was under the old classifier, which accepted only `set tags`.
- **A `drop index` of an index that backs a UNIQUE constraint** would classify `catalog-only`. I did not check what `diff schema` emits when a column loses `unique`. If it emits a `drop index` of the `_uc_<col>` index, that change passes the spec as `catalog-only`. Worth a look.
- **Tripwire, added as a `NOTE:` at the `addConstraint` arm of `classifyTableAlteration`:** Quereus checks stored rows against an added CHECK (`validateChecksOverExistingRows`). So a new CHECK that some stored row fails makes the apply fail on that store, and the spec, which diffs empty tables, cannot see it.
- **`replaceOnce` is duplicated** from `control-store-incompatible.spec.ts` because the ticket required that spec to stay unmodified. A later edit could move it into a shared test helper.
- **Fixtures are read with CRLF normalized to LF**, so the synthetic variants' anchors hold on a CRLF checkout. The hash comparison would not need it.

## Review findings

Read the `ticket(implement): control-schema-versions-stay-migratable` diff first, then the handoff. Ran `yarn lint` (clean), `yarn workspace @serfab/cadre-core typecheck` (clean), `yarn workspace @serfab/cadre-core test` (185 files, 2526 passed, 1 skipped; the skip predates this ticket). Confirmed `v3.qsql` equals `schemas/control.qsql` ignoring line endings, and that the version tag first appeared after `v1.16.0`, so the release note's "1.16.0 or earlier" is accurate.

**Probed `diff schema` and the classifier** with a throwaway in-memory spec (deleted afterwards) over unique, index and CHECK edge cases:
- Unique dropped from a column: no `drop index _uc_…` is emitted. An unnamed unique cannot be dropped at all (Quereus errors in `diff schema`), and a named one emits `drop constraint`, which classifies `unmigratable`. The handoff's open question about a `catalog-only` drop of a unique-backing index does not arise. No change.
- Unique added to a column: `add constraint … unique` → `unmigratable`. Correct.
- `create unique index` on an existing table → `additive`. It fails the apply on a store whose rows already repeat the key, the same shape as the added-CHECK concern. Conditional on a future version adding one, so parked as a `NOTE:` tripwire at the `createIndex` arm of `classifyControlSchemaChange`.
- Column dropped together with its index: `drop index` (`catalog-only`) then `drop column` (`unmigratable`), as the handoff said. Conservative; parked as a `NOTE:` on `isUnkeyedColumn`.
- Column dropped together with a CHECK that names it, nullable column with a default, column-level CHECK add/drop: classified as the docs say.

**Fixed inline (minor):**
- `control-database.ts` `loadSchema` still named the retired `plan/control-schema-versioned-migrations`; now names `control-store-migrates-on-start`.
- `classifyControlSchemaChange` was exported but nothing outside its module imports it (knip flagged it); made module-private. `ControlSchemaChangeKind` stays exported because it types the exported `PendingControlSchemaChange.kind`.

**Tripwires added:**
- Unique index over rows that may repeat: `NOTE:` at the `createIndex` arm in `control-schema-version.ts`.
- Dropped column whose covering index the same diff drops: `NOTE:` on `isUnkeyedColumn`.
- Nothing stops an edit to `schemas/control.qsql` being copied into the last fixture in place with no new version; only review catches it. `NOTE:` beside the hash comparison in `control-schema-versions.spec.ts`, with the fix (pin each shipped fixture's text hash) if it ever slips through.

**Tests:** kept all four. The pairwise and digest cases loop zero times until v4 exists, which the implementer verified with a reverted mutation; the synthetic case covers the classifier's branches in the meantime and is the only one with real branching today. Nothing cut: none restates the implementation or verifies a mock. Nothing added: the defects found are conditional and parked as tripwires.

**Docs:** read `docs/architecture.md` "Control schema changes and incompatible stores" in full; it matches the code. No other doc or source references the removed functions, the removed drift pin or the retired plan ticket (built `dist/` still does, regenerated on build).

**Not filed:** no ticket. Every finding was either fixed inline or is conditional on a future schema edit.

**Other categories:** resource cleanup — `withDatabase` closes each database in `finally`. Error handling — `readFixtures` and `replaceOnce` throw on a malformed fixture name or anchor instead of passing vacuously. Performance — runtime adds a parse per `diff schema` row on warm start, which was already parsed before; no new storage operation. Type safety — no `any`; the AST walk narrows with type guards.
