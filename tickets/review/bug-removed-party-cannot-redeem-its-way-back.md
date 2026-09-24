description: After someone is removed from a shared workspace, sending them a fresh invitation looks like it worked but silently achieves nothing — their device never even tries to accept it. Their device now tries, keeps trying, and tells the app when it cannot get back in.
architecture: docs/strands.md#removing-members
files: packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/cadre-node-strand-membership-hooks.spec.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/reference-app-web/src/lib/store.svelte.ts, docs/strands.md, docs/testing.md
repro: verified
difficulty: hard
----

# Review handoff: a fresh invitation re-arms the membership loop, and the dead end is reported

## What was wrong

A party removed from a closed strand could be handed a fresh membership invitation (invitations travel the control network, which strand removal does not touch). Its node accepted and staged the invitation, and nothing ever redeemed it: the per-strand background loop that would (`StrandMembershipReconciler`) had latched a terminal stopped state when the party first joined, `start()` refused to run again on that latch, and only a strand relaunch built a new loop. So the redemption was not refused, not retried and not reported.

## What changed

### The loop can be re-armed, and only from the right stops

`StrandMembershipReconciler` now distinguishes two kinds of stop. A re-armable stop is one a fresh invitation should reopen: the done state, and "self-revoked with nothing staged". A permanent stop is one a fresh invitation changes nothing about: a sealed strand, an undecodable party key, and the public `stop()` (which `releaseRuntime` and `clearOwnMemberPeerBinding` call and mean — the latter stops and awaits `settle()` precisely so no pass can re-register the binding it is about to delete). A new `rearm()` reopens a re-armable stop, resets the idle counter, both escalation latches, the new unfinished-pass counter and the retry ladder, and runs one pass; on a running loop it is a plain kick; after a permanent stop it is a no-op.

The re-arm runs at the head of the queued pass, after any pass in flight has settled, rather than synchronously. Otherwise a pass mid-flight that latches done after the re-arm's flag reset would swallow it, and a `stop()` that lands between the call and the pass would be undone — the queued pass re-checks the permanent latch when it starts.

### A staged invitation is never dropped while it is still redeemable, and done waits for it

On a removed party the local replica usually still shows the party as a member (the cohort cut it off at about the moment the removal was written), so a re-armed pass lands in the already-member arm and tries to burn the invitation. That burn is a strand write the cohort refuses. Today's code dropped the invitation on any non-busy burn failure and latched done, which would have destroyed the fresh credential silently. Now:

