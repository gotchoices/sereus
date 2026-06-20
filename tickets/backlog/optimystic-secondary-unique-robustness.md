description: The distributed database now blocks duplicate values in "unique" columns, but it does so by scanning every row each time and forgets the rule after a restart from disk — both need hardening before large tables or persistent nodes rely on it.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (checkUniqueConstraints / uniqueKeyFor / resolveUniqueConflict ~805-905; insert + update wiring), ../optimystic/packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (StoredTableSchema ~19-58 — persists indexes+unique flag but NOT uniqueConstraints; tableSchemaToStored / storedToTableSchema), ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
----

## Background

`control-db-network-backed` added secondary `unique` constraint enforcement to the
Optimystic vtab (previously only the PRIMARY KEY was enforced, since it is the tree key).
The CadreControl anti-replay columns (`StampId` not-null-unique on AuthorityKey /
ValidationKey / Strand / FormationInvite, and nullable `MemberPrivateKey` unique on Strand)
depend on it. The implementation lives in `OptimysticVirtualTable.checkUniqueConstraints`
(in `../optimystic`): on INSERT and PK-changing/same-key UPDATE it probes for a conflicting
row and returns a structured `unique` constraint result, mirroring the in-memory vtab and
the PK path. It honours SQL semantics (partial UNIQUE skipped; multi-NULL allowed) and is
validated by `test/secondary-unique.spec.ts` and the cadre-core consent suite.

Two known limitations were deliberately left for hardening — neither blocks the control DB
today (small tables, in-memory/cold-start storage in tests), but both matter at scale and
for persistent nodes.

## Gap 1 — O(rows) probe (no index backing)

`checkUniqueConstraints` does a FULL collection scan per insert/update on any table that has
a secondary UNIQUE constraint (it decodes each row and compares the serialized unique key).
For the small control tables this is fine, but a large sApp/strand table with a secondary
UNIQUE constraint would pay O(rows) per write → O(n²) over a bulk load. The in-memory vtab
checks uniqueness via an index. Optimystic should back each non-partial UNIQUE constraint
with an index tree (it already maintains index trees and has `findByIndexIn`) and probe that
index in O(log n) instead of scanning. Watch the committed-vs-staged read semantics: the
probe must see rows staged earlier in the same transaction (immediate enforcement, like PK),
which the current live-collection scan already does.

## Gap 2 — UNIQUE constraints not persisted across warm restart

`StoredTableSchema` (schema-manager.ts) persists columns, primary key, and `indexes` (with a
`unique?` flag) but NOT `uniqueConstraints`. So enforcement reads `this.tableSchema.uniqueConstraints`,
which is populated only on the COLD create path (Quereus builds it from the DDL). On a WARM
restart with persistent storage, a table re-hydrated from the persisted optimystic schema
(`storedToTableSchema`) comes back with no `uniqueConstraints` → secondary UNIQUE enforcement
silently lapses. The control DB tests use `MemoryRawStorage` (cold) so this is unexercised
today, but a persistent cadre-host node that restarts would lose StampId/MemberPrivateKey
anti-replay enforcement. Fix by persisting unique constraints in `StoredTableSchema` (or
deriving them from persisted unique indexes once Gap 1 backs them with indexes) and
reconstructing them in `storedToTableSchema`.

## Acceptance

- A table with a secondary UNIQUE constraint enforces it in better-than-O(rows) time
  (index-backed probe), with the staged-row visibility semantics preserved.
- A warm restart from persistent storage re-loads secondary UNIQUE enforcement (a duplicate
  of a persisted unique value is still rejected after reopen) — add a reopen test analogous to
  `deferred-constraint-rollback.spec.ts`.
- Existing `secondary-unique.spec.ts` and the cadre-core consent suite stay green.
