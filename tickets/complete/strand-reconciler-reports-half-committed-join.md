description: When a machine's strand join is only half saved (the invitation is recorded as used but the membership row is not), the membership loop now recognises it, prints one clear warning saying a manager has to admit the party, and keeps running, instead of quietly treating it as an already-used invitation.
files: packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, docs/strands.md, tickets/implement/strand-writer-transactions-indivisible.md
----
# The reconciler reports a half-committed join

## What landed

- `classifyConsumeFailure(error)` in `strand-membership-reconciler.ts` is an exported pure function returning a `ConsumeFailure`: `half-committed` (with the `saved` and `unsaved` lists), `sealed`, `dead-invite` or `retry`. It checks the `cause` chain for optimystic's `CoordinatorPartialCommitError` or the plugin's legacy `PartialCommitError` by type first. Only after that does it test the top-level message against the sealed and dead-invitation texts.
- `DEAD_INVITE_REJECTION` and `SEALED_REJECTION` now match the engine's full constraint-failure texts (`CHECK constraint failed: NotExpired|NotCancelled|NotSealed`, `UNIQUE constraint failed: ConsumedInvite.InviteKey`), not bare names. Specs pin the texts against the real engine.
- `handleConsumeFailure` switches on the kind. For a half-commit, `reportHalfCommittedJoin` prints one `console.warn` naming both halves and `addMemberByManager`, sends the full error to the debug channel and clears the staged invitation. The loop keeps running.
- One sentence in `docs/strands.md` describes the warning and the manager admission.
- Whether sereus should repair such a join itself is still `blocked/strand-half-committed-join-recovery`.

## Review findings

Read the implement diff (`3b1557d7`) first, then the whole reconciler, `inStrandTransaction` and `consumeInvite` in `strand-membership-writer.ts`, `causeChain` in `control-retry.ts`, the `PartialCommitError` NOTE in `control-write-retry.ts`, and both upstream error classes (`optimystic/packages/db-core/src/transaction/errors.ts`, `quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`).

**Correctness: one minor defect, fixed.** After a half-commit clears the invitation, every later pass is idle (no `Member` row, nothing staged). After `IDLE_PASSES_BEFORE_ESCALATION` (10) passes, the existing idle escalation printed a *second* warning: "a joiner is waiting on the founder rows to replicate". That breaks the ticket's "one clear warning" and names the wrong cause. Fix: `reportHalfCommittedJoin` now sets `idleEscalated`, with a one-line comment giving the reason. New spec "after a half-committed join, the idle passes that follow add no escalation warning" runs 12 passes and asserts exactly one warn, the half-commit one. A mutation check (the new line disabled) turned the spec red.

**Classification order and fallbacks: no issue.** Typed checks run before text checks. The upstream message embeds the underlying failure's text, and a spec covers that case. `causeChain` stops on cycles. `failedCollections` can be empty upstream ("failure came after every collection was already saved"). The warning then renders `Not saved: []`, and its conditional wording ("If this party's Member row is not among the saved…") still holds. The fallback when `instanceof` fails on a second loaded copy of db-core or the plugin is documented on `classifyConsumeFailure`. It carries the same one-copy assumption as `control-write-retry.ts` and has a NOTE pointing there.

**Design decision (drop the invitation in every half-commit shape): agree.** Telling the shapes apart would mean parsing free-form tree labels from the legacy path, which AGENTS.md forbids ("no half-baked parsers"). The NOTE on `reportHalfCommittedJoin` states the cost and when to revisit, and the burn arm's existing accepted-tradeoff covers the same state.

**DRY / hygiene: one minor fix.** `resolveKeyPair` repeated the new `errorMessage` helper's expression inline. It now calls the helper. The reconciler is 646 lines and the spec 852 (`wc -l`). Both files are large but organised into single-purpose methods and describe blocks, so no split is filed.

**Error handling / resource cleanup: no issue.** `inStrandTransaction` rolls back and rethrows the original error unchanged. The specs inject at `db.commit()`, so that rollback path is exercised. No timers or handles are added.

**Type safety: no issue.** `ConsumeFailure` is a discriminated union and the `switch` covers every kind. No `any`.

**Tests: adequate, plus one added.** The implementer's specs cover three half-commit shapes, recovery through `addMemberByManager`, the ladder-then-flat scheduling, real-engine texts for every rejection, wrapped and rewrapped partial commits, and the second-holder regression. The spec added in this review covers the gap listed above.

**Docs: checked, accurate.** The `docs/strands.md` sentence holds, and after the fix "one `console.warn`" is literally true. The module doc's "Half-committed join" section matches the code. No other doc refers to the old bare-name regex.

**Cross-ticket: note appended.** `implement/strand-writer-transactions-indivisible` planned to add its busy refusal inside the old private `classifyConsumeFailure` method. I appended a sub-bullet there describing the new function-plus-`switch` shape and where its arm and spec go.

**Tripwires: none new.** The existing NOTEs (burn-arm tradeoff, `PartialCommitError` bundling, the half-commit shape NOTE) already cover the conditional concerns.

**Validation.**
- `yarn workspace @serfab/cadre-core typecheck`: clean. `yarn lint`: clean.
- Reconciler spec: 37/37 pass.
- Full `yarn workspace @serfab/cadre-core test` (log `tickets/.logs/strand-reconciler-reports-half-committed-join.review.test.log`): 133/135 files passed. The two failures were OS resource exhaustion under load, not assertions: `listen ENOBUFS: no buffer space available` in `device-token-registry.spec.ts`, and `UNKNOWN: unknown error, read` loading `strand-membership-manager-rotation.spec.ts`. Re-running those two files alone passed 45/45, so no pre-existing-error file was written.
- I did not re-run the integration e2e. The review changes touch only the idle-warning latch and a log string.

**Known gaps carried forward (from the handoff).** The typed check has not been seen firing on a live optimystic error object, only on constructed instances injected at `db.commit()`. If a half-commit shows up in an integration log, check that the `[sereus] … only partly saved` warning appears beside it. The `tickets/.pre-existing-known.md` Delta 2026-09-17 entry is left for the triage pass.
