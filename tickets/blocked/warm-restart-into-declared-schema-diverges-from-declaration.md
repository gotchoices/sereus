description: Since optimystic's same-named-tables fix (commit `6302f2e8`), a warm restart hydrates each table back into the schema it was declared in, so `apply schema` now diffs the declaration against the hydrated tables instead of creating them fresh. Three defects in quereus and optimystic surface through that diff and break every restart of the control database and of strands: a type-alias false positive (`ALTER COLUMN … SET DATA TYPE int`), lost CHECK context declarations, and stale `using optimystic(...)` args. None can be fixed in sereus without working around the declaration.
prereq:
files:
  - ../quereus/packages/quereus/src/schema/schema-differ.ts (computeColumnAttributeChange — the type comparison; no diff of `with context` or of plain-table module args)
  - ../optimystic/packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (storedToTableSchema / tableSchemaToStored — drops checkConstraints and mutationContext, restores persisted vtabArgs)
  - ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (hydrateCatalog)
  - packages/quereus-plugin-sereus/src/compose-strand.ts (hydrate, then `apply schema Strand` / `apply schema App`)
  - schemas/control.qsql, schemas/strand.qsql
difficulty: medium (upstream, three separate changes)
repro: verified
----

# Failing tests

Reproduced 2026-09-16 against `../optimystic` HEAD `6302f2e8` (with `@optimystic/db-p2p` rebuilt, which carries another session's uncommitted `libp2p-key-network.ts` edits) and `../quereus` `ff1c619c6`.

cadre-core (`yarn workspace @serfab/cadre-core test`):

- Group A, `QuereusError: Failed to execute DDL: ALTER TABLE CadreControl.CadrePeer ALTER COLUMN UpdatedAt SET DATA TYPE int` / `Module for table 'CadrePeer' does not support ALTER COLUMN`:
  - `test/control-database-solo-warm-start.spec.ts` (5 tests)
  - `test/control-database-solo.spec.ts` "re-reads its control rows after a restart on the same identity and storage"
  - `test/control-database-offline-peers.spec.ts` "re-boots on stored rows and still serves every control read/write with a BLACKHOLE sibling"
  - `test/control-start-storage-op-budget.spec.ts` "stays within its operation budget on a cold start and on a warm restart"
  - `test/discovered-strands-late-subscriber.spec.ts` "a restarted node re-attaches a stored strand even though the app subscribes after start() resolves"
  - integration: `strand-late-cadre-join.integration.ts` "delivers a pre-existing strand — blocks and all — to a machine enrolled after the writes"; `strand-two-party-two-machine.integration.ts` "replicates from any machine, commits with one machine off, and catches the returner up"
  - cadre-cli `test/one-shot-node.spec.ts` "removes a seeded strand, and the row is gone from the control database afterwards" and "refuses a closed strand without --yes, exits 1, and leaves the membership key intact" (the spawned `cadre strand remove` warm-reopens the control database the seed node wrote)
- Group B, `test/strand-membership-writer.spec.ts` "hydrates a grown strand (3 members, 2 managers) into a fresh Database without re-running membership CHECKs": `QuereusError: context.ManagerKey isn't a column` (planner `resolveColumn`), raised by the warm-session `addManager` insert.
- Group C, `test/strand-transactor-handover.spec.ts` "reads and appends, through the network transactor, a store the local transactor wrote": `expected Set{} to deeply equal Set{ 'gen1-a', 'gen1-b', 'gen1-c' }`.

# Why it started now

Before `6302f2e8`, `hydrateCatalog` added every hydrated table to the host's current schema, not the declared one. `apply schema CadreControl` / `Strand` / `App` then saw no existing tables and emitted plain `CREATE TABLE`, which optimystic accepted as adopting the existing storage — using the full declaration. Now hydrated tables land in the declared schema, so the declarative differ compares the declaration against the hydrated `TableSchema` and emits a migration. The three defects below were latent until then.

# Root causes (measured)

## A. quereus differ: type alias read as a type change

`computeColumnAttributeChange` compares the declared type token to the catalog's `logicalType.name` as raw strings: `declared.dataType.toLowerCase() !== actual.type.toLowerCase()`. `int` resolves to logical type `INTEGER`, so `'int' !== 'integer'` and an unchanged column is reported as retyped.

Reproduced with no optimystic involved — a memory table, declared once and applied once:

```js
await db.exec(`declare schema S { table T (Id text primary key, UpdatedAt int null) }`);
await db.exec('apply schema S');
for await (const r of db.eval('diff schema S')) console.log(r);
// {"ddl":"ALTER TABLE S.T ALTER COLUMN UpdatedAt SET DATA TYPE int"}
```

The memory module absorbs the no-op retype; the optimystic module refuses `ALTER COLUMN`, so the control database's restart fails. Fix: compare `getTypeOrDefault(declared.dataType).name` with `actual.type` (or equivalent logical-type identity).

## B. optimystic hydrate drops CHECKs and `with context`; the differ does not restore context

`storedToTableSchema` returns `checkConstraints: []` and no `mutationContext`; neither is persisted. After hydrate, `diff schema Strand` emits `ALTER TABLE Strand.Manager ADD constraint Authorized check … context.ManagerKey …` (and the same for every checked table) but nothing restores `with context (ManagerKey text, Signature text …)`. The resulting table (probed via `schema()`):

- cold: `CREATE TABLE "strand"."Manager" (…, constraint Authorized check on insert, delete (… context.ManagerKey …), unique (StampId)) USING optimystic (…)` with its context
- warm, after apply: the same CHECKs, but no context declaration, so the first insert that plans the CHECK fails on `context.ManagerKey`.

Group A's control tables carry the same pattern (`CadrePeer`'s CHECKs read `context.*`), so fixing A alone is expected to expose B on the control database.

