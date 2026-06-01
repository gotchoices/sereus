---
description: Add a quereus-internal regression test for deferred CHECK constraints that reference `new.<col>` on DELETE (e.g. `coalesce(new.x, old.x)`). The bug was discovered and fixed via the sereus CadrePeer `AuthorizedInsert` constraint; the regression is currently guarded only by `packages/cadre-core/test/seed-bootstrap.spec.ts`. A quereus-level test would protect against regressions independent of sereus and would land in the same project where the original bug lived.
files: ../quereus/packages/quereus/test/dml, ../quereus/packages/quereus/test/logic, ../quereus/packages/quereus/src/runtime/emit/delete.ts, ../quereus/packages/quereus/src/planner/building/delete.ts
---

## Context

A defect in Quereus' DELETE plan tree caused `No row context found for column <col>` whenever a deferred CHECK constraint on a row being deleted referenced `new.<col>` (typically through `coalesce(new.<col>, old.<col>)` or similar). The fix landed via ticket `quereus-cadrepeer-delete-no-row-context` and reshaped the DELETE plan tree to expand the source row to the flat 2N OLD/NEW layout BEFORE `ConstraintCheckNode` runs — mirroring INSERT/UPDATE.

The end-to-end regression is currently exercised only from the sereus side, via the `CadrePeer` `AuthorizedInsert` deferred check (which contains `coalesce(new, old).PeerId`) inside `packages/cadre-core/test/seed-bootstrap.spec.ts`. That test is fine but it lives in the wrong repo to protect quereus on its own.

## Goal

Add a focused quereus-level test (sqllogic or DML spec) that:

1. Declares a table with a deferred CHECK constraint that references `new.<col>` (e.g. `CHECK (coalesce(new.col, old.col) IS NOT NULL) DEFERRABLE INITIALLY DEFERRED`).
2. Inserts a row.
3. Deletes the row.
4. Asserts the DELETE succeeds (no "No row context found" error) and the row is gone.

A second variant that re-inserts after delete (the insert→delete→insert cycle) would round out coverage.

## Out of scope

- Any change to the DELETE plan tree itself — the fix already landed.
- Sereus-side test changes — the existing sereus test stays as integration-level coverage.
