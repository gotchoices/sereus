description: Update the recorded storage-operation figures for a one-member strand now that the optimystic storage library has removed the no-op deletes that pushed a save over its limit. The small rise that remains is intended.
files:
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (`BASELINE_UPSTREAM`, `LAUNCH`, `INSERT`, the `SELECT` NOTE)
  - ../optimystic/packages/db-p2p/src/storage/block-storage.ts (`setLatest`, `savePendingTransaction`; reference only)
----

# Re-baseline the solo strand budget at optimystic `fbf165ee`

## Background

Optimystic `9cbc7427` started recording each pending record's claimed revision in the block's metadata (`BlockMetadata.pendingRevs`). That added two costs per block commit. First, a `deletePendingTransaction` on every commit that deleted the committing action's own record, which `promotePendingTransaction` had already moved, so the delete did nothing. Second, a `saveMetadata` on every pend, written before the pending record so a crash between the two leaves the claim recorded. Before, only a pend that created a new block wrote metadata. A solo insert went from 80 to 99 operations, over its ceiling of 90.

Optimystic fixed the first cost upstream: implement `8a0ad39b`, review `fbf165ee`. `setLatest` now drops the committing action's claim before sweeping, so it no longer deletes its own record. The review reverted the matching `recoverLatest` change, because a single lost `setLatest` can leave a record that `StorageRepo.recoverBlock` still needs to delete. The second cost stays, because the crash ordering depends on it.

## Measured (fix stage, 2026-09-17)

This is optimystic HEAD `bf8b7a3a`. Nothing under `packages/` differs from `fbf165ee`, and the dist was rebuilt at `fbf165ee` (the build-freshness guard passed). Each of 3 runs gave the same figures:

| phase  | ops | blocks | breakdown |
|--------|-----|--------|-----------|
| launch | 80  | 17     | getMetadata 17/17, saveMetadata 16/6, savePendingTransaction / saveMaterializedBlock / saveRevision / promotePendingTransaction / saveBlockProof 8/6 each, listPendingTransactions 6/6, listBlockIds 1/0 |
| insert | 88  | 3      | saveMetadata 22/3, saveMaterializedBlock 17/3, savePendingTransaction / saveRevision / promotePendingTransaction / saveBlockProof 11/3 each, listPendingTransactions 3/3, getMetadata 2/2 |
| select | 0   | 0      | — |

Where the change from the old baseline (optimystic `03ffadc4`) comes from:
- **Insert 80 → 88.** `saveMetadata` went from 14 to 22, which is now exactly one per pend plus one per commit (11 + 11). `deletePendingTransaction` is 0.
- **Launch 78 → 80.** 8 pends over 6 new blocks: before, only the 6 pends that created a block wrote metadata, and now all 8 do. `deletePendingTransaction` is 0, so no recovery-path delete runs during launch.
- The unattributed `saveMaterializedBlock` 17-vs-11 excess in insert is unchanged. The old `saveMetadata` 14-vs-11 excess is now fully explained.

`control-founding-consult-budget` and `control-start-storage-op-budget` both pass against this dist (2 files, 3 tests).

## Already done in the fix stage

`strand-solo-write-budget.spec.ts` is edited and passes. `yarn eslint` on the file is clean.
- `BASELINE_UPSTREAM` is now `optimystic fbf165ee`. Its comment credits the +2 launch and +8 insert operations to `9cbc7427`'s per-pend `saveMetadata` and says the no-op deletes must not come back.
- `LAUNCH`: `ops` 78 → 80, budget 95 unchanged. The comment is updated with the write count and history.
- `INSERT`: `ops` 80 → 88, and `opBudget` 90 → 98, which keeps the same 10 operations of headroom above an explained, intended cost. The ceiling was NOT raised to absorb the no-op deletes: the old ceiling of 90 would have passed at 88 with only 2 operations of headroom. Moving it is a judgement call for the reviewer.
- The `SELECT` NOTE's cross-reference figures are updated to launch (80) and insert (88).

## Upstream report still owed

Optimystic asked for the launch `deletePendingTransaction` count and whether recovery ran. The answer is 0 deletes at launch (launch went 88 → 80, exactly the 8 no-op deletes removed), so no recovery-path delete occurs on the solo launch path. Relay this to optimystic if the runner or a human has not already done so.

## TODO

- Re-run `yarn workspace @serfab/cadre-core test --run strand-solo-write-budget --silent=false --reporter=verbose` and confirm launch 80/17, insert 88/3, select 0/0.
- Run the cadre-core type check on the edited spec (vitest does not type-check).
- Decide whether the `INSERT` ceiling should be 98 (10 operations of headroom, as now) or stay at 90. Record the reason in the handoff.
- Relay the launch-recovery answer above to optimystic.
- Hand off to review.
