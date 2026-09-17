description: A flaw in the shared database library used to let two machines insert a row with the same key at once and silently keep only one. That was fixed in the library; this work adds a permanent two-machine test so the fix cannot quietly regress, and rewrites the developer documentation and code comments that still warned about silent data loss.
files: packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts (new), docs/schema-guide.md, docs/reference-app-rn.md, schemas/chat-simple.qsql, schemas/chat.qsql, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts
difficulty: medium
----

# Review handoff: same-primary-key race pinned, and the record corrected

## What the change is

Two halves, both from `tickets/implement/optimystic-concurrent-same-pk-insert-silent-lww.md`, which had already done the re-measurement and found the upstream fix holding.

**A new two-machine regression scenario** — `packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts`, 3 cases on `bootConnectedPair` (two `CadreNode`s of one party, a two-member control cohort confirmed on both sides before the first control write).

**Nine text corrections** across docs, schemas and code comments that still described a concurrent duplicate-key insert as silently resolved last-writer-wins with a row lost and no error. That is no longer true: the loser now gets the ordinary `UNIQUE constraint failed:` error.

## Use cases the new scenario covers

| case | what it drives | what it asserts |
| --- | --- | --- |
| same id | both nodes call `ControlDatabase.insertStrand` with ONE `Strand.Id` in the same tick (`Promise.allSettled`) | exactly one fulfilled and one rejected; the rejection's cause chain contains `UNIQUE constraint failed: Strand.Id`; `isRetriableControlWriteFailure` on it is `false`; after convergence both nodes' views hold exactly ONE row for that id, carrying the fulfilled writer's `StampId` |
| different ids | the same shape with two distinct ids | both fulfil; both rows reach both views |
| `publishStrand` | `CadreNode.publishStrand(id, 'o')` on both nodes with identical content | both calls resolve; both return the same id/type; exactly one row on both views; both views name ONE founder, and it is one of the two racing machines |

