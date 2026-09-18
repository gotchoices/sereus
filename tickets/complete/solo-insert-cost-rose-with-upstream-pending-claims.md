description: The recorded storage-operation figures for a one-member strand were updated after the optimystic storage library removed deletes that did nothing. A save now costs 88 operations instead of 99, and a strand launch costs 80 instead of 88. The small rise over the older figures is an intended crash-safety write.
files:
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (`BASELINE_UPSTREAM`, `LAUNCH`, `INSERT`, the `SELECT` NOTE)
  - ../optimystic/tickets/complete/2-committing-a-block-deletes-a-pending-record-that-is-already-gone.md (downstream confirmation line; uncommitted in that repo)
----

# Re-baseline the solo strand budget at optimystic `fbf165ee`

## What landed

Only `packages/cadre-core/test/strand-solo-write-budget.spec.ts` changed in this repo.

- `BASELINE_UPSTREAM` is `optimystic fbf165ee`. Its comment attributes the launch (+2) and insert (+8) rises over the `03ffadc4` figures to `9cbc7427`'s per-pend `saveMetadata`, an intended write: the claim goes into block metadata before the pending record, so a crash between the two still leaves the claim recorded. It also says the 11 no-op `deletePendingTransaction` calls `9cbc7427` added (removed in `fbf165ee`) must not come back.
- `LAUNCH`: `ops` 78 → 80, 17 blocks, budgets 95 / 20 unchanged.
- `INSERT`: `ops` 80 → 88, 3 blocks, `opBudget` 90 → 98 (keeps the previous 10 operations of headroom over an explained cost), block budget 5 unchanged.
- The `SELECT` NOTE quotes launch (80) and insert (88).

Measured 2026-09-17 against optimystic `fbf165ee` (its HEAD `bf8b7a3a` differs only in `tickets/`):

| phase  | ops | blocks | breakdown |
|--------|-----|--------|-----------|
| launch | 80  | 17     | getMetadata 17/17, saveMetadata 16/6, savePendingTransaction / saveMaterializedBlock / saveRevision / promotePendingTransaction / saveBlockProof 8/6 each, listPendingTransactions 6/6, listBlockIds 1/0 |
| insert | 88  | 3      | saveMetadata 22/3, saveMaterializedBlock 17/3, savePendingTransaction / saveRevision / promotePendingTransaction / saveBlockProof 11/3 each, listPendingTransactions 3/3, getMetadata 2/2 |
| select | 0   | 0      | — |

The optimystic ticket `complete/2-committing-a-block-deletes-a-pending-record-that-is-already-gone.md` gained a downstream-confirmation sub-bullet (launch 80 with zero deletes, so no recovery-path delete on the solo launch path). **That edit is still uncommitted in `../optimystic`**; the sereus runner does not commit that repo, so a human or optimystic's runner needs to commit it (or drop it).

## Review findings

- **Diff read first** (`f48c0d99` spec edit; `d558c716` ticket-only). Checked every figure in the comments against the table: launch 56 writes = 16 `saveMetadata` + 8 pends + 4×8 commit writes ✓; insert `saveMetadata` 22 = 11 pends + 11 commits ✓; 14 → 22 is +8 and 14 → 16 is +2 ✓; totals 80 and 88 ✓.
- **Re-measured**: `yarn workspace @serfab/cadre-core test --run strand-solo-write-budget --silent=false --reporter=verbose` passes and prints exactly the table above. `yarn eslint` on the spec and `yarn workspace @serfab/cadre-core typecheck` are clean. The other two budget specs were not re-run: nothing they cover changed, and the implement stage ran them green.
- **Fixed inline — wrong commit attribution.** The `INSERT` comment said the no-op deletes were "of `2a1bfedb`", but `2a1bfedb` is a tickets-only optimystic commit (the HEAD the 99 was measured at); the deletes came from `9cbc7427`, as the `BASELINE_UPSTREAM` comment says. Now reads "from `9cbc7427`".
- **Fixed inline — incomplete launch history.** The `LAUNCH` history skipped the 88 measured at `2a1bfedb` that the insert history records; added it.
- **Fixed inline — where the delete regression is caught.** The ceiling choice (98 vs 90) is sound, but its margin against the regression the comment warns about is one operation: the deletes returning would cost insert 88 + 11 = 99 (caught) and launch 80 + 8 = 88 (within 95, not caught). Stated that in the `INSERT` comment so nobody raises the insert ceiling by 1 without seeing it opens that gap. Considered pinning `deletePendingTransaction` at zero per phase instead, and declined: a legitimate recovery path could use it, and per-method pins in this spec would break on unrelated upstream reshuffles.
- **Unexplained `saveMaterializedBlock` excess (17 vs 11 per commit step on insert):** pre-existing, deterministic, and already recorded at the site in the `INSERT` comment. Not filed; it is not a defect, and the comment is the right home until someone attributes it.
- **Docs:** `docs/architecture.md` (lines ~522, ~1534) and `docs/testing.md` mention the spec but quote no current figures — no change needed.
- **Hygiene / type safety / resource cleanup / error handling:** the change is constants and doc comments only; no new code paths. The `INSERT` comment is long (history plus rationale), but each sentence is provenance the spec's own policy asks for ("update BOTH the measurement and its date"); left as is.
- **Tripwires / new tickets:** none filed.
