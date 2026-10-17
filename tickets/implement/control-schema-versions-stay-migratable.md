description: Keep a copy of every version of the control schema and check, whenever it changes, that the new version differs from the previous one only in ways a running party can apply to its existing data. Then a schema edit that would force users to recreate their party fails a test when it is made, not later on a user's phone.
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts (`isAdditiveStatement` → the change classifier), packages/cadre-core/src/control-schema.ts (`CONTROL_SCHEMA_VERSION` doc, new `CONTROL_SCHEMA_BASELINE_VERSION`), packages/cadre-core/test/fixtures/control-schema/v3.qsql (new), packages/cadre-core/test/control-schema-versions.spec.ts (new), packages/cadre-core/test/control-schema-drift.spec.ts (the version/hash pin, ~92-103), packages/cadre-core/test/control-store-incompatible.spec.ts (must pass unchanged), docs/architecture.md ("Control schema changes and incompatible stores", ~55-72), .release-notes.pending.md
----

# Every control-schema version stays migratable from the one before it

GitHub #46. The maintainer decided (2026-10-15) that a control-schema change is applied to each machine's existing control store when it starts on the new release, not by recreating the party. The runtime half needs an Optimystic change and waits in `implement/control-store-migrates-on-start`. This ticket is the half that works now. It records what every version looked like and refuses, at edit time, a change that could never be applied in place.

The control store is the one place `AGENTS.md`'s "No backwards compat yet" does not apply, by that decision. Say so in the docs paragraph below.

## Baseline

`CONTROL_SCHEMA_BASELINE_VERSION = 3` (`control-schema.ts`, beside `CONTROL_SCHEMA_VERSION`) is the first version kept, and the oldest a store can be migrated from. Stores written by 1.16.0 and earlier record no version (they read as 0) and are not migrated, for three reasons:

- One number covers several shapes (1.13 to 1.16 all read as 0), and nothing stored tells them apart.
- Between 1.16.0 and version 3, the owner-key add signature started covering `Label` (`owner-key-label-and-founder-machine`). Rows signed before that no longer verify, so the change cannot be migrated without each owner signing their rows again.
- Machine invitations stopped granting ownership (`machine-invitation-grants-no-ownership`), so an owner key seated that way loses its proof.

Those stores keep getting today's refusal and the recreate procedure. The release that ships version 3 is the last one that needs a recreate.

## Fixtures

`packages/cadre-core/test/fixtures/control-schema/v<N>.qsql` holds the full `CONTROL_SCHEMA` text (declaration plus `apply schema CadreControl`, the shape `ControlDatabaseConfig.schemaPath` takes) of each version from the baseline up to `CONTROL_SCHEMA_VERSION`. Add `v3.qsql` now, a copy of the current `CONTROL_SCHEMA`. Two rules for the fixtures:

- Bumping the version adds `v<N+1>.qsql`.
- Once a version has shipped in a release, its fixture is never edited.

Unreleased intermediate versions get fixtures too, because the drift pin already makes every edit a bump. Consecutive fixtures are nearly identical, so git stores each new one as a small delta.

## Change classifier

In `control-schema-version.ts`, replace `isAdditiveStatement` with one classifier over a parsed `diff schema` statement and the catalog it would run against. It returns one of:

- **`additive`**: `create table`, `create index`, `alter table … set tags`. This is today's set.
- **`catalog-only`**: changes the optimystic module will apply without rewriting a row once `blocked/optimystic-catalog-only-alter-table` ships:
  - `drop index`.
  - `alter table … add constraint` whose constraint is a CHECK.
  - `alter table … drop constraint` naming a CHECK constraint of that table in the catalog.
  - `alter table … add column` whose column is nullable with no DEFAULT, no GENERATED expression and no column constraint other than `null`. Put any rule on it in a named table-level CHECK, as `CadrePeer.KnownProfile` does.
  - `alter table … drop column` of a column that is in no index and not in the primary key.
- **`unmigratable`**: everything else. That includes `drop table`, rename of a table, column or constraint, `alter column`, `alter primary key`, a NOT NULL or UNIQUE column add, and a non-CHECK constraint add.

The runtime check keeps accepting only `additive` in this ticket, so `refuseIncompatibleControlStore`'s behaviour does not change and `control-store-incompatible.spec.ts` passes unmodified. `control-store-migrates-on-start` widens it to `catalog-only`. Parse with Quereus's parser as the current code does. A dropped name is resolved against the catalog passed in: the hydrated one at runtime, the previous fixture's in the spec.

## Spec: `control-schema-versions.spec.ts`

