description: A flaw in the shared database library used to let two machines insert a row with the same key at once and silently keep only one. The library fixed it; this work added a permanent two-machine test so the fix cannot quietly regress, and corrected the developer documentation and code comments that still warned about silent data loss.
files:
  - packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts (new, 295 lines)
  - docs/schema-guide.md ("Ordering Events (There Is No Commit-Order Column)": the integer-sequence paragraph rewritten, a new secondary-`unique` caveat)
  - docs/reference-app-rn.md, schemas/chat-simple.qsql (the `Message.Id` rationale comment, kept in step)
  - schemas/chat.qsql (`IdValid` and `MessageAuthorized` comments)
  - packages/cadre-core/src/control-database.ts (`openRevocationLedger` doc comment: stale conditional sentence removed)
  - packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/reference-app-ns/src/chat-operations.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-web/src/lib/chat-dml.ts (UUID-key rationale comments)
----

# Concurrent same-primary-key insert: pinned by a test, and the record corrected

## What landed

**A two-machine regression scenario.** `control-concurrent-same-pk-insert.integration.ts` boots `bootConnectedPair` — two `CadreNode`s of one party with a two-member control cohort confirmed on both sides before the first control write — and runs three cases against `CadreControl.Strand`:

| case | what it drives | what it asserts |
| --- | --- | --- |
| same id | both nodes call `ControlDatabase.insertStrand` with one `Strand.Id` in the same tick | exactly one fulfilled and one rejected; the rejection's cause chain contains `UNIQUE constraint failed: Strand.Id`; `isRetriableControlWriteFailure` is `false` for it; both views converge on exactly one row carrying the winner's `StampId` |
| different ids | the same shape with two distinct ids | both fulfil; both rows reach both views |
| `publishStrand` | `CadreNode.publishStrand(id, 'o')` on both nodes with identical content | both resolve to the same id and type; exactly one row on both views; both views name one founder, and it is one of the two racing machines |

The different-ids case exists so a red same-id case can be told apart from a cohort that is simply not converging. Which node wins is not deterministic, so every assertion is a one-to-one correspondence rather than a fixed winner.

**Nine text corrections** across `docs/`, `schemas/` and code comments that still described a concurrent duplicate-key insert as silently resolved last-writer-wins with a row lost and no error. That behaviour was fixed in `@optimystic/*` and re-measured; the loser now gets the ordinary `UNIQUE constraint failed:` refusal, which the application must handle. `docs/schema-guide.md` additionally gained a caveat that the clean refusal covers the *primary key* only — a secondary `unique` column raced under two different primary keys still stores both rows, tracked in `tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`.

## Review findings

### Checked and clean — with the reason, not just the verdict

- **Every remaining occurrence of the old claim.** Grepped the tree for `last-writer-wins`, `not refused`, `duplicate key`, `silently lost/resolved/overwritten` and `told they succeeded` across `docs/`, `packages/*/src`, `packages/*/test` and `schemas/`. Everything still standing describes a different mechanism: `enrolled-machine-store.ts` and `node-local-slots.ts` (two browser tabs snapshot-writing one storage key), `docs/strand-contracts{,-review}.md` (`KnownDocument`, whose overwrite is intended app semantics), `docs/strands.md` (collection forking, tracked separately). `docs/architecture.md` already stated the corrected behaviour. Archived `tickets/complete/*` entries still quote the old text and were deliberately left — they are the historical record of what was believed then.
- **The embedded copies of the chat schema** in `reference-app-{ns,rn}/src/chat-strand.ts` and `reference-app-web/src/lib/chat-strand.ts` carry no comments, so none of them went stale. `docs/reference-app-rn.md`'s rendering of `schemas/chat-simple.qsql` is an abridged copy by existing convention (its `Role` and `Timestamp` comments already differ), so the two new comments not being byte-identical is not drift.
- **`docs/testing.md` was not updated, and should not have been.** Its topology map states "Each line names one shape and a scenario that exercises it, not every scenario of that shape"; 26 other scenarios are likewise unlisted.
- **The deleted sentence in `openRevocationLedger`'s doc comment.** Verified the replacement claim against the code: the method catches `isRevocationLedgerConflict` and answers `'already-open'`, and both owners file byte-identical marker rows, so the collision is on the composite primary key — the clean-refusal path, not the secondary-`unique` one.
- **The `beforeAll` second-owner enrollment is load-bearing, not cargo cult.** `Strand.AuthorizedInsert` in `schemas/control.qsql` requires the signing key to exist in `OwnerKey`, and `publishStrand` signs with each node's own identity key, which `bootConnectedPair` seats only for A. The digest is built through the shared `buildAuthorizationMessage` and matches the schema's `digest('CadreControl.OwnerKey', 'add', new.Key, new.StampId)`.
- **Falsifiability, checked by mutation rather than by reading.** A throwaway copy of the scenario with case 1's fulfilled-count flipped to 2 was run and went red with the intended diagnostic, which printed the full cause chain: `fulfilled, rejected(UNIQUE constraint failed: Strand.Id <- Tree collection default/cadrecontrol/Strand: key "…" is already taken by a committed entry)`. The copy was deleted.
- **Timeout budgets.** `CONVERGE_MS` 30 s and `CASE_TIMEOUT_MS` 90 s against measured case times of 0.16–1.4 s. The 90 s is a deliberate override of the suite's 60 s default and is headroom for a slow CI box, not slack a race needs. No change.
- **Source hygiene.** One new file, 295 lines, four small named helpers, no `any`, teardown that logs and never rethrows. Consistent with the suite.

