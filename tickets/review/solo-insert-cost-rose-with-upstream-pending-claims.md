description: The recorded storage-operation figures for a one-member strand were updated after the optimystic storage library removed deletes that did nothing. A save now costs 88 operations instead of 99, and a strand launch costs 80 instead of 88. The small rise over the older figures is an intended crash-safety write.
files:
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (`BASELINE_UPSTREAM`, `LAUNCH`, `INSERT`, the `SELECT` NOTE)
  - ../optimystic/packages/db-p2p/src/storage/block-storage.ts (`setLatest`, `savePendingTransaction`; reference only)
  - ../optimystic/tickets/complete/2-committing-a-block-deletes-a-pending-record-that-is-already-gone.md (downstream confirmation line added)
----

# Re-baseline the solo strand budget at optimystic `fbf165ee`

## What changed

Only `packages/cadre-core/test/strand-solo-write-budget.spec.ts` changed in this repo. The spec edit landed in the fix-stage commit `f48c0d99`. The implement stage re-measured, type-checked, and decided on the insert ceiling.

- `BASELINE_UPSTREAM` is now `optimystic fbf165ee`. Its comment credits the launch (+2) and insert (+8) rises to `9cbc7427`'s per-pend `saveMetadata`. That write is intended: the claim goes into block metadata before the pending record, so a crash between the two still leaves the claim recorded. The comment also says the 11 no-op `deletePendingTransaction` calls that `9cbc7427` added must not come back.
- `LAUNCH`: `ops` 78 → 80, `blocks` 17. Budget 95 and block budget 20 are unchanged.
- `INSERT`: `ops` 80 → 88, `blocks` 3, `opBudget` 90 → 98. Block budget 5 is unchanged.
- The `SELECT` NOTE's cross-reference figures now read launch (80) and insert (88).

## Measured (implement stage, 2026-09-17, optimystic dist at `fbf165ee`)

| phase  | ops | blocks | breakdown |
|--------|-----|--------|-----------|
| launch | 80  | 17     | getMetadata 17/17, saveMetadata 16/6, savePendingTransaction / saveMaterializedBlock / saveRevision / promotePendingTransaction / saveBlockProof 8/6 each, listPendingTransactions 6/6, listBlockIds 1/0 |
| insert | 88  | 3      | saveMetadata 22/3, saveMaterializedBlock 17/3, savePendingTransaction / saveRevision / promotePendingTransaction / saveBlockProof 11/3 each, listPendingTransactions 3/3, getMetadata 2/2 |
| select | 0   | 0      | — |

These are the same as the fix stage's 3 runs. Where the rise from the old baseline (optimystic `03ffadc4`) comes from:
- Insert 80 → 88: `saveMetadata` 14 → 22, which is exactly one per pend plus one per commit (11 + 11). `deletePendingTransaction` is 0.
- Launch 78 → 80: 8 pends over 6 new blocks. Before, only the 6 pends that created a block wrote metadata. Now all 8 do. `deletePendingTransaction` is 0.

## Decision: insert ceiling 98, not 90

I kept 98. The ceiling exists to catch rises nobody has explained. This rise is explained operation by operation and is intended upstream behaviour. Leaving the ceiling at 90 would leave 2 operations of headroom, so a small, legitimate change of +3 would fail the spec. Moving to 98 keeps the 10 operations of headroom the insert budget had before, and this spec's stated policy is that budgets sit "modestly above" the measurement. The comment says plainly that the ceiling was not raised to absorb the no-op deletes; those were fixed upstream instead. A reviewer who prefers the tighter guard can set it back to 90. The only cost would be a spec that fails on any rise of 3 or more.

The floor is unaffected by this choice: it is `> ops / 2`, which is now 44 for insert and 40 for launch.

## Upstream report

Optimystic asked, conditionally, for the launch `deletePendingTransaction` count and whether recovery ran if launch stayed well above 80. It did not stay above: it is exactly 80, with 0 deletes, so no recovery-path delete runs on the solo launch path. I added that confirmation as a sub-bullet under the "Performance" finding of `../optimystic/tickets/complete/2-committing-a-block-deletes-a-pending-record-that-is-already-gone.md`, which had said sereus's downstream counts were not re-measured. **That edit is uncommitted in the `../optimystic` working tree.** The sereus runner does not commit that repo, so a human or optimystic's own runner needs to commit it, or drop it if a line in a completed ticket is the wrong place.

## Validation run

- `yarn workspace @serfab/cadre-core test --run strand-solo-write-budget --silent=false --reporter=verbose`: 1 passed. The figures match the table above.
- `yarn workspace @serfab/cadre-core test --run control-founding-consult-budget control-start-storage-op-budget`: 2 files, 3 tests passed.
- `yarn workspace @serfab/cadre-core typecheck` (the tsconfig that covers `test/`): clean.
- `yarn eslint packages/cadre-core/test/strand-solo-write-budget.spec.ts`: clean.
- The full cadre-core suite was not run, because only this spec file changed.

## Known gaps for the reviewer

- The insert phase's `saveMaterializedBlock` count is 17, against 11 for each other commit step. This excess predates this ticket, is unattributed, and is the same on every run. The `INSERT` comment already records it. Nothing here explains it.
- `docs/architecture.md` and `docs/testing.md` mention this spec but quote no current figures, so no doc change was needed.
