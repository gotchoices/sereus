description: When a machine's strand join is only half saved (the invitation is recorded as used but the membership row is not), the membership loop now recognises it, prints one clear warning saying a manager has to admit the party, and keeps running, instead of quietly treating it as an already-used invitation. Review the classification, the warning, and the tests.
files: packages/cadre-core/src/strand-membership-reconciler.ts (`classifyConsumeFailure`, `halfCommittedJoin`, `DEAD_INVITE_REJECTION`, `SEALED_REJECTION`, `handleConsumeFailure`, `reportHalfCommittedJoin`, module doc "Half-committed join"), packages/cadre-core/test/strand-membership-reconciler.spec.ts (describes "a half-committed join" and "consume rejection classification", plus the second-holder case), docs/strands.md (end of the "joiner's membership rows land WITH the strand" bullet, ~214)
----
# Review: the reconciler reports a half-committed join

## What changed

The membership reconciler redeems a staged invitation with `consumeInvite`, which writes `Strand.Member` and `Strand.ConsumedInvite` in one SQL transaction. On a networked strand optimystic can report that only some of those collections were saved (`CoordinatorPartialCommitError` from `@optimystic/db-core`, or `PartialCommitError` from the plugin's legacy path). Before this change, that error's message named `default/strand/ConsumedInvite`, the bare-name regex `/NotExpired|NotCancelled|ConsumedInvite/i` matched it, and the reconciler logged "the staged invitation is dead" on the debug channel only.

Now:

- `classifyConsumeFailure(error)` is a pure exported function that returns `{ kind: 'half-committed', saved, unsaved } | { kind: 'sealed' } | { kind: 'dead-invite' } | { kind: 'retry' }`. It walks `causeChain` (control-retry.ts) for either partial-commit class by `instanceof` first. Only after that does it read the top-level message for the sealed and dead-invitation texts. Imports match `control-write-retry.ts`, and a `NOTE:` on `halfCommittedJoin` points to that file's bundling caveat for `PartialCommitError`.
- `handleConsumeFailure` (replaces the old private `classifyConsumeFailure` method) switches on the kind. On `half-committed`, `reportHalfCommittedJoin` prints one `console.warn` in this form: `[sereus] strand <id>: redeeming the staged membership invitation was only partly saved. Saved: [...]. Not saved: [...].` The warning then explains the consequence and names `addMemberByManager`. The full error goes to the debug channel. The staged invitation is cleared, and the loop keeps running without being marked idle, so the next pass comes one ladder step later.
- `DEAD_INVITE_REJECTION` now matches the exact engine texts: `CHECK constraint failed: NotExpired`, `CHECK constraint failed: NotCancelled`, `UNIQUE constraint failed: ConsumedInvite.InviteKey`. These were captured from the real engine on 2026-09-18. **Beyond the ticket:** `SEALED_REJECTION` is anchored the same way, to `CHECK constraint failed: NotSealed`. The engine adds the constraint's expression after that prefix.
- docs/strands.md gets one sentence on the warning and the manager admission.

## Decisions a reviewer should check

- **The invitation is cleared in every half-commit shape, including "`Member` saved, `ConsumedInvite` not".** The ticket's parenthetical ("the member row exists, so the burn arm runs") implies keeping the invitation in that shape, because the burn arm only burns a staged invitation. I did not branch on the shape. The lists are collection ids on the coordinator path, but on the legacy path they are free-form tree labels (`tree.describe?.() ?? 'tree#N'`, `txn-bridge.ts` ~96), so telling the shapes apart would mean parsing another repo's labels. The cost is that in that shape, the bearer credential stays spendable until it expires. That is the same state the burn arm's existing accepted tradeoff already allows. The warning is worded to hold in both shapes: "If this party's Member row is not among the saved…". The `NOTE:` on `reportHalfCommittedJoin` records this, with revisit conditions.
- **Order is half-commit → sealed → dead → retry.** All typed checks come before all text checks. A spec pins that a partial commit whose underlying failure carries `UNIQUE constraint failed: ConsumedInvite.InviteKey` is still classified half-committed.
- **Text checks still read only the top-level message**, as before. They do not use `chainMessages`. All four real engine rejections arrive as a bare `ConstraintError` at the top.
- **Type miss fallback:** if a second loaded copy of db-core or the plugin defeats `instanceof`, the half-commit falls through to `retry`. With the anchored regex it no longer matches as dead on its message. Once the saved `ConsumedInvite` row is visible locally, a later attempt fails on the primary key and the invitation is dropped quietly. That is the old silent outcome, a few passes later. The doc comment on `classifyConsumeFailure` says so.

## Interaction with `strand-writer-transactions-indivisible`

That ticket is still in `implement/` and has not landed. It plans to classify `StrandTransactionBusyError` as retry inside `classifyConsumeFailure`. With this shape, that becomes a `{ kind: 'busy' }` (or `'retry'`) arm checked by type next to `halfCommittedJoin`, before the text checks, plus a `case` in `handleConsumeFailure`. Whichever ticket lands second has to merge into the new function-plus-switch shape, not the old private method.

## Tests (all in `strand-membership-reconciler.spec.ts`)

- "a half-committed join": three shapes (coordinator with ConsumedInvite saved, coordinator with Member saved, legacy `PartialCommitError`). Each is injected by `vi.spyOn(db, 'commit').mockRejectedValueOnce(viaQuereus(error))`, so the writer's own rollback runs. Each asserts one warn with the `[sereus] strand test-strand:` prefix, the exact `Saved: [...]` and `Not saved: [...]` renderings and `addMemberByManager`; the invitation cleared; loop not stopped or done; no dead-invite debug line (captured with `captureDebugLog`). Then `addMemberByManager` runs and the next pass finishes with one `MemberPeer` row and no second warning. A fourth case uses the manual scheduler and asserts `[1000, 4000]`: one ladder step after the half-commit, then the flat poll interval, with `commit` called once (no retry of the spent invitation).
- "consume rejection classification" runs against the real engine: expired, cancelled and consumed-by-another pin their exact messages and classify `dead-invite`; sealed pins the prefix and classifies `sealed`; an unreplicated invite (`CHECK constraint failed: InviteExists`) classifies `retry`. Partial commits classify half-committed when bare, Quereus-wrapped, and rewrapped on `cause`. The bare collection-name text now classifies `retry`.
- The existing second-holder case now also asserts the dead-invite debug line IS emitted and no warn is printed.
- Mutation check: disabling the typed check turned 7 of the new cases red.

## Validation run

- `yarn workspace @serfab/cadre-core test`: 135 files, 2225 passed, 1 skipped. The skip was already there before this change. Log: `tickets/.logs/strand-reconciler-reports-half-committed-join.test.log`.
- `yarn workspace @serfab/cadre-core typecheck` clean, `yarn lint` clean.
- `blind-relay-phone-to-phone-e2e` passed once (1/1, log `tickets/.logs/strand-reconciler-reports-half-committed-join.blind-relay.log`). Running it meant rebuilding the `@serfab/cadre-core` and `@serfab/cadre-host` build output; the stale-build guard flagged cadre-host from an earlier commit. No source changed.

## Known gaps

- **The typed check has not been seen firing on a live error object.** Optimystic has since landed `a-multi-collection-commit-half-lands-when-the-writers-replica-lags` (its HEAD `f0593a9b`), and the one scenario run showed no half-commit. Unit specs build the upstream classes directly and inject them at `db.commit()`, which rests on the same one-loaded-copy assumption as `control-write-retry.ts`. If a half-commit shows up in an integration log again, check that the `[sereus] … only partly saved` warning appears beside it.
- The `tickets/.pre-existing-known.md` Delta 2026-09-17 block still lists this ticket and the upstream regression as open. I left it alone; the triage/unblock pass owns that file. Given the upstream fix, it may be ready to close.
- Whether a half-committed party should be repaired automatically is still `blocked/strand-half-committed-join-recovery`.
