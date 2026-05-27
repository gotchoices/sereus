---
description: Deleting a CadrePeer row throws "No row context found for column PeerId" from Quereus' deferred-constraint evaluation. This breaks CadreNode.removePeer against a live control DB — and therefore the DELETE /admin/members/:peerId admin-channel route added by 6.6 (cadre-node-admin-channel). The insert/authorize half of the same path is fine; only delete fails. The fix almost certainly lands in the linked ../quereus workspace, not this repo.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, ../quereus/packages/quereus/src/runtime/deferred-constraint-queue.ts, ../quereus/packages/quereus/src/runtime/context-helpers.ts, ../quereus/packages/quereus/src/runtime/emit/column-reference.ts
---

## Symptom

`packages/cadre-core/test/seed-bootstrap.spec.ts > SeedBootstrapService Helper Methods > authorizePeer / removePeer — round-trip against a real control DB > inserts then deletes a CadrePeer row via authority signature` fails (on `master` — pre-existing, not introduced by 6.6):

```
QuereusError: No row context found for column PeerId. The column reference must be
evaluated within the context of its source relation.
  ❯ resolveAttribute ../quereus/packages/quereus/src/runtime/context-helpers.ts:201
  ❯ Object.run        ../quereus/packages/quereus/src/runtime/emit/column-reference.ts:9
  ❯ DeferredConstraintQueue.evaluateEntry ../quereus/packages/quereus/src/runtime/deferred-constraint-queue.ts:103
```

The insert half of the round-trip (authorizePeer) passes; the failure is on the **delete** path only.

## Why it matters now

6.6 added `DELETE /admin/members/:peerId`, which delegates straight to `CadreNode.removePeer` → `SeedBootstrapService.removePeer` → a signed `delete from CadreControl.CadrePeer`. The admin-channel route is covered green at the mock level, but against a real authority node + control DB the signed delete currently throws, which the admin server classifies as `internal` (500). So the "remove a member" management operation is effectively non-functional end-to-end until this is fixed.

## Likely cause

`CadrePeer`'s authorizing constraint is declared `check on insert, delete` and references the row via `coalesce(new.PeerId, old.PeerId)` (see `schemas/control.qsql` ~line 50). On a DELETE, `new` is null so the constraint resolves `old.PeerId`. The deferred-constraint evaluation path (`deferred-constraint-queue.ts:evaluateEntry`) composes a row slot/descriptor from `entry.contextRow + entry.row`; for the delete case the `old`-row columns referenced by the subquery's `coalesce(...)` aren't resolvable in that composed context, so `resolveAttribute` can't find `PeerId`.

## Expected behavior

A signed CadrePeer delete that satisfies the `AuthorizedInsert` (insert/delete) constraint succeeds and removes the row, mirroring the insert path. The repro test above should pass.

## Scope / where the fix lands

The stack is entirely inside `../quereus/packages/quereus/src/runtime/*` (deferred constraint evaluation + column-reference resolution for `old.*` in delete-time CHECK constraints). The fix is expected to be a Quereus engine change in that linked workspace — not in this repo. Confirm whether a schema rewording in `control.qsql` (e.g. splitting the insert/delete constraint, or avoiding `coalesce(new.x, old.x)` in the deferred path) is a viable workaround if the engine fix is deep; prefer the engine fix.

## Validation

- `yarn workspace @serfab/cadre-core test` — the seed-bootstrap round-trip test goes green (currently the only failing test in that suite: 141/142 pass today).
- Follow-up (6.7 / integration): an end-to-end admin-channel test that boots a real authority node + admin server and exercises mint invite → accept-phone → list members → **DELETE member** over loopback HTTP. This e2e was deferred at 6.6 review precisely because the delete leg is currently broken.
