---
description: Fix Quereus DELETE-time deferred constraint evaluation that fails with "No row context found for column PeerId" whenever a deferred CHECK constraint references `new.<col>` (e.g. `coalesce(new.x, old.x)`). Root cause is in Quereus, not Sereus — the DELETE plan pipeline sends N-column OLD-only rows into ConstraintCheckNode while the flatRowDescriptor maps NEW attributes to indices n..2n-1, so deferred evaluation tries to read past row.length. INSERT and UPDATE pre-expand to 2N OLD+NEW flat rows in their prep nodes; DELETE does not.
prereq:
files: ../quereus/packages/quereus/src/planner/building/delete.ts, ../quereus/packages/quereus/src/runtime/emit/delete.ts, ../quereus/packages/quereus/src/planner/building/insert.ts, ../quereus/packages/quereus/src/planner/building/update.ts, ../quereus/packages/quereus/src/runtime/emit/insert.ts, ../quereus/packages/quereus/src/runtime/emit/update.ts, ../quereus/packages/quereus/src/runtime/emit/constraint-check.ts, ../quereus/packages/quereus/src/runtime/deferred-constraint-queue.ts, ../quereus/packages/quereus/src/runtime/emit/dml-executor.ts, ../quereus/packages/quereus/src/util/row-descriptor.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
---

## Root cause (in Quereus)

`flatRowDescriptor` (built by `buildOldNewRowDescriptors` in `util/row-descriptor.ts`) maps:
- OLD attribute IDs → flat indices `0..n-1`
- NEW attribute IDs → flat indices `n..2n-1`

`ConstraintCheckNode` (in `runtime/emit/constraint-check.ts`) and the deferred queue (`runtime/deferred-constraint-queue.ts:evaluateEntry`) both assume the row flowing through has length `2n` and matches `flatRowDescriptor`. They install a single row slot keyed on `flatRowDescriptor` (or a composed `contextDescriptor + flatRowDescriptor`) and rely on `resolveAttribute` reading `row[columnIndex]`.

INSERT and UPDATE produce 2N flat rows before `ConstraintCheckNode`:

- `runtime/emit/insert.ts` builds `flatRow = [...nulls(n), ...sourceRow]` (OLD = nulls, NEW = source).
- `runtime/emit/update.ts` calls `composeOldNewRow(sourceRow, updatedRow, n)` → 2N flat row.
- Plan order for both: `source → Insert/UpdateNode (2N expand) → ConstraintCheckNode → DmlExecutorNode`.

DELETE does **not**:

- `planner/building/delete.ts` wires `ConstraintCheckNode` directly around the filtered table source (N columns of OLD values). `DeleteNode` is placed **after** `ConstraintCheckNode`, and `runtime/emit/delete.ts` is a pure passthrough.
- Plan order for DELETE today: `source (N-col) → ConstraintCheckNode → DeleteNode → DmlExecutorNode`.
- Consequence: the row that enters `ConstraintCheckNode` is N columns (just OLD). For a constraint like `CadrePeer.AuthorizedInsert` —
  `exists (select … verify(digest(coalesce(new.PeerId, old.PeerId), …)))` — the NEW.PeerId column reference resolves to a `flatRowDescriptor` column index of `n` (= `numCols + 0`). At eval time the row has length `n`, so `n < row.length` is false, the linear fallback in `resolveAttribute` also fails (no other context exposes that attribute id), and Quereus throws `No row context found for column PeerId`.
- The constraint contains a subquery → `needsDeferred = true` (see `containsSubquery` in `planner/building/constraint-builder.ts:250`), so the failure surfaces in the post-statement `DeferredConstraintQueue.runDeferredRows()` path (matching the stack trace in the failing test):

```
QuereusError: No row context found for column PeerId
  ❯ resolveAttribute ../quereus/.../context-helpers.ts:201
  ❯ Object.run        ../quereus/.../emit/column-reference.ts:9
  ❯ DeferredConstraintQueue.evaluateEntry ../quereus/.../deferred-constraint-queue.ts:103
```

