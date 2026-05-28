---
description: Review the Quereus DELETE-time deferred-constraint fix that re-shaped the DELETE plan to expand source rows into the flat 2N OLD/NEW layout BEFORE ConstraintCheckNode, mirroring how INSERT/UPDATE already work. Resolves "No row context found for column PeerId" raised by deferred CHECK constraints that reference `new.<col>` on DELETE (e.g. `coalesce(new.x, old.x)`).
prereq:
files: ../quereus/packages/quereus/src/runtime/emit/delete.ts, ../quereus/packages/quereus/src/planner/building/delete.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
---

## What landed

Two edits in `../quereus` plus a sereus-side regression-test expansion.

### 1. `../quereus/packages/quereus/src/runtime/emit/delete.ts`
The DELETE prep node was a no-op passthrough. It now expands each N-column source row into a flat 2N OLD/NEW row: `[…sourceRow, …nulls(n)]`. OLD section (0..n-1) carries the actual values being deleted; NEW section (n..2n-1) is all NULL. This matches the row layout that `insert.ts` and `update.ts` (via `composeOldNewRow`) already produce for their respective ops.

### 2. `../quereus/packages/quereus/src/planner/building/delete.ts`
Plan-tree wiring swapped. Before:
```
sourceNode → ConstraintCheckNode → DeleteNode → DmlExecutorNode
```
After:
```
sourceNode → DeleteNode → ConstraintCheckNode → DmlExecutorNode
```
This puts the 2N-expansion done by `DeleteNode` in front of `ConstraintCheckNode`, so when `flatRowDescriptor` maps NEW attribute ids to flat indices `n..2n-1`, those slots actually exist in the row (`row.length === 2n`) — eliminating the "No row context found for column …" failure that fired from `DeferredConstraintQueue.evaluateEntry` whenever a deferred CHECK on a DELETE row referenced `new.<col>`.

The RETURNING branch was unchanged and still reads OLD attributes at the same flat indices 0..n-1, so RETURNING-after-DELETE semantics are unaffected.

### 3. `packages/cadre-core/test/seed-bootstrap.spec.ts`
The existing "inserts then deletes a CadrePeer row via authority signature" test now also re-authorizes the same peer after delete and reads it back. This exercises the insert→delete→insert lifecycle through the now-coherent flat-row layout (was the explicit sanity assertion the ticket recommended).

## Why this is the right shape

- INSERT and UPDATE already emit 2N rows from their prep nodes (`emitInsert`, `emitUpdate`); the fix removes a DELETE-specific deviation rather than introducing a new code path or special case.
- `ConstraintCheckNode`, `DeferredConstraintQueue.evaluateEntry`, and `coerceNewSection` were already written to assume the 2N layout. None of them needed operation-specific branches.
- `extractOldRowFromFlat(flatRow, n) === flatRow.slice(0, n)` works for either the old (N) or new (2N) length, so `DmlExecutorNode.runDelete` (FK cascade, PK extraction, RESTRICT prewalk, change tracking) keeps working untouched.
- `coerceNewSection`'s loop already `break`s when `newIndex >= snapshot.length`, but with the 2N row in place it now walks the all-NULL NEW slots and `validateAndParse(null, …)` is a no-op for nullable columns — no validation-time regressions.

## Validation performed

All commands run on Windows with the local `link:../quereus/packages/quereus` resolution active.

| Command | Result |
| --- | --- |
| `yarn --cwd ../quereus workspace @quereus/quereus typecheck` | clean (exit 0) |
| `yarn --cwd ../quereus workspace @quereus/quereus build` | clean (exit 0) |
| `yarn --cwd ../quereus workspace @quereus/quereus test` | **3647 passing, 9 pending, 0 failing** |
| `yarn --cwd ../quereus workspace @quereus/quereus test:store` (LevelDB backend) | **3643 passing, 13 pending, 0 failing** |
| `yarn --cwd ../quereus workspace @quereus/quereus test:fork-strict` | **3640 passing, 16 pending, 0 failing** |
| `yarn workspace @serfab/cadre-core test` | **142 passing, 0 failing** (was 141 passing + 1 failing on master) |

The previously-failing test (`SeedBootstrapService > authorizePeer/removePeer > inserts then deletes a CadrePeer row via authority signature`) now passes, and with the appended re-authorize step it also covers the insert→delete→insert cycle.

Logs were captured to `quereus-typecheck.log`, `quereus-build.log`, `quereus-test.log`, `quereus-test-store.log`, `quereus-test-fork.log`, and `cadre-core-test.log` at the sereus repo root (untracked, fine to delete).

## Surface areas the reviewer should poke at

These are the spots most likely to harbor a regression that the existing tests don't catch:

1. **DELETE + RETURNING with table-qualified OLD references.** Plan-builder `delete.ts` registers `table.col` and unqualified `col` against OLD attributes (lines 192–219). The fix doesn't touch the descriptor maps, but the path now flows `DeleteNode → ConstraintCheckNode → DmlExecutorNode → ReturningNode`, so anything that relied on `ConstraintCheckNode` running pre-DML (and on the row reaching `DmlExecutorNode` having gone through both) is in the new lane. Tests under `packages/quereus/test/dml/returning*` and `packages/quereus/test/plan/dml*` should be the first stop for confirming this.
2. **FK ON DELETE CASCADE / SET NULL / SET DEFAULT.** `runDelete` in `dml-executor.ts:615` slices OLD out of the flat row via `extractOldRowFromFlat(flatRow, n)`. For a 2N row, `slice(0, n)` still returns the OLD section correctly, but worth confirming the FK cascade tests still pass — particularly anything with deferred FK constraints on the deleted parent. (The Quereus suites already exercise this; the reviewer can spot-check `packages/quereus/test/foreign-key*` for `delete` cases.)
3. **`ConstraintCheckNode` walking the NEW section on DELETE.** `coerceNewSection` now walks `numCols` NULL slots per row on every DELETE (it didn't before, because rows were length N). `validateAndParse(null, …)` short-circuits, so the cost should be negligible, but if any column type has a non-trivial validator that misbehaves on NULL, this is where it'd show up.
4. **Plan tree consumers that pattern-match on DeleteNode placement.** If any optimizer rule or visitor assumed the old order (DeleteNode reads from a ConstraintCheckNode), the swap could surprise it. A grep through `../quereus/packages/quereus/src/planner` for `DeleteNode` callers should be quick.

## Known gaps / not done

- The Quereus mutation-subsystem run (`yarn mutation:subsystem`) and full bench sweep were not run — those are out of scope for this fix and historically run out-of-band.
- The end-to-end admin-channel test described in the "Phase 3 follow-ups" section of the implement ticket (mint invite → accept-phone → list members → DELETE member over loopback HTTP) is **not** part of this change. That work is now unblocked, but should land in its own ticket (the deferred 6.7 / integration ticket).
- Quereus is bumped only in source — no version bump or publish.
