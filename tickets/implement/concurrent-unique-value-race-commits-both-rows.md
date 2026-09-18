description: Two machines inserting different rows that share a value in a column declared unique, at the same moment, used to end with both rows stored even though one writer was told it failed. The shared database library has fixed this and the fix has been re-measured here; this ticket retires the warnings that said it was broken and keeps the new two-machine test that proves it stays fixed.
files: packages/integration-tests/src/scenarios/control-concurrent-unique-column-race.integration.ts, packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts, docs/schema-guide.md, docs/architecture.md, tickets/blocked/report-schema-guide-concurrency-correction-to-issue-5.md, packages/cadre-core/src/control-write-retry.ts
difficulty: easy
repro: verified
----

# The same-instant race on a secondary `unique` column is fixed upstream; retire the caveats

## What was wrong, in plain terms

A table row and each of its indexes are stored as separate structures. Until 2026-09-17 the shared database library (`@optimystic/quereus-plugin-optimystic`, consumed from the sibling `../optimystic` checkout) saved them one at a time in its default commit mode, each save final as soon as it completed. When two machines inserted different rows carrying the same value in a column declared `unique` at the same instant, both passed the table save, and only the second to reach the unique index was refused. By then its table row was already stored, so both machines held two rows under one "unique" value, and the losing writer had been told its insert failed. Measured 6 of 6 rounds on 2026-09-17 (the fix-stage record is in this ticket's history; the measurement method is the scenario file below).

## What upstream changed

Optimystic `e296a802` (fix), `13586033` (implement), `2fdb3b97` (review), dist rebuilt at `fbf165ee`. A default-mode commit touching two or more structures now goes through a per-commit coordinator: every structure is reserved ("pended") before any is made final, so the unique index refuses the loser before anything is stored. `../optimystic/docs/transactions.md` ("Legacy (single-node) commit: one pended batch") describes it and names this sereus measurement as the field report that drove it.

## Re-measured in sereus on 2026-09-17: the fix holds

Sereus at `405cf306`, `../optimystic` at `bf8b7a3a` with a clean tree and every package's dist newer than its newest source file (the suite's stale-build guard passed on every run).

The measurement is the new scenario `packages/integration-tests/src/scenarios/control-concurrent-unique-column-race.integration.ts`, already written and green. It uses `bootConnectedPair` (two `CadreNode`s of one party, a two-member control cohort confirmed on both sides before the first write), and each round has both nodes insert into `CadreControl.Strand` in the same tick with different `Id`s and one shared `StampId` (`text not null unique`), each row correctly owner-signed over its own fields. Three rounds per process, two fresh processes: **6 of 6 rounds** ended with exactly one writer fulfilled, one rejected, the loser's row absent from both nodes' table scans and point lookups, and the winner's row readable on both under the shared stamp. A "fence" row written by the loser after its refusal reached both nodes before those assertions ran, so the absence is not a stalled replica. An earlier run of the same file with a broken assertion (it filtered on a column `queryStrands` does not project) gave the same one-fulfilled-one-rejected split in 3 more rounds, so the refusal itself was seen 9 of 9. The rejected writer was A in the 3 broken-assertion rounds and B in all 6 counted rounds, so which node wins is still not deterministic and the scenario asserts one-to-one correspondence, never a fixed winner. Logs: `tickets/.logs/concurrent-unique-value-race-commits-both-rows.run{1,2}.log`.

For contrast, before the fix the same shape produced a `PartialCommitError` naming the `Strand` table and its `MemberPrivateKey` unique index as persisted and the `StampId` unique index as not, 6 of 6.

**What error the loser actually gets** (the unblock note asked for this to be recorded): a plain `Error`, not the engine's `ConstraintError` type. Its message chain is:

```
UNIQUE constraint failed: Strand.StampId | Tree collection default/cadrecontrol/Strand/index/_uniq_7.stampid: key "…<stamp>…<loser id>…" is guarded unique over a key range already occupied by committed entry "…<stamp>…<winner id>…"
```

`isRetriableControlWriteFailure` returns `false` for it (correct: re-presenting a constraint refusal can only fail again). No `PartialCommitError` or `CoordinatorPartialCommitError` appeared in any log. The plain-`Error` type is a known upstream gap, `../optimystic/tickets/backlog/bug-concurrent-unique-refusal-is-not-a-constraint-error.md`: a sequential duplicate comes back as `ConstraintError` with code 19, a concurrent one as a bare `Error` with the same message. Sereus classifies by message text anywhere in the cause chain, so it is unaffected; a sApp developer catching by error type would miss the concurrent case. That is worth one sentence in the schema guide, not a sereus ticket.

