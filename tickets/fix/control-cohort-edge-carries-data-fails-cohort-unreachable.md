---
description: One of the 57 integration scenarios fails twice in a row — a control-database read that runs while one of three nodes is deliberately isolated gives up with "the repo could not determine whether it exists" instead of answering from the two nodes that are still reachable. The scenario exists to prove a revision reaches an isolated node across a reconnect, so this failure hides whether that still works.
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-retry.ts
repro: verified
---

# Control read fails cohort-unreachable while one of three nodes is isolated

Measured 2026-09-15 23:12 and again 23:26, against optimystic `c56c2bd4` (its `yarn build` run
immediately before, both plugin packages, exit 0) and a green `yarn typecheck` across every sereus
workspace. **Failed both runs with the identical stack**, so it is not flake — see "Why load is not
the explanation" below.

Suite context: 57 integration files, 54 passed. The other two failures are a separate ticket
(`degraded-cohort-member-scenario-times-out-at-varying-steps`) and a fix already applied
(`control-bring-up-quiet-period`, per-op delay raised).

## What fails

`control-cohort-edge-carries-data.integration.ts` → "a revision authored on C while B is fully
isolated reaches B only across the reconcile-formed B→C connection". Three nodes, backbone severed,
B fully isolated by the harness.

```
QuereusError: Error during query on table 'Revocation':
  Query failed: Block default/Revocation is unavailable (cohort-unreachable):
  the repo could not determine whether it exists
```

Sereus's entry point is `ControlDatabase.readRowsOnce` (`control-database.ts:683`) under
`retryControlOperation` (`control-retry.ts:112`). Underneath:

```
BlockUnavailableError: Block default/Revocation is unavailable (cohort-unreachable)
 ❯ TransactorSource.tryGet   ../optimystic/packages/db-core/src/transactor/transactor-source.ts:56
 ❯ Tracker.tryGet            ../optimystic/packages/db-core/src/transform/tracker.ts:114
 ❯ Collection.updateInternal ../optimystic/packages/db-core/src/collection/collection.ts:545
 ❯ Collection.update         ../optimystic/packages/db-core/src/collection/collection.ts:478
 ❯ Tree.update               ../optimystic/packages/db-core/src/collections/tree/tree.ts:396
 ❯ OptimysticVirtualTable.runQuery ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:1216
```

Serialized: `{ blockId: 'default/Revocation', reason: 'cohort-unreachable' }`.

## The thing to look at first

**A read reaches `Collection.update`.** Sereus asks for rows; three frames down the call is
`Tree.update` → `Collection.update` → `updateInternal` → `Tracker.tryGet`, and it is that `tryGet`
that raises. Worth establishing before anything else is changed:

1. Is that update expected on a read path at all (lazy tree maintenance, a cache fill, a fetch of a
   missing node), or is a read taking a write path it should not take?
2. `cohort-unreachable` is explicitly "could not determine whether it exists" — an *unknown*, not an
   absence. With one of three nodes isolated, two remain. Should a 3-node cohort with one node
   partitioned be able to answer this, and is the quorum rule here the one sereus expects?
3. The `Revocation` table is the one `every-membership-lookup-reads-an-empty-revocation-table`
   (in `plan/`) is about: a table that is empty in practice but read on every membership lookup. If
   an empty table's block has no committed revision, "cannot determine whether it exists" may be
   what an empty table looks like under partition — which would make this a real product defect on
   any partitioned party, not a test artifact.

That third possibility is why this is filed as a fix rather than a flaky-test ticket. **Rule it in
or out first**, because if it holds, the same read fails in the field whenever a party is
partitioned, and a phone on a flaky network is a partitioned party.

## Why load is not the explanation

Both runs overlapped two SiteCAD ticket agents (`C:\projects\SiteCAD_branch` since 22:44,
`C:\projects\SiteCAD` a fresh ticket at 23:11). The machine was never quiet, so a passing run under
load was never available as a control. What rules load out is that the *same* error arrived at the
*same* frame twice, where the neighbouring timing-sensitive scenario failed at two different steps
on the same two runs. A contention failure moves; this one did not.

## Upstream

Reported to `optimystic-tend` with the full stack and node count; it will decide whether it belongs
in `../optimystic` as a db-core ticket. Do not wait on that to establish point 3, which is a sereus
question regardless of where the fix lands.

One correction recorded there, in case it reaches this ticket second-hand: this error was initially
described (by me) as being on the read path and therefore unrelated to optimystic's commit-path
changes in `6.41-write-durability-reaches-the-writer`. The stack shows it entering
`Collection.updateInternal`, so that reasoning does not hold. No claim that 6.41 caused it — there
is no before/after measurement — but the two have not been separated either.
