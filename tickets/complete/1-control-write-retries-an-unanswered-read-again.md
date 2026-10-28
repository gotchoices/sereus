description: Under Optimystic 1.20.0, a read inside a control write that no peer answers fails with a typed "block unavailable" error instead of the old aggregate error, and the write retry stopped recognising it. The write retry now recognises that error by type, using one check shared with the read retry, so a write such as `registerSelf()` racing a forming connection is retried again.
architecture: docs/cadre-consistency.md
files: packages/cadre-core/src/control-retry.ts (`reportsUnreachableCohort`), packages/cadre-core/src/control-write-retry.ts (`matchesRetriableFailure` and its NOTE, promise-phase paragraph in `isUncommittedTransactorAggregate`'s accepted-tradeoff NOTE), packages/cadre-core/src/control-read-retry.ts (`isRetriableControlReadFailure`, NOTE on the local `isCohortUnreachableRead`), packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-read-retry.spec.ts, docs/architecture.md ("What is retried" → "A block read the cohort could not answer"; the control-read retry bullet; "The classifier is not widened…")
----
## What was built

Landed in `ticket(implement): control-write-retries-an-unanswered-read-again`.

- `reportsUnreachableCohort(links)` in `control-retry.ts`: true when any link of an error's `cause` chain is a `BlockUnavailableError` with reason `peers-unreachable` or `cohort-unreachable`. It delegates to upstream's `isCohortUnreachableRead` (`@optimystic/db-core` 1.20.0, `transaction/commit-failure-class.ts`). The doc for the reasons and their measured exclusions now lives on this function.
- Writes: `matchesRetriableFailure`, the shared body of the default, schema-init and lost-update classifiers, claims that predicate after both vetoes (possibly-stored write by type, commit-phase `[blocks:` batch by text).
- Reads: `isRetriableControlReadFailure` uses the same predicate in place of the deleted text regex. The transactor aggregate is still matched by text.
- The promise-phase list in the accepted-tradeoff NOTE, the spec constant's comment and `docs/architecture.md` now name what 1.20.0 members actually refuse: stale revision, membership-not-admitted, expiry, a configured validator's refusal. Block-unavailable is approved, not refused.
- Tests: one `describe.each` over the three write classifiers for the typed unanswered read (bare, through Quereus, and vetoed under a `[blocks:` aggregate). The read spec now builds real `BlockUnavailableError` / `BlockPossiblyStaleError` objects, and pins that the same words as plain text match nothing.

Known gaps, carried from implement: the change slightly widens write retries (a coordinator-reported `peers-unreachable` / `cohort-unreachable` was not retried by writes on 1.19 either). It was not verified live in a two-node run; the `adopt-optimystic-1-20-0` gate runs the degraded-cohort scenarios.

## Review findings

**Checked by reading upstream.**
- `isCohortUnreachableRead` is exported from the built `db-core` dist, and its reason set is exactly `{cohort-unreachable, peers-unreachable}`.
- `BlockUnavailableError` is built in only two places, both on the reading node (`answeredBlock` in `transactor-source.ts`, `NetworkTransactor.getStatus`). So matching by type cannot be triggered by a peer's error text.
- `peers-unreachable` is produced by `NetworkTransactor.get` for a block no coordinator answered (~455) and by `CoordinatorRepo` for an unconfirmed absence.
- `AttemptCycle.refreshUntilSettled` rethrows anything but a `completion-refused` `TornActionError`. So a typed read failure in the refresh does reach the funnel, as the implement handoff said.

**Using upstream's reason set instead of a local constant: kept.** The set is defined as "the cohort could not be reached", and upstream uses the same rule to sort commit failures, so following it is the right default. The NOTE on `reportsUnreachableCohort` says to re-check the exclusions if upstream ever widens the set.

**Safety of retrying an unanswered read that happens after the log entry is stored (the reviewer probe).** The implementer's NOTE cited the `[blocks:` veto's rationale as the reason this is safe. That rationale is the reason commit-phase failures are *declined*, so the citation argued the wrong way. The sound argument is precedent: before this change, the same refresh reads (`readLogEnds`, and `getStatus` on a forked lineage) already raised the `[block:` aggregate, which the text matcher already retried. The typed claim therefore adds no new post-store case. The re-run re-reads the blocks, so it diffs to nothing or fails on `UNIQUE` where the earlier write landed, and writes once where it did not. I rewrote the NOTE in `matchesRetriableFailure` and the matching sentence in `docs/architecture.md` to say this. The NOTE also now names the log-end reads as the common route, with `getStatus` second. I did not re-derive the safety argument body by body for all ~19 control-write bodies. This change adds no case the existing aggregate retry did not already cover, so that audit belongs with the aggregate retry, not this ticket.

**Docs.**
- `docs/architecture.md`'s control-read retry bullet now says the unavailability is matched by type through the predicate shared with writes.
- The same bullet pointed at `blocked/block-held-by-only-one-machine-is-unreadable` as an open upstream cause. That ticket is complete, fixed in db-p2p 0.28.0, and the code comment already says so. The bullet now says the measured cause was fixed and a `claimed-elsewhere` seen now is a new defect.
- `docs/cadre-consistency.md` (the anchor) does not describe the retry classifiers, so nothing there changed.

**Interactions.**
- `member-redemption.ts` `writeFailureRefusal` uses the write classifier. An unanswered read during redemption now maps to `conflict` (retryable) instead of `internal`. Both are retryable for the holder, and `conflict` is the more accurate code.
- `control-schema-apply-unwind.spec.ts` relies on `unmaterializable` staying non-retriable. It still is.
- The strand `BlockUnavailableError` comments (`strand-revocation-enforcer.ts`) are about strand writes, which do not use this classifier. They are unaffected.

**Tests.** The new write `describe.each` pins a contract with real branching (the claim sits after the vetoes, in the body all three policies share). Kept. The read-spec conversions replace text fixtures with the real classes, which the switch to type-matching requires. Kept. No test added: the review changed only comments and docs.

**Hygiene.**
- `control-write-retry.ts` is 661 lines. It was already large before this ticket, which added about 20 lines, mostly comments.
- The opening paragraph of `isRetriableControlWriteFailure`'s doc still leads with "classifies by MESSAGE". The paragraph after it names the two typed claims, so I left it.
- No narrated statements found.

**Tripwires.** Nothing new to record. The existing NOTEs already cover what can drift: upstream widening the reason set, a second loaded copy of db-core, and the local `isCohortUnreachableRead` name collision.

**Not found in these categories:** no resource-cleanup or performance concerns (the predicate walks the same short `cause` chain the vetoes already walk), and no type-safety issues (`isCohortUnreachableRead` takes `unknown` and is a type guard).

**Validation.** `yarn typecheck` passes. `yarn lint` passes. `control-write-retry.spec.ts` + `control-read-retry.spec.ts`: 98 passed. The review changed only comments and docs, so I did not re-run the full cadre-core suite; implement's full run was 2550 passed and 1 Windows-only skip.