Fix options (upstream decision): persist `checkConstraints` and `mutationContext` in the catalog record and restore them on hydrate; and/or have the quereus differ compare and migrate `with context` definitions (it currently has no code for them).

## C. hydrate restores persisted module args the declaration has changed

The hydrated table keeps the persisted `vtabArgs`. Handover probe, same storage directory, second open with the default network transactor:

| era 1 → era 2 transactor | hydrated `using` args in era 2 | rows read |
| --- | --- | --- |
| local → local | `transactor = 'local'` | 1 |
| network → network | `transactor = 'network'` | 1 |
| local → network | `transactor = 'local'` (declared `'network'`) | 0 |

`diff schema App` is empty in the local → network case: the differ does not compare module args for plain tables (only maintained tables go through `backingModuleDrifted`). The table therefore opens on a local transactor the era-2 composition never wired to its storage, and reads empty.

Fix options (upstream decision): treat connection wiring (`transactor`, `keyNetwork`, `networkName`) as runtime configuration rather than catalog identity when hydrating; or have the differ reconcile plain-table module args.

# Design constraints

- Do not weaken sereus's declarations to dodge A (e.g. respelling `int` as `integer`): that hides a differ defect every consumer with an alias type hits.
- Do not skip hydrate in sereus: it is what prevents re-creating tables over existing storage.
- B changes the optimystic catalog record format. Records are already incompatible across `6302f2e8` (no backwards compat yet), but any added fields should keep the byte-identical-when-absent discipline `tableSchemaToStored` documents, since catalog blocks replicate.
- C must not make the transactor part of a table's storage identity; the handover test exists because strands move from the local to the network transactor over the same bytes.

# Why blocked, not fixable here

All three causes are in `../quereus` (differ) and `../optimystic` (catalog hydrate). The optimystic session (`optimystic-4e`) reported taking the restart failures as its highest-priority fix, but as of this triage it has no ticket for them in `fix/`, `implement/` or `plan/` (its `0.5-same-named-tables…` ticket is complete), so relay this ticket's three findings to it and to the quereus maintainer.

# When upstream reports fixes

1. Rebuild `@quereus/quereus` and `@optimystic/quereus-plugin-optimystic` (and any package the stale-build guard names).
2. `yarn workspace @serfab/cadre-core test` — every test listed above must pass; then the two integration scenarios from `packages/integration-tests`.
3. Remove the matching lines from `tickets/.pre-existing-known.md`.