**Partial-commit error names, checked.** `packages/cadre-core/src/control-write-retry.ts` vetoes retry on `CoordinatorPartialCommitError` by `instanceof` and on the plugin's `PartialCommitError` by its `name`. Upstream still throws both (`CoordinatorPartialCommitError` from the pended batch in either mode, `PartialCommitError` from the per-tree fallback sweep that remains for trees that cannot share one batch), and its docs say a caller must handle both. The 55-test `control-write-retry.spec.ts`, which imports the real upstream class, passes against the rebuilt dist. No code change there.

## What this ticket changes

Nothing about behaviour. It retires the warnings that said the race was broken, keeps the scenario as the permanent guard, and brings the sibling scenario and the pending human-facing ticket into agreement.

- `docs/schema-guide.md`, the paragraph beginning "**Caveat — a column that is `unique` but not the primary key is not yet a safe concurrency guard.**" in the "Ordering Events" section: replace with a short statement that a secondary `unique` column refuses the same-instant loser just as the primary key does, that its row lands nowhere, and that the guard is the scenario file. Add that the refusal is identified by the `UNIQUE constraint failed: <Table>.<Column>` text in the error's message chain, and that a concurrent refusal may arrive as a plain `Error` rather than a `ConstraintError`, so match on the message, not the type (cite the upstream backlog item by slug). Drop the "Tracked in `tickets/blocked/…`" sentence; that path no longer exists.
- `docs/architecture.md` around line 593 ("One narrower arm stays open: the same-tick race on a unique value … `tickets/blocked/concurrent-unique-value-race-commits-both-rows`"): the arm is closed. Name `control-concurrent-unique-column-race` as the third scenario guarding cross-machine uniqueness, beside `control-cross-machine-unique-column` (sequential duplicate on a unique column) and `control-concurrent-same-pk-insert` (same-tick race on the primary key).
- `packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts` header comment, the "DELIBERATELY SEQUENTIAL — do not widen this into a same-tick race" paragraph: keep the file sequential (its property is a uniqueness decision made against a converged view), but the reason is no longer "a still-open defect". Point at the new sibling as the same-tick guard and drop the `blocked/` reference.
- `tickets/blocked/report-schema-guide-concurrency-correction-to-issue-5.md`: its `files:` header and body point at `tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`, and the draft comment's second half tells the public issue that the secondary-unique race is still open. Rewrite that half to say the secondary-unique case is fixed and guarded the same way as the primary-key case (with the "match on the message text" note), and fix the header path. It stays in `blocked/`: posting to the public tracker is still a human's action.
- `packages/integration-tests/src/scenarios/control-concurrent-unique-column-race.integration.ts`: already green; review its header for accuracy against the doc edits above. Keep the per-round `console.log` lines: they record which node lost and what error class it got, which is the one thing a future reader of a green run cannot otherwise see. Three rounds per process is deliberate (the pre-fix outcome reproduced without timing help, and a single round could pass on the two writes simply not overlapping); do not pin a winner.

## TODO

- Edit the schema-guide caveat paragraph as described above; re-read the surrounding "Ordering Events" section so the primary-key and secondary-unique statements read as one argument.
- Edit the architecture.md paragraph; keep the `strand-formation-concurrent-redemption` and `control-cross-machine-unique-column` sentences as they are.
- Rewrite the "DELIBERATELY SEQUENTIAL" paragraph in `control-cross-machine-unique-column.integration.ts`.
- Update `tickets/blocked/report-schema-guide-concurrency-correction-to-issue-5.md` (header `files:` path and the draft comment) so it agrees with the guide as edited.
- Grep for any remaining `blocked/concurrent-unique-value-race-commits-both-rows` reference outside `tickets/complete/` and fix it.
- Run `yarn lint`, `yarn workspace @serfab/integration-tests typecheck`, and the three uniqueness scenarios together in the foreground: `yarn workspace @serfab/integration-tests vitest run src/scenarios/control-concurrent-unique-column-race.integration.ts src/scenarios/control-cross-machine-unique-column.integration.ts src/scenarios/control-concurrent-same-pk-insert.integration.ts --reporter=verbose 2>&1 | tee tickets/.logs/concurrent-unique-value-race-commits-both-rows.implement.log`. Expect all green; a red round in the new file on optimystic `fbf165ee` or later is an upstream regression and belongs in `tickets/.pre-existing-error.md`, not a skip.
- Run `yarn workspace @serfab/cadre-core vitest run test/control-write-retry.spec.ts` once more after the doc edits, as a cheap confirmation nothing in this ticket touched the classifier.