- Burn failures go through the same classifier as redemption failures (`classifyConsumeFailure`, doc widened to say it serves both writes). The invitation is cleared only on success, a dead invitation, or a sealed strand (a member's leftover credential is merely dead, not terminal); it stays staged on busy and on any refused or unclassified write.
- The done state requires the binding in place and nothing staged. A binding written while a burn keeps being refused leaves the loop live.
- The accepted-tradeoff `NOTE:` on `burnLeftoverInvite` ("a transient burn failure is never retried") is replaced by one recording the new rule and why the old decision no longer holds.

### The seam's clear is now compare-and-swap (beyond the ticket's listed changes)

`PendingMembershipInviteSource.clear()` took no argument and deleted whatever was staged. With the loop re-armable, a re-formation that replaces the staged entry between a pass's read and its settle would have its fresh invitation deleted when the pass settled the older one — silently, the outcome this ticket exists to prevent. `clear(settled)` now drops the entry only if `settled` is still the staged invitation (matched by invite key). `CadreNode.unstageMembershipInvite` implements it; the reconciler passes the invitation it acted on at every settle site. The reviewer should weigh whether this belongs in this ticket; it is small, and the ticket's theme is "never drop a redeemable invitation silently".

### The dead end is reported

Two triggers, one report, at most once per re-arm cycle: one `console.warn` in the reconciler's existing style, plus a new `strand:rejoin-blocked` event on `CadreNode` (`{ strandId }`), wired reconciler dep → `StartStrandConfig.onRejoinBlocked` → `CadreNode.emit`, exactly as `strand:revoked` is wired. Documented in `types.ts` beside `strand:revoked`, including that the probable trigger is a suspicion.

- Confirmed: a pass finds the party self-revoked and an invitation staged. The pass reports and carries on (the redemption is attempted and refused like any other write); a manager's re-admission lets a later pass finish. Self-revoked with nothing staged still stops, re-armably.
- Probable: `UNFINISHED_PASSES_BEFORE_ESCALATION` (10, exported) consecutive attempted passes left the invitation staged. Counted by outcome rather than by classified failure, because on a cut-off machine even the membership read can throw before any write is classified. Passes with no live database do not count (nothing was attempted). The warning names both causes (removed and refused, or the invitation row not replicated here yet) and the remedy (`addMemberByManager`).

### Wiring

`CadreNode.adoptFormationMembershipInvite` stages the invitation and then calls the new `StrandInstanceManager.notifyMembershipInviteStaged(strandId)`, which forwards to `rearm()` or logs when no reconciler is armed (a first join has none yet; bring-up finds the invitation normally). The two `NOTE:` blocks that described this bug as unfixed are deleted. The reference web app records the new event beside `strand:revoked`.

## What a real run showed

Integration test 2 was run first with the old assertions replaced by the expected shape, with `DEBUG=sereus:cadre:strand-membership-reconciler,sereus:cadre:strand-revocation`. What actually happens on the removed machine:

- Its replica had the removal (the cohort committed the delete to it before the cut), so every re-armed pass takes the redemption arm and fails locally on `CHECK constraint failed: InviteExists`: the second invitation's row was written into the cohort it is cut off from and never replicates to it. Each pass also dials the hosts, which refuse it at the encryption stage (bursts of `denyInboundEncryptedConnection` on the host side).
- Ten such passes take about 19 seconds at the test's 2 s cadence, then the probable report fires once. It is probable and not confirmed by construction: the removed machine's own revoked-peer gate polls on a suspended interval and the test never refreshes it, so the node never learns it was removed. That is the field shape too.
- After a remaining manager re-admits the party and the hosts refresh, the removed machine reconnects to the host by itself on its next pass, sees the restored member row, burns the leftover invitation (the `ConsumedInvite` row lands on the host's replica), un-stages it and finishes. No second report.

One choreography race surfaced in the first run: the test dialed the host explicitly right after re-admission, and libp2p coalesces concurrent dials to one peer, so the explicit dial joined one of the loop's own in-flight dials that the gate had just refused (`EncryptionFailedError: Unexpected EOF`). The test now gates on the removed machine reconnecting by itself instead of dialing, and the comment records the measurement.

## Tests

- `strand-membership-reconciler.spec.ts`, new `describe('re-arming on a fresh invitation')`:
  - a done loop whose party was removed, handed a fresh invitation and re-armed, redeems it and seats the member row again;
  - the public `stop()` is permanent: a later re-arm writes nothing;
  - a stale member row with a refused burn keeps the invitation staged and does not latch done; the next pass burns it and finishes;
  - self-revoked with an invitation staged reports once (warning matches the confirmed sentence and names `addMemberByManager`), fires the callback once, keeps going, and finishes without a second report once the write lands;
  - settling an older invitation never un-stages a fresh one staged mid-pass (the slot mirrors `CadreNode`'s compare-and-swap);
  - ten refused passes report a probable blocked re-join once, with both causes named.
- `strand-membership-reconciler.spec.ts`, the existing self-revoked test now stages no invitation, since with one staged the loop no longer stops. A `phantomInvite()` helper replaced three copies of the same key-minting lines.
- `cadre-node-strand-membership-hooks.spec.ts`: one new case, `clear()` of a replaced invitation leaves the fresh one staged; the existing clear case passes the invitation it clears.
- Integration test 2 of `strand-party-removal-via-formation-e2e.integration.ts` rewritten as described above; its file-head "TWO TESTS" section and the budget constant (`REJOIN_REPORT_BUDGET_MS`, 120 s, replacing the 8 s no-self-readmission sleep) updated. Test 1 untouched.
- Not tested, deliberately: the `CadreNode` → manager → reconciler notification path (wiring; the manager-membership spec mocks the reconciler and covers arming and lifecycle).

## Validation

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` (full suite, final code) | 138 files, 2271 passed, 1 skipped |
| `strand-party-removal-via-formation-e2e` (both tests, final build) | 2 passed; test 2 additionally passed 3 of 3 serial runs |
| `strand-removal-cuts-network`, `strand-membership-closed-strand-e2e`, `strand-membership-second-machine` | 13 passed |
| `yarn lint` | clean |
| `yarn typecheck` | clean |

The stale-build guard was intermittently tripped during this pass by `../quereus` (an agent there had uncommitted source edits and rebuilt periodically). Every run above was made while the guard passed; the sibling was not built or touched. If the reviewer hits the guard, wait and retry rather than building the sibling (`tickets/rules/sibling-repos.md`). Run logs are in `tickets/.logs/bug-removed-party-cannot-redeem-its-way-back.*.log`; `rejoin2.log` is the debug-rich passing run the "What a real run showed" section describes.

## Known gaps and things to look at

- **Probable trigger on a slow first join.** A first join whose invitation row takes longer than ten passes to replicate (about five minutes at the production cadence, about 20 s at the integration cadence) now emits the probable warning and event. The message names that cause explicitly, and nothing stops. Cheap to hit in a slow test topology; harmless, but worth knowing.
- **Busy passes count toward the probable trigger.** An app that holds a strand transaction open across ten consecutive passes gets the warning with a misattributed cause. Judged acceptable: that is itself a stuck join, and excluding busy would have meant classifying every path (including thrown reads) rather than counting by outcome.
- **A running loop handed a fresh invitation is only kicked**, per the ticket: its counters and the once-per-cycle report latch are not reset. A party whose loop already reported and then re-forms again gets no second report for the new invitation.
- **Residuals the ticket declared out of scope, unchanged:** admitting a machine that merely presents a valid unspent invitation (the revoked-peer gate carve-out), rotating the strand's read key, clawing back replicated data, and persisting the staged invitation across a process restart.
- **Docs**: `docs/strands.md` re-admission and unspent-invitation bullets and the known-gaps paragraph rewritten to the post-fix reality; `docs/testing.md`'s description of the scenario updated.