Run it on an in-memory `Database` (Quereus's default memory vtab), with no libp2p and no optimystic. `diff schema` is computed from the catalog, so it emits the same statements it does over the optimystic module.

- **The fixtures are complete and the last one is this build.** There is a fixture for every version from `CONTROL_SCHEMA_BASELINE_VERSION` to `CONTROL_SCHEMA_VERSION`, with no gaps and none above. Each one's `OwnerKey` version tag equals its file number, read from the declared schema after `declare`, not with a regex. The last fixture's `explain schema CadreControl` hash equals the embedded declaration's. This replaces the version/hash pin in `control-schema-drift.spec.ts` (delete that `it`). It catches the same edit-without-bump, and also a bump without a fixture. It no longer needs re-pinning after a Quereus upgrade, because both hashes move together.
- **Consecutive versions differ only by migratable changes.** For each pair (N-1, N): exec fixture N-1 (declare and apply), then declare fixture N's declaration, run `diff schema CadreControl`, and classify every statement. An `unmigratable` statement fails the test, naming the statement and the docs section. With only `v3.qsql` this loops zero times. That is expected, and the next case is what exercises the classifier until v4 exists.
- **The classifier, on a synthetic next version.** Build two variants of the v3 fixture in the spec, the way `control-store-incompatible.spec.ts` builds its variants with `replaceOnce`:
  - One that adds a nullable column, changes one CHECK's body, adds a table and an index, and drops a column that a store variant carries. Every statement in its diff classifies as `additive` or `catalog-only`.
  - One that changes a column's type, adds a NOT NULL column, and drops a table. Each of those statements classifies as `unmigratable`.

  One `it` holding both variants, table-driven over the expected kinds.
- **Signed digests do not change silently.** For each consecutive pair, collect every `digest('CadreControl.<Table>', '<action>', …)` call in both fixtures. Walk the parsed CHECK expressions of the declared tables, with no regex over the text, and render each argument list with Quereus's expression stringifier. For every (table, action) present in both versions, the set of argument lists must be equal unless the pair is listed in a `CHANGED_DIGESTS` array in the spec. Each entry there carries a comment naming where the old form is still verified. Why: a stored row's signature was made over the old form, and a reader (the trusted-owner anchor's chain check, `verifyOwnerKeyVoucher` and the like) that only knows the new form stops trusting the row. That is what the 1.16 to version 3 owner-key change did. Anti-vacuity: in the v3 fixture the walk must find at least as many calls as the drift spec's `'CadreControl.<T>', '<action>',` tag-pair count.

## Docs

In `docs/architecture.md` → "Control schema changes and incompatible stores", rewrite the **Schema version** paragraph:

- The fixtures and the rule for adding them.
- The baseline, and why version-0 stores are not migrated (the three reasons above, briefly).
- The change kinds a new version may make: the classifier's `additive` and `catalog-only` kinds, which `control-schema-versions.spec.ts` enforces.
- The signed-digest rule: a digest a stored row was signed under keeps its old form verifiable for rows whose new fields hold null, writers sign the newest form, and the spec's `CHANGED_DIGESTS` list records each such change.
- One sentence: until `control-store-migrates-on-start` lands, a release whose `CONTROL_SCHEMA_VERSION` is above the previous release's still requires the recreate procedure, and its release notes must say so.

Drop the bump rule from `CONTROL_SCHEMA_VERSION`'s doc comment in `control-schema.ts` and point it at the spec and the docs section instead.

Add to `.release-notes.pending.md`, which the prereq's review left undone: control stores written by 1.16.0 or earlier are refused with `ControlStoreIncompatibleError` and must be recreated on every machine (`docs/architecture.md` → "Recreating a control store"). Stores written from this release on carry a schema version.

## Edge cases & interactions

- **A comment-only edit** moves neither hash, so it needs no bump and no fixture. It is covered by the hash comparison.
- **Line endings.** The repo checks out with `core.autocrlf`. The hash comparison works on the parsed AST, so CRLF in a fixture does not matter. By inspection.
- **Quereus upgrade.** A Quereus release that changes what `diff schema` emits between two existing fixtures (for example a rebuild instead of an `alter`) fails the consecutive-versions case. That is correct, because the runtime apply would emit the same thing.
- **A table-level `constraint … check` added together with its new column.** The differ may order the `add constraint` before or after the `add column`. The classifier judges each statement alone, so the order does not matter. Covered by the synthetic case.
- **Runtime unchanged.** `refuseIncompatibleControlStore` still refuses `catalog-only` statements. Verify by `control-store-incompatible.spec.ts` passing unmodified and `control-start-storage-op-budget.spec.ts` counts not moving.
- **Bundle size.** The fixtures live under `test/` and are never imported by `src/`, so they stay out of the published package. Check `packages/cadre-core/package.json` `files` and the browser bundle-shape test.

## TODO

- Add `CONTROL_SCHEMA_BASELINE_VERSION` to `control-schema.ts` and export it beside `CONTROL_SCHEMA_VERSION` from `index.ts`.
- Add `test/fixtures/control-schema/v3.qsql` (copy of `CONTROL_SCHEMA`).
- Replace `isAdditiveStatement` with the three-kind classifier; keep the runtime accepting `additive` only.
- Write `control-schema-versions.spec.ts` (four cases above); delete the version/hash pin from `control-schema-drift.spec.ts`.
- Update `docs/architecture.md` (Schema version paragraph), the `CONTROL_SCHEMA_VERSION` doc comment, and `.release-notes.pending.md`.
- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/cadre-core test`.