INSERT half of the same authorization round-trip passes because `coalesce(new.PeerId, old.PeerId)` finds NEW.PeerId at flat index `n` in the 2N row that `emitInsert` builds.

## Fix

Mirror the INSERT/UPDATE pattern for DELETE — produce a flat 2N row (OLD = filtered source row, NEW = all NULL) **before** `ConstraintCheckNode`. Two file changes, both in `../quereus`:

### 1. `runtime/emit/delete.ts` — expand to flat 2N row

Replace the passthrough generator with one that emits `[…oldRow, …nullsOfLength(n)]`:

```ts
// runtime/emit/delete.ts
import type { DeleteNode } from '../../planner/nodes/delete-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitDelete(plan: DeleteNode, ctx: EmissionContext): Instruction {
  const tableSchema = plan.table.tableSchema;
  const colCount = tableSchema.columns.length;

  async function* run(_rctx: RuntimeContext, sourceRows: AsyncIterable<Row>): AsyncIterable<Row> {
    for await (const sourceRow of sourceRows) {
      // OLD = sourceRow (0..n-1), NEW = nulls (n..2n-1) for DELETE
      const flatRow: Row = new Array(colCount * 2);
      for (let i = 0; i < colCount; i++) {
        flatRow[i] = sourceRow[i] ?? null;
      }
      for (let i = 0; i < colCount; i++) {
        flatRow[colCount + i] = null;
      }
      yield flatRow;
    }
  }

  const sourceInstruction = emitPlanNode(plan.source, ctx);
  return {
    params: [sourceInstruction],
    run: run as InstructionRun,
    note: `deletePrep(${plan.table.tableSchema.name})`,
  };
}
```

Note: `extractOldRowFromFlat(flatRow, n)` in `runtime/emit/dml-executor.ts:runDelete` already returns `flatRow.slice(0, n)`, which is correct for either an N- or 2N-length row. So downstream `keyValues = pkColumnIndicesInSchema.map(idx => oldRow[idx])` keeps working unchanged.

### 2. `planner/building/delete.ts` — reorder so DeleteNode comes before ConstraintCheckNode

Today:
```
sourceNode → ConstraintCheckNode → DeleteNode → DmlExecutorNode
```
Target (matching INSERT/UPDATE):
```
sourceNode → DeleteNode → ConstraintCheckNode → DmlExecutorNode
```

In `buildDeleteStmt`, swap the wiring. The two relevant blocks today are (around lines 148–183):

```ts
const constraintCheckNode = new ConstraintCheckNode(
  deleteCtx.scope,
  sourceNode,                  // <-- current: source feeds ConstraintCheckNode
  tableReference,
  RowOpFlag.DELETE,
  oldRowDescriptor,
  newRowDescriptor,
  flatRowDescriptor,
  constraintChecks,
  mutationContextValues.size > 0 ? mutationContextValues : undefined,
  contextAttributes.length > 0 ? contextAttributes : undefined,
  contextDescriptor
);

const deleteNode = new DeleteNode(
  deleteCtx.scope,
  tableReference,
  constraintCheckNode,         // <-- current: ConstraintCheckNode feeds DeleteNode
  oldRowDescriptor,
  flatRowDescriptor,
  ...
);

const dmlExecutorNode = new DmlExecutorNode(
  deleteCtx.scope,
  deleteNode,
  ...
);
```

Change to:

