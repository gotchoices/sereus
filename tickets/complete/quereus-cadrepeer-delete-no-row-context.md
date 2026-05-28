---
description: Fixed Quereus DELETE so deferred CHECK constraints that reference NEW.<col> (e.g. coalesce(new.x, old.x)) no longer raise "No row context found for column …". DeleteNode now expands the source row into the flat 2N OLD/NEW layout BEFORE ConstraintCheckNode, mirroring INSERT/UPDATE. Sereus-side regression test exercises insert→delete→insert on CadrePeer.
files: ../quereus/packages/quereus/src/runtime/emit/delete.ts, ../quereus/packages/quereus/src/planner/building/delete.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
---

## What landed

### Quereus

- `../quereus/packages/quereus/src/runtime/emit/delete.ts` — the DELETE prep node was a no-op passthrough; it now expands each N-column source row into a flat 2N OLD/NEW row (`[…sourceRow, …nulls(n)]`), matching what `emitInsert` and `emitUpdate` already produce. OLD section (0..n-1) carries the values being deleted; NEW section (n..2n-1) is all NULL.
- `../quereus/packages/quereus/src/planner/building/delete.ts` — the plan-tree wiring was reordered from `sourceNode → ConstraintCheckNode → DeleteNode → DmlExecutorNode` to `sourceNode → DeleteNode → ConstraintCheckNode → DmlExecutorNode`. The 2N expansion now happens BEFORE constraint checking, so `flatRowDescriptor` lookups for NEW attribute ids at flat indices `n..2n-1` land in real slots (`row.length === 2n`) instead of indexing past the row.

### Sereus

- `packages/cadre-core/test/seed-bootstrap.spec.ts` — the existing CadrePeer authorize/remove test now also re-authorizes the same peer after delete and reads it back, exercising the insert→delete→insert cycle through the now-coherent flat OLD/NEW layout.

## Review findings

### Design / correctness — verified, no findings

- **Row-layout parity.** Confirmed `emitInsert` (`runtime/emit/insert.ts:7-33`) and `emitUpdate` (`runtime/emit/update.ts:69-75`, via `composeOldNewRow`) already produce 2N rows from their prep nodes. The DELETE change removes the deviation rather than introducing a new pattern.
- **`ConstraintCheckNode` works against the 2N row.** Verified `emitConstraintCheck` (`runtime/emit/constraint-check.ts:118-187`) reads via `combinedDescriptor` derived from `plan.flatRowDescriptor`, which maps OLD attrs to 0..n-1 and NEW attrs to n..2n-1 (`util/row-descriptor.ts:21-47`). With a 2N input row, both halves resolve correctly.
- **NOT NULL is skipped on DELETE.** `checkNotNullConstraints` (`runtime/emit/constraint-check.ts:247-249`) short-circuits for DELETE, so the all-NULL NEW section doesn't trip NOT NULL violations on the column metadata.
- **`coerceNewSection` is safe under the 2N row.** It walks `numCols` NEW slots calling `validateAndParse(null, …)`; for NULL the validator is a no-op and the `try`/`catch` keeps the raw value on any anomaly. Slight per-row cost; negligible in practice.
- **`DmlExecutorNode.runDelete` is layout-agnostic.** `extractOldRowFromFlat(flatRow, n)` is `flatRow.slice(0, n)`, which returns the OLD section regardless of whether the input is N or 2N (`util/row-descriptor.ts:79-81`). FK cascade (`executeForeignKeyActions`), RESTRICT prewalk (`assertTransitiveRestrictsForParentMutation`), PK extraction, and change-tracking all consume `oldRow` (N), not `flatRow`, so the layout change does not perturb them.
- **RETURNING is unaffected.** `delete.ts:190-249` registers RETURNING symbols against OLD attribute ids (unqualified and `table.col` both fall through to OLD on DELETE). `new.col` is explicitly rejected at the AST level by `validateReturningQualifiers` (`planner/validation/returning-qualifier-validator.ts:23-28`), so the NEW slots being NULL on DELETE never reaches a user expression. `ReturningNode.executor.getAttributes()` flows through `DmlExecutor → ConstraintCheck → DeleteNode.getAttributes()`, which builds 2N attributes from `flatRowDescriptor` — the 2N row aligns with that attribute set.
- **Plan-tree consumers.** Grepped for `DeleteNode` / `PlanNodeType.Delete` in `planner/`: only `analysis/change-scope.ts:189-194` (DML node-type membership set) and `optimizer.ts:636-650` (materialization-advisory list). Neither cares about wiring order — both are type-only references.
- **`DeleteNode.getAttributes()` consistency.** Verified `planner/nodes/delete-node.ts:32-34` returns `buildAttributesFromFlatDescriptor(flatRowDescriptor)` (2N attrs) so downstream `ConstraintCheckNode.getAttributes()` (passthrough) and `DmlExecutorNode.getAttributes()` (passthrough) expose the right shape.

