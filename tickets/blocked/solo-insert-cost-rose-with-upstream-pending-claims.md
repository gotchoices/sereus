description: Saving a row on a strand that has only one member now takes about a quarter more storage operations than it did, which puts it over the limit a test enforces. Most of the extra operations delete a record that has already been moved, so they do nothing, and the fix belongs in the optimystic storage library.
files:
  - ../optimystic/packages/db-p2p/src/storage/block-storage.ts (`setLatest` → `sweepDeadClaims`, ~line 335; `savePendingTransaction`, ~line 180)
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (`INSERT` budget, line ~103; `LAUNCH`, line ~92)
----

# Solo strand insert over its operation ceiling since optimystic `9cbc7427`

Blocked because the cause is in `../optimystic`, a separate repository with its own ticket board. It needs to go upstream as a fix ticket. Once it lands, this repo re-measures and re-baselines the spec (see "Unblock" below).

## Failing test

`packages/cadre-core/test/strand-solo-write-budget.spec.ts` › "solo strand write budget" › "stays within its operation budgets"

```
AssertionError: solo insert issued 99 raw-storage operations, over the budget of 90 (measured 80 ops over 3 distinct blocks on 2026-09-17 at optimystic 03ffadc4). ... calls/distinct-blocks by method: saveMetadata 22/3, saveMaterializedBlock 17/3, savePendingTransaction 11/3, saveRevision 11/3, promotePendingTransaction 11/3, deletePendingTransaction 11/3, saveBlockProof 11/3, listPendingTransactions 3/3, getMetadata 2/2.: expected 99 to be less than or equal to 90
```

Reproduced 2026-09-17 against a clean, committed optimystic at `2a1bfedb`. The build-freshness guard passed, so the dist is not stale. Launch also rose, from 78 to 88 (8 of the extra operations are `deletePendingTransaction`), but it is still under its ceiling of 95. Select is unchanged at 0.

## Cause (measured)

The rise comes from optimystic `9cbc7427` (`a-member-that-missed-a-commit-refuses-every-later-write`), which records the revision each pending record claims in the block's metadata (`BlockMetadata.pendingRevs`). This adds two costs per block commit:

1. **A `deletePendingTransaction` that does nothing: +11 in insert, +8 in launch.** `BlockStorage.setLatest` runs `sweepDeadClaims(meta, latest.rev)` after `promotePendingTransaction` has already moved the committing action's own record. That action's claim equals `latest.rev`, so the sweep treats it as dead and deletes a record that is no longer there. With `DEBUG=optimystic:db-p2p:block-storage`, every one of the 22 `sweep-dead-claim` lines in a run is the committing action sweeping itself (`claimedRev == latestRev`, same actionId as the preceding `commit` line). None of them are real rivals. The code comment says the claim "goes here", but the code removes it by deleting the record, not by editing the map.
2. **A metadata write on every pend: +8 in insert.** `savePendingTransaction` used to write metadata only when it created a new block. It now always writes the claim first. Metadata is written before the record on purpose, for crash ordering, so this cost is intended.

80 + 11 + 8 = 99, which matches the measurement exactly.

## Proposed upstream fix

In `BlockStorage.setLatest`, remove the committing action's claim from the map (`BlockStorage.recordClaim(meta, latest.actionId, undefined)`) before `sweepDeadClaims`, so the sweep only sees other actions. The same applies to `recoverLatest`: every recovered revision's action was confirmed promoted (`getTransaction` found it), so its claim can be dropped without a delete. The `saveMetadata` that `setLatest` already does persists the change, so there is no extra write. Expected result: insert 88 and launch about 80, back under both ceilings.

### Design constraints

- Rival records claiming at or below the new latest must still be deleted. Only the committing action's own, already-promoted record is skipped.
- Keep the pend-time claim write and its order (metadata before record). Moving it would reopen the crash window the upstream comment describes.
- There are no determinism, byte-format, or migration obligations: `pendingRevs` keeps its shape, and fewer delete calls change no stored bytes.

## Unblock

When the upstream fix lands and the dist is rebuilt, run `yarn workspace @serfab/cadre-core test --run strand-solo-write-budget`. Then re-baseline `INSERT` (expected `ops: 88`) and `LAUNCH` (currently 88, expected about 80) with the new upstream commit in `BASELINE_UPSTREAM`. The provenance comment must attribute the +8 per-pend `saveMetadata` to `9cbc7427`'s pending claims. The `INSERT` comment asks that any rise be explained before the budget moves, and this ticket is that explanation. Do not raise the ceiling to absorb the 11 no-op deletes.

**Carried upstream 2026-09-17:** optimystic `tickets/fix/2-committing-a-block-deletes-a-pending-record-that-is-already-gone.md` (`f1fc816c`), in their fix queue. Optimystic will message when it lands and dist is rebuilt.
