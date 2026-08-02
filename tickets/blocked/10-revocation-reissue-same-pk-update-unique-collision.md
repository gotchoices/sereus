----
description: Updating a revocation tombstone's re-issue counter fails with a false "duplicate row" error from the storage engine, so the new tombstone re-broadcast feature cannot work until the engine layer is fixed — and that layer lives outside this repo.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-revocation-reissue.spec.ts, ../optimystic (vtab module — uniqueConstraintMessage / update path), ../quereus/packages/quereus/src/runtime/emit/dml-executor.ts (processUpdateRow ~1093-1160)
repro: verified
----
## What breaks

The revocation re-issue feature (`control-revocation-reissuable-tombstone`, see git history
at commits d1aac1c / a0b0f82 / 4d470e1) lets an owner bump a `ReissuedAt` counter on a
`CadreControl.Revocation` tombstone so the storage layer re-broadcasts it. The bump is an
UPDATE that changes ONLY the counter — the composite primary key `(TableName, StampId)`
stays the same.

Every such update fails at statement time with:

```
ConstraintError: UNIQUE constraint failed: Revocation.TableName, Revocation.StampId
  at processUpdateRow ../../../quereus/packages/quereus/src/runtime/emit/dml-executor.ts:1158
```

The engine reports the row as colliding with ITSELF. `processUpdateRow` just relays a
constraint-violation result returned by `vtab.update` — the message wording is the
optimystic vtab's (`optimystic-module.ts` → `uniqueConstraintMessage`), so the false
collision is produced inside the optimystic module's update path, plausibly related to the
already-tracked composite-PK point-lookup problem
(`tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked`).

## Evidence (ran it, saw it)

From `packages/cadre-core`: `yarn vitest run test/control-revocation-reissue.spec.ts`
(new spec, in the working tree of the `control-revocation-reissuable-tombstone-tests` run).

- 4 tests fail, ALL of them the ones that execute a counter-only update — including the
  happy path and the production `reissueRevocations` batch test. Even REJECTION probes
  (wrong digest, non-owner signer) die on the UNIQUE error before their deferred CHECK
  could fire, so the constraint machinery never gets a say.
- 5 tests pass — crucially the "identity frozen" probes, whose updates DO change a
  primary-key column and correctly reach the deferred `ReissueOnly` CHECK. So the failure
  is specific to updates that leave the composite PK unchanged.
- The same failure reproduces via the replay spec's updated permanence test
  (`control-revocation-replay.spec.ts`, "a tombstone is permanent…" — its counter-only
  probe).

Production impact: `ControlDatabase.reissueRevocations` (control-database.ts ~1395) can
never complete a bump. No SQL-side workaround exists in this repo: the whole point of the
operation is to rewrite a row WITHOUT changing its key, and delete+reinsert is forbidden
by the schema's own `NoDelete` (retirement must be permanent).

## Why blocked, and the decision needed

The defect is in the optimystic vtab (or its contract with quereus's update executor) —
both are sibling workspaces (`../optimystic`, `../quereus`), not this repo. A human needs
to route this: fix the optimystic module's same-PK update path (likely alongside the
composite-PK point-lookup backlog item), or decide on an interim engine-level workaround.

Once fixed upstream, `implement/10-control-revocation-reissue-test-fixes` (which is
prereq'd on this ticket) finishes the test work and validates the whole feature.
