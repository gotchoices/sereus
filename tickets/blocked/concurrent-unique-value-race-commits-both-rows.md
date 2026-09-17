description: When two machines at the same moment insert different rows that share a value in a column declared unique, one of them is correctly told it failed, but its row is stored anyway, so both machines end up holding two rows under one "unique" value. The cause is in the shared database library kept in the sibling optimystic checkout, so it cannot be fixed in this repository.
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (commitDirtyTreesLegacy), ../optimystic/docs/transactions.md (the "Legacy (single-node) commit is not atomic across trees" warning), ../optimystic/tickets/backlog/feat-optimystic-legacy-commit-two-phase.md, schemas/control.qsql, docs/schema-guide.md
difficulty: hard
repro: verified
severity: corruption
likelihood: unusual
----

# Blocked (b): a same-instant race on a secondary unique column stores both rows

**Category (b) — a dependency outside this repo.** The defect is in how `@optimystic/quereus-plugin-optimystic` commits a table and its indexes. Sereus consumes that library as built output linked from `../optimystic`.

## What happens, in plain terms

A table row and each of its indexes are stored as separate structures. In the commit mode sereus uses (the library's default, which it calls "legacy" mode), a transaction saves them one at a time: the table rows first, then each index. Each save is final as soon as it completes.

A column declared `unique` is enforced through its index. When two machines insert different rows carrying the same unique value at the same instant, each one's table save succeeds, because the two rows have different primary keys. Only when the second machine reaches the unique index does it find the value taken. By then its table row is already stored and cannot be taken back. The writer gets an error, but the row exists, on both machines, without its unique-index entry.

## The measurement (2026-09-17)

Sereus at `e0f8ccd`, `../optimystic` at `61747f60`, with the same working-tree caveat recorded in `tickets/implement/optimystic-concurrent-same-pk-insert-silent-lww.md`. Found while re-measuring that ticket, with the same throwaway method: `bootConnectedPair` (two `CadreNode`s, a two-member control cohort confirmed on both sides before the first write), then both nodes insert into `CadreControl.Strand` in the same tick through `db.getDatabase().exec`, with DIFFERENT `Id`s but ONE shared `StampId`, each row correctly owner-signed over its own `(Id, Type, MemberPrivateKey, StampId)`. `Strand.StampId` is declared `text not null unique`.

**6 rounds, 6 of 6 the same result**, with no timing help: one writer fulfilled, the other rejected, and when re-read 4 to 8 seconds later BOTH nodes' views held BOTH rows under the one stamp:

```
A FULFILLED
B REJECTED retriable=false
    PartialCommitError: Legacy multi-tree commit was not atomic: 2 tree(s) were durably committed to storage before the commit failed and CANNOT be rolled back. Persisted (now out of sync with the unpersisted trees): [default/cadrecontrol/Strand, default/cadrecontrol/Strand/index/_uniq_16.memberprivatekey]. Not persisted (reverted in-memory only): [default/cadrecontrol/Strand/index/_uniq_7.stampid]. Underlying failure: UNIQUE constraint failed: Strand.StampId
A view = ["race-stamp-…-X|shared-stamp-…", "race-stamp-…-Y|shared-stamp-…"]
B view = ["race-stamp-…-X|shared-stamp-…", "race-stamp-…-Y|shared-stamp-…"]
```

The rejected writer was B four times and A twice. For contrast, the same race on a shared PRIMARY key was refused cleanly 5 of 5, with one row surviving, because the table rows are the first thing saved and a refusal there leaves nothing stored.

## Upstream already knows the mechanism, but rates it differently

`../optimystic/docs/transactions.md` documents that legacy commit is not atomic across a table and its indexes. The fix that made concurrent unique-value losers fail (`complete/3.5-concurrent-secondary-unique-guard`) added a check before the first save that catches a rival who has ALREADY committed, and described what remains as a "residual window (a rival landing between the pre-flight and a tree's own flush)", carried by the backlog item `feat-optimystic-legacy-commit-two-phase`. That item is filed as a future enhancement.

What this measurement adds: for two writers that start at the same instant, the residual window is the normal outcome. At the time of the early check neither rival has committed, so both pass it. The upstream item proposes reserving every structure first and only then making any of them final, which would make the loser's refusal arrive before anything is stored. That is the change that would close this. The library's other commit mode (a coordinator with a validation engine, "session mode") is documented upstream as having a narrower version of the same gap. Sereus does not configure it anywhere today (no commit-mode setting exists under `packages/*/src`), and what adopting it would cost was not investigated here, so it is not offered as a way around.

## How exposed sereus is today

**The control schema (`schemas/control.qsql`): not reachable by an honest writer or by replaying a captured approval** (inferred from reading the schema, not measured). Every control table's signed authorization digest binds the row's primary key together with its `StampId`. A replayed approval therefore collides on the primary key, which is the clean refusal. Honest writers mint a fresh random stamp per write. The measured shape needs one signer to deliberately sign two different rows with one stamp and present them to two nodes at once, and only a holder of the owner key can do that. `Strand.MemberPrivateKey`, the only other unique column, is a freshly generated key. So the anti-replay columns hold against the threat they were written for.

**Application schemas written by sApp developers: reachable in ordinary use.** Any table with a natural unique column, such as a username or an email address, claimed by two members at the same moment, ends with two rows holding the value, one of whose authors was told the insert failed. The implement ticket named above adds a warning about this to `docs/schema-guide.md`. That warning is the only mitigation available inside this repo.

**Text-matched error classifiers: checked, no hazard found.** `PartialCommitError` embeds the underlying `UNIQUE constraint failed: …` text inside its own message, and sereus classifies errors by text anywhere in the cause chain. `isRetriableControlWriteFailure` returned `false` for it in all 6 rounds, so the write is not retried. `isStrandIdConflict` matches `Strand.Id` at a word boundary and so does not match `Strand.StampId`. For a torn commit to be misread as "this strand id is already seated", the `Strand` table rows would have to be refused after some other structure was stored. They are saved first, and `insertStrand` writes one table, so that does not arise.

Related: `tickets/fix/strand-unique-index-sync-stale-revision` reports the same end state (rows stored, unique index not) reached through a different trigger, an index whose revision never initialises on the first write after a second node attaches. It has its own root cause. Both are made damaging by the same one-at-a-time save.

## Unblock condition

An `../optimystic` change after which a same-instant unique-value loser is refused with nothing stored. Then rebuild (`cd ../optimystic && yarn build`), repeat the measurement above, and expect the rejected writer's row to be absent from both views. When that holds, remove the secondary-`unique` caveat from `docs/schema-guide.md` and close this.

## For the human to relay upstream

This run did not edit the optimystic board: another runner was active in that checkout. Suggested evidence to append to `../optimystic/tickets/backlog/feat-optimystic-legacy-commit-two-phase.md`, with a request to reconsider filing it as a bug instead of a future enhancement:

> Measured from sereus on 2026-09-17 against `61747f60`: two real nodes in a confirmed two-member cohort, inserting different primary keys that share one secondary-unique value in the same tick. 6 of 6 rounds ended in `PartialCommitError` with the loser's base row and first index durably stored and the unique index not, leaving both rows readable on both nodes under one unique value. The pre-flight cannot catch this shape because neither rival has committed when it runs. For same-instant writers this is the expected outcome, not a narrow window.