```ts
const deleteNode = new DeleteNode(
  deleteCtx.scope,
  tableReference,
  sourceNode,                  // <-- new: source feeds DeleteNode (which expands to 2N)
  oldRowDescriptor,
  flatRowDescriptor,
  mutationContextValues.size > 0 ? mutationContextValues : undefined,
  contextAttributes.length > 0 ? contextAttributes : undefined,
  contextDescriptor
);

const constraintCheckNode = new ConstraintCheckNode(
  deleteCtx.scope,
  deleteNode,                  // <-- new: DeleteNode feeds ConstraintCheckNode (2N rows)
  tableReference,
  RowOpFlag.DELETE,
  oldRowDescriptor,
  newRowDescriptor,
  flatRowDescriptor,
  constraintChecks,
  mutationContextValues.size > 0 ? mutationContextValues : undefined,
  contextAttributes.length > 0 ? contextAttributes : undefined,
  contextDescriptor
);

const dmlExecutorNode = new DmlExecutorNode(
  deleteCtx.scope,
  constraintCheckNode,         // <-- new: ConstraintCheckNode feeds DmlExecutorNode
  ...
);
```

The RETURNING branch in the same file already references `dmlExecutorNode` and OLD/NEW attribute ids via the same `flatRowDescriptor`; no changes needed there (RETURNING for DELETE only reads OLD, which lives at the same indices 0..n-1).

### Why this is the right shape

- It's the same shape INSERT (`runtime/emit/insert.ts`) and UPDATE (`runtime/emit/update.ts`) already use — prep node expands to flat 2N, ConstraintCheckNode + DmlExecutor consume 2N. The fix removes a DELETE-specific deviation rather than introducing a new code path.
- It avoids special-casing DELETE inside `ConstraintCheckNode` or `DeferredConstraintQueue`, which would mean those layers know about operation-specific row layouts.
- `coerceNewSection` in `runtime/emit/constraint-check.ts:393` already tolerates either length (it `break`s when `newIndex >= snapshot.length`). With the 2N row in place it will correctly walk the NEW slots (which are all NULL for DELETE, so `validateAndParse` of NULL is a no-op for nullable columns).

## TODO

Phase 1 — Quereus fix
- Edit `../quereus/packages/quereus/src/runtime/emit/delete.ts` to expand sourceRow into a 2N flat row (OLD = sourceRow, NEW = nulls), as shown above.
- Edit `../quereus/packages/quereus/src/planner/building/delete.ts:buildDeleteStmt` to construct `DeleteNode` BEFORE `ConstraintCheckNode`, and pipe `DeleteNode → ConstraintCheckNode → DmlExecutorNode`. Apply the swap to both the RETURNING and non-RETURNING branches if the RETURNING branch is structured similarly (check the file — current snapshot only shows one branch, but verify before editing).

Phase 2 — Validation
- `cd ../quereus && yarn build` (or the workspace's typecheck script) to confirm no type drift.
- `cd ../quereus && yarn workspace @optimystic/quereus test 2>&1 | tee /tmp/quereus-test.log` — full Quereus unit/integration suite. The DML/constraint suites are the primary risk surface; pay attention to:
  - any DELETE + CHECK constraint tests (especially with subqueries / committed.* refs that force `needsDeferred`)
  - DELETE + RETURNING tests (RETURNING reads OLD; verify the new 2N row layout doesn't shift OLD attribute indices)
  - FK ON DELETE CASCADE / RESTRICT tests (cascade runs from `runtime/foreign-key-actions.ts` against the OLD row pulled out of the flat row)
- Back in Sereus: `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` — the previously-failing `inserts then deletes a CadrePeer row via authority signature` test (in `packages/cadre-core/test/seed-bootstrap.spec.ts`) should now pass, and the rest of the suite (currently 141 green) must stay green.
- Recommended sanity assertion to add to the cadre-core test if not already present: after `removePeer`, also re-`authorizePeer` the same `dronePeerId` and read it back — exercises the insert/delete/insert cycle through the now-coherent flat row layout.

Phase 3 — Follow-ups (out of scope here, do not implement)
- The deferred 6.7 / integration ticket: end-to-end admin-channel test (mint invite → accept-phone → list members → DELETE member over loopback HTTP). Note in the review/handoff that this is now unblocked by Phase 1.