### Fixed in this pass (minor)

- **`docs/schema-guide.md` attributed local key generation to Patterns A and B**, which are ordering patterns, not key patterns. Reworded to say what is actually true: their sketches key rows on a value each peer mints for itself.
- **The same paragraph told a schema author to "write the retry" for a gapless integer sequence with no further guidance.** A retry that fires immediately re-collides, because every refused peer recomputes the same next id from the same view. The advice now says the retry needs a randomized backoff.

### Recorded as tripwires, not tickets

- `errorChainText` in the new scenario is a second copy of the same helper in `control-write-degraded-cohort-member.integration.ts` (which is cycle-guarded and joins with ` | `). Two copies of a display-only formatter is under the threshold this suite works to, and the other file is a known-flaky ~4-minute scenario that a refactor could not be validated against cheaply here. `NOTE:` at the new copy says a third one triggers the hoist into `src/harness/`.
- Whether cadre-core should grow a real second-owner writer: answered "no" at the site. Owner rotation is unbuilt, so a public `insertSecondOwnerKey` would be trust-path API exercised only by this test; a `NOTE:` in `beforeAll` says a second scenario needing one puts it in `src/harness/` beside `makeOwnOwner`.
- The implementer's own `NOTE:` at the `publishStrand` case — that which branch the loser takes there is timing, not contract — was reviewed and left as written. It names where a deterministic pin belongs (`publish-strand.spec.ts` against an injected conflict) rather than timing hacks in a network scenario, which is the right call.

### Filed

- `tickets/blocked/report-schema-guide-concurrency-correction-to-issue-5.md` — the public issue `gotchoices/sereus#5` still points readers at the warning this change rewrote. Posting to a public tracker is a human action, so it goes to the human inbox rather than being noted in an archive nobody re-reads. Carries a draft comment covering both halves: the primary-key hazard is gone, and the secondary-`unique` one is newly written down.

### Nothing found in these categories

- **No major findings.** Nothing here needs a `fix/` or `plan/` ticket: the test's assertions are falsifiable and were shown to be, the doc claims were each checked against code or against the measurement that produced them, and the one genuinely open hazard already has its own blocked ticket.
- **No accepted-tradeoff `NOTE:`s were overridden** — none of the sites touched carried one.

## Validation

- `yarn lint` — exit 0, before and after this pass's edits.
- `yarn workspace @serfab/integration-tests typecheck` — exit 0, before and after.
- `yarn workspace @serfab/cadre-core build` — run first, since `control-database.ts` was edited and the stale-build guard otherwise refuses the integration suite.
- `control-concurrent-same-pk-insert.integration.ts` — **five isolated runs in this pass, 3/3 passing every time** (one before the edits, three repeats, one after), on top of the implementer's six. Per-case 0.16–1.4 s. Plus the deliberately-red mutation run described above.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 10 files, 120 passed, 1 todo. This is the suite that loads both edited schema files.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