The different-ids case is deliberately in the same file so a red same-id case can be told apart from a cohort that is simply not converging. Which node wins is not deterministic (the ticket's own measurement saw A win 3 of 5); every assertion is a one-to-one correspondence, never a fixed winner.

## How to validate

```
yarn lint
yarn workspace @serfab/integration-tests typecheck
yarn workspace @serfab/integration-tests exec vitest run src/scenarios/control-concurrent-same-pk-insert.integration.ts --reporter=verbose
yarn workspace @serfab/quereus-plugin-sereus test
```

`packages/cadre-core/src/control-database.ts` was edited (a doc comment), so `yarn workspace @serfab/cadre-core build` must run before the integration suite or the stale-build guard refuses the run. That is how it was validated here.

## What was actually run, and the results

- `yarn lint` — clean, twice (before and after the final comment edit).
- `yarn workspace @serfab/integration-tests typecheck` — clean.
- The new scenario, **six isolated runs, 3/3 passing every time**. Four before the `cadre-core` rebuild, two after. Per-case wall clock 170–500 ms; whole file about 11 s including import and the stale-build guard, comfortably inside the suite's 60 s default and the 90 s per-case budget the file sets.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 10 files, 120 passed, 1 todo. This is the suite that loads `schemas/chat.qsql` and `schemas/chat-simple.qsql`, so it covers both edited schema files.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
- The stale-build guard accepted the `../optimystic` build on every run.

## Known gaps — read these before trusting the tests

**The `publishStrand` case's branch coverage is timing, not contract.** Both calls issue their read-first `queryStrand` before either insert commits, so today the loser reaches the insert and is refused, taking the "lost a concurrent founding race" branch. If the two calls ever drift apart the loser would find the row on its READ and no-op through the idempotent branch instead — the same assertions pass, with less coverage, and silently. Parked as a `NOTE:` at the case site, which also says where a deterministic pin would belong (`publish-strand.spec.ts` against an injected conflict) rather than timing hacks in a network scenario.

**The second-owner enrollment in `beforeAll` is hand-built SQL.** `publishStrand` signs with each node's OWN identity-derived owner key, and `bootConnectedPair` only seats A's. There is no cadre-core writer for a second owner — `insertOwnerKey` rides only the empty-owner-set bootstrap branch — so the test inserts B's key through `ControlDatabase.execWrite` with a digest built by the shared `buildAuthorizationMessage`. If the schema's `OwnerKey` `'add'` digest field order ever changes, this fails loudly at `verify` rather than silently, but it IS a second place that encodes that digest. Worth a reviewer's opinion on whether cadre-core should grow a real `insertSecondOwnerKey` writer instead.

**Six runs is not a flake rate.** The cases are sub-second and the race is same-tick, so the sample is cheap to extend; a reviewer wanting more confidence should just run it more.

**`isStrandIdConflict` matching was not re-asserted directly.** The scenario asserts the error TEXT (`UNIQUE constraint failed: Strand.Id`) and that `publishStrand` resolves, which together imply the matcher fired — but no assertion calls `isStrandIdConflict` on the live error. That function is not exported from `@serfab/cadre-core`'s index; exporting it purely for a test seemed worse than the implication. A reviewer may disagree.

## The nine text corrections

The implement ticket named five sites; the "grep once more for `last-writer-wins`" step found four more that had been added since it was written. All nine now describe a refusal that the app must handle, not a silent loss.

- `docs/schema-guide.md` — the two paragraphs under "Not a third pattern: a self-imposed integer sequence …", rewritten. `max(id) + 1` is now described as correct but **contended**: the loser is refused, must recompute and retry, and refusals grow with the number of writers, whereas locally generated ids never contend. "It is a tracked, unresolved limitation" is gone.
- `docs/schema-guide.md` — a NEW caveat paragraph: the clean refusal covers the *primary key*. A secondary `unique` column raced under two different primary keys at the same instant tells the loser it failed but can still store its row, leaving two rows under one unique value. Tracked in `tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`, and the paragraph says to delete it when that lands.
- `docs/reference-app-rn.md` and its source of record `schemas/chat-simple.qsql` — the `Message.Id` comment, kept in step with each other. The e2e spec that reads the schema file extracts by `declare schema` body and a line-anchored `table` count, so it pins no comment text; it passed.
- `schemas/chat.qsql` — the `IdValid` comment (the gapless pattern is contended, not unsafe) and the `MessageAuthorized` NOTE (a replayed signature carries the same primary key and is now refused, concurrently as well as sequentially).
- `packages/cadre-core/src/control-database.ts` — the stale conditional sentence in `openRevocationLedger`'s doc comment, which cited this ticket at its old `tickets/blocked/` path, deleted.
- Four sites the extra grep found: `packages/integration-tests/src/scenarios/convergence-stress.integration.ts`, `packages/reference-app-ns/src/chat-operations.ts`, `packages/reference-app-rn/src/chat-operations.ts`, `packages/reference-app-web/src/lib/chat-dml.ts` — each a UUID-key rationale comment that claimed silent loss.

Three other `last-writer-wins` hits were examined and deliberately left alone, because they describe a different mechanism: `packages/cadre-core/src/enrolled-machine-store.ts` and `packages/reference-app-web/src/lib/node-local-slots.ts` (two browser tabs each snapshot-writing a whole node-local view over one storage key — nothing to do with the database's insert path), and `docs/strand-contracts-review.md` (a design-stage note about `KnownDocument`, whose writes are specified as owner-signed remove-then-add, so the overwrite there is intended app semantics).

## For the human, not for an agent

**`gotchoices/sereus#5` needs a follow-up comment.** The `docs/schema-guide.md` warning that this change rewrote is referenced publicly on that issue, which still points readers at the old "silent last-writer-wins, a tracked unresolved limitation" text. Someone with repo access should comment there that the primary-key case is fixed upstream and re-measured, and that what remains is the secondary-`unique` caveat now recorded in the same section.

## Review focus

- Are the three cases' assertions actually falsifiable? The intended failure signals are: both writers fulfilled (the old defect back), two rows for one id on either view (a torn commit), or a rejection that classifies as retriable.
- The `waitUntil` budgets: `CONVERGE_MS` 30 s per wait, `CASE_TIMEOUT_MS` 90 s per case. Measured cases finish in under half a second, so the headroom is for a slow CI box, not for a race that needs time.
- The hand-built `OwnerKey` insert in `beforeAll` (see gaps above).
- Whether the rewritten `docs/schema-guide.md` advice is what a schema author should actually be told — it now says "use Pattern A or B; if you truly need a gapless integer sequence, write the retry loop", which is a stronger claim than the old text made and nothing in the repo implements such a retry.