### Tests

- **`yarn workspace @serfab/cadre-core test`** — 142 passing, 0 failing. The previously-failing test (`SeedBootstrapService > authorizePeer/removePeer > inserts then deletes a CadrePeer row via authority signature`) passes, and the appended re-authorize step exercises the full insert→delete→insert lifecycle.
- **Quereus full suite** (`yarn workspace @quereus/quereus test`) — 3647 passing, 9 pending, 0 failing. Includes the DELETE / FK / deferred-CHECK paths.
- **Typecheck and lint** on Quereus — both clean (exit 0).

### Tests — minor gap (not blocking)

- There is no quereus-level regression test for the specific scenario "deferred CHECK on DELETE referencing `new.<col>`". The sereus-side `seed-bootstrap.spec.ts` covers it via the CadrePeer `AuthorizedInsert` constraint (which references `coalesce(new, old).PeerId`), so the regression is guarded end-to-end. Owning the same test in the project where the bug actually lived would be a durability improvement, but the implementer's broader Quereus FK/CHECK suite already passes and the cross-repo test would survive any reorg of `runtime/emit/delete.ts`. Filed below as a follow-up rather than blocking this review.

### Docs

- No documentation changes required. The fix is internal plumbing parity — DELETE now matches the OLD/NEW row contract that's already documented for INSERT/UPDATE in the Quereus internals. The sereus-side `docs/cadre-consistency.md` and `docs/architecture.md` describe DELETE only at the SQL-surface level (which is unchanged).

### Resource cleanup, error handling, type safety, performance, SPP

- **Cleanup**: no new resources are acquired; nothing to release. `DmlExecutorNode.runDelete`'s `try/finally disconnectVTable` is untouched.
- **Error handling**: no new error paths. The `coerceNewSection` try/catch on the now-all-NULL NEW slots is dead in practice (validators short-circuit on NULL), so it can't mask a real exception.
- **Type safety**: `flatRow: Row = new Array(colCount * 2)` then explicit per-index population — no `any`, no implicit widening.
- **Performance**: per DELETE row we now allocate a 2N array and write N extra NULL slots, and `ConstraintCheckNode.coerceNewSection` walks those NEW slots when deferring a CHECK. Both are O(n) in column count, dwarfed by I/O and the constraint expression itself. No measurable impact expected.
- **SPP / DRY**: change is purely subtractive of a special case. No new abstraction; existing helpers (`composeOldNewRow`, `extractOldRowFromFlat`) cover the layout contract.

## Follow-ups filed

- `tickets/backlog/quereus-deferred-check-new-on-delete-test.md` — add a quereus-internal regression test for the "deferred CHECK referencing `new.<col>` on DELETE" scenario, so the protection isn't sereus-only.

## Validation summary

| Command | Result |
| --- | --- |
| `yarn --cwd ../quereus workspace @quereus/quereus typecheck` | clean (exit 0) |
| `yarn --cwd ../quereus workspace @quereus/quereus lint` | clean (exit 0) |
| `yarn --cwd ../quereus workspace @quereus/quereus test` | 3647 passing, 9 pending, 0 failing |
| `yarn workspace @serfab/cadre-core build` | clean (exit 0) |
| `yarn workspace @serfab/cadre-core test` | 142 passing, 0 failing |

LevelDB-backend (`test:store`) and fork-strict (`test:fork-strict`) suites were not re-run in this review pass — the implement-stage run already covered them (3643/13/0 and 3640/16/0 respectively) and the change has no isolation/backend surface.
