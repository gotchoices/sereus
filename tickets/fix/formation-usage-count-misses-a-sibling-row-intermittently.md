description: Occasionally, when two machines both redeem the same multi-use invitation at once, one machine's count of how often the invitation has been used comes back one short. The count is what limits how many times an invitation can be used, so an undercount could let it be used more often than allowed.
files:
  - packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts (case 1, `assertRowsMatchApprovals`, line ~325)
  - packages/cadre-core/src/control-database.ts (`countFormationUsage` ~3013, its use-limit checks ~2919 and ~3074)
  - packages/cadre-core/src/control-formation-recorder.ts (~96)
  - packages/cadre-core/src/control-schema.ts (`FormationUsageByToken` index, ~767)
----

# `countFormationUsage` intermittently misses a row the other machine wrote

## What was seen

`yarn check:published` on 2026-09-25, sereus `f46db6be`, against npm `@optimystic/*` 1.5.1 and `@quereus/quereus` 4.20.0, full suite:

```
strand-formation-concurrent-redemption > case 1: concurrent redemption of a multi-use approval-gated invite admits both, asking the hook exactly once each
AssertionError: node A: countFormationUsage agrees with the row scan: expected 1 to be 2
```

The row scan found both `FormationUsage` rows on node A, but the count through the `FormationUsageByToken` index found one. That is the symptom of `secondary-index-seek-blind-to-sibling-rows`, which was closed on 2026-09-17 against optimystic `bbecaf28` (see `tickets/.pre-existing-known.md`, "Delta 2026-09-17 (night)"). That entry says a recurrence on `bbecaf28` or later is a regression.

**Not reproduced in isolation:** the same file, in the same published-packages worktree, passed 5 of 5 runs (3/3 cases each) straight afterwards. The linked-tree `yarn check` passed the whole integration suite the same evening. So it is intermittent, and so far seen only in a full-suite run.

## Why it matters

`countFormationUsage` is the use-limit check on multi-use invitations (`control-database.ts` ~2919 and ~3074; `control-formation-recorder.ts` ~96). An undercount on one machine lets that machine admit a redemption past `totalUses`.

## Do

1. **Measure.**
   - Run the scenario repeatedly under full-suite load, against both the linked tree and the published packages (`yarn check:published --keep`, then loop the file inside the worktree).
   - Record the failure rate, and whether the count is short only for a window (it converges later) or stays short.
   - Capture the optimystic debug lines the 2026-08-29 investigation used (`collection:lineage-divergence`, `collection:context-not-lowered`, the index sub-collection's revision and action id on both machines).
2. **Attribute it.**
   - If the index sub-collection on one machine lags the table's own collection, write it up for optimystic as a regression of `secondary-index-seek-blind-to-sibling-rows`, with the logs, as a blocked `report-` ticket.
   - If it is only a replication window that closes, decide whether the use-limit check needs a read that waits for convergence, the way the test's row scan does.
   - Do not build or edit `../optimystic` (`tickets/rules/sibling-repos.md`).
3. **Protect the test from its own race** only if step 2 shows the product is right and the test reads too early. Do not loosen the assertion otherwise.
4. **Deleting worktrees:** follow `tickets/rules/sibling-repos.md`. A `--keep` worktree must have its junctions unlinked before it is deleted.
