description: After someone is removed from a shared workspace, sending them a fresh invitation looks like it worked but silently achieves nothing — their device never even tries to accept it. Their device now tries, keeps trying, and tells the app when it cannot get back in.
architecture: docs/strands.md#removing-members
files: packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/cadre-node-strand-membership-hooks.spec.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/reference-app-web/src/lib/store.svelte.ts, docs/strands.md, docs/testing.md
repro: verified
difficulty: hard
----

# A fresh invitation re-arms the membership loop, and the dead end is reported

## What shipped

A party removed from a closed strand could be handed a fresh membership invitation (invitations travel the control network, which strand removal does not touch). Its node staged the invitation, and nothing ever redeemed it: the per-strand background loop that would (`StrandMembershipReconciler`) had latched a terminal stopped state when the party first joined, and only a strand relaunch built a new one. The redemption was not refused, not retried and not reported.

Now:

- **The loop distinguishes re-armable stops from permanent ones.** Done, and "self-revoked with nothing staged", can be reopened by a fresh invitation through the new `rearm()`. A sealed strand, an undecodable party key, and the public `stop()` (which `releaseRuntime` and `clearOwnMemberPeerBinding` call and mean) are permanent; `rearm()` is a no-op after them. The reopen runs at the head of the queued pass, after any in-flight pass has settled, so a pass that latches done mid-flight cannot swallow it and a `stop()` that lands first still wins.
- **A staged invitation is never dropped while it is still redeemable.** Burn failures in the already-member arm go through the same classifier as redemption failures. The invitation is cleared only on success, a dead invitation, or a sealed strand; it stays staged on busy and on any refused write. The done state requires the binding in place and nothing staged.
- **The seam's clear is compare-and-swap.** `PendingMembershipInviteSource.clear(settled)` drops the entry only if `settled` is still the staged invitation, so a re-formation that replaces the entry mid-pass keeps its fresh one. `CadreNode.unstageMembershipInvite` implements it.
- **The dead end is reported once per re-arm cycle**: one `console.warn` plus a new `strand:rejoin-blocked` event on `CadreNode`, wired like `strand:revoked`. Confirmed trigger: self-revoked with an invitation staged (the pass reports and carries on). Probable trigger: `UNFINISHED_PASSES_BEFORE_ESCALATION` (10) consecutive attempted passes left the invitation staged; the warning names both causes (removed and refused, or the invitation row not replicated here yet) and the remedy (`addMemberByManager`).
- **Wiring**: `CadreNode.adoptFormationMembershipInvite` stages and then calls `StrandInstanceManager.notifyMembershipInviteStaged`, which forwards to `rearm()` or logs when no reconciler is armed. The reference web app records the new event. `docs/strands.md` and `docs/testing.md` describe the post-fix reality.
- **Integration test 2** of the party-removal scenario now waits for the `strand:rejoin-blocked` report, asserts the credential stays staged and the cut holds, then re-admits by manager and waits for the still-running loop to spend the invitation by itself (the `ConsumedInvite` row lands on the remaining party's replica).

## Review findings

**Read first, with fresh eyes:** the implement diff (`117044d8`) in full, then the current reconciler source top to bottom, the manager's reconciler lifecycle (`buildStrandRuntime`, `releaseRuntime`, `clearOwnMemberPeerBinding`, `publishDatabase`), the node's staging and leave paths, the enforcer's self-revoked flag lifecycle (`trackSelfRevoked` clears it on the next refresh that finds the party a member again), all three touched specs, the rewritten integration test, both docs, and the reference-app-web store. The reference-app-rn does not subscribe to `strand:revoked`, so it needs no parallel `strand:rejoin-blocked` subscription.

**Correctness, checked by reading and running:**

- Serialization holds: `rearm()` and `reconcile()` both chain on the same never-rejecting tail, so no two passes overlap and the reopen cannot be swallowed by a pass in flight. A permanent `stop()` queued before the re-arm's pass is respected because `reopen()` re-checks the latch when the pass starts.
- `halt()` latches `permanentlyStopped` even on an already-stopped loop, so a done loop that `releaseRuntime` then stops cannot be reopened. The manager also deletes its map entry, so `notifyMembershipInviteStaged` cannot find it anyway.
- On a removed party whose replica still shows the member row, each pass refuses the burn, keeps the invitation staged, tries the binding (insert-if-absent finds the one from the first join, since removal does not delete `MemberPeer` rows), sees the invitation still staged, and stays live. Counted toward the probable trigger via the `finally` in `attempt()`, including when the membership read itself throws.
- A `dead-invite` or `sealed` classification of a burn drops the invitation while the party is a member: correct, since a member's leftover credential has no further use and nobody can be admitted to a sealed strand.
- The confirmed and probable triggers share one latch, so a self-revoked report is not followed by a probable report in the same cycle. Verified by the self-revoked spec and by reading `reportRejoinBlocked`.
- `rearm()` on a loop whose `start()` never ran (unit tests only) runs the one pass and schedules no timer, because `scheduleNext` requires `started`. In production `start()` always runs right after construction.

**Minor, fixed inline:**

- The `UNFINISHED_PASSES_BEFORE_ESCALATION` doc said "about five minutes"; ten passes on the ladder (1, 2, 4, 8, 16 s, then five at the 30 s cap) is about three minutes. Corrected.
- `types.ts` and the manager's `onRejoinBlocked` doc said the report fires "at most once per staged invitation", while the reconciler says once per re-arm cycle. A fresh invitation staged on a still-running loop does not reset the latch, so the reconciler's wording is the true one; both docs now say so.

**Tripwires recorded as `NOTE:` at the site (no ticket):**

- `strand-membership-reconciler.ts`, `reopen()`'s running-loop branch: a party whose loop already reported and is then re-formed again gets no second report for the replacement invitation. If that is ever wanted, key the latch on the invitation key. The handoff listed this as a known gap; it now has a site.
- `strand-membership-reconciler.ts`, the self-revoked stop in `doPass()`: the enforcer's self-revoked flag lags a re-admission by up to one poll. If the pass that settled the last staged invitation then failed to write the binding, the next pass stops with the binding missing until the next resume rebuilds the loop. A missing binding only mis-credits diversity today; revisit if the binding ever gates admission.

**Major findings:** none. The compare-and-swap clear that the handoff asked the reviewer to weigh belongs in this ticket: without it, the fix would introduce a new way to drop a redeemable invitation silently, which is the exact class the ticket retires.

**Tests:** all six new reconciler cases pin a contract rather than the implementation (re-arm redeems, `stop()` is permanent, refused burn keeps the invitation and does not latch done, confirmed report once and carries on, settling by name keeps a mid-pass replacement, probable report once with both causes named). The hooks spec's new case pins the node's compare-and-swap. None cut, none added: every defect-shaped question I had was answered by an existing case or by reading the code.

**Docs:** `docs/strands.md` (re-admission bullet, unspent-invitation bullet, known-gaps paragraph) and `docs/testing.md` (scenario description) match the shipped behaviour. The stale `Tracked as backlog/...` line survives only in the git-ignored `packages/integration-tests/dist` build output, which the next build replaces.

**Accepted tradeoffs respected:** the burn arm's earlier "never retried" tradeoff `NOTE:` was replaced by the implementer with one recording why the old decision no longer holds; the dead-invitation ladder tradeoff and the two-commit join tradeoff are untouched and their revisit conditions have not tripped.

## Validation

| Command | Result |
| --- | --- |
| `yarn lint` (after the inline fixes) | clean |
| `yarn typecheck` | clean |
| `yarn workspace @serfab/cadre-core test` (full suite, after the inline fixes) | 138 files, 2271 passed, 1 skipped |
| `strand-membership-reconciler`, `cadre-node-strand-membership-hooks`, `strand-instance-manager-membership` specs | 67 passed |
| `strand-party-removal-via-formation-e2e` (integration) | **not re-run in review**: blocked on the sibling `../quereus` build |

The integration scenario could not be re-run here. The stale-build guard reports `@quereus/quereus: dist is stale`, and `../quereus` has uncommitted source edits made during this pass (its `packages/quereus/src/core/database.ts` was modified at 12:57), so per `tickets/rules/sibling-repos.md` it was not built. My edits in this pass are comments and doc text only, so the implementer's runs stand as the scenario evidence: both tests passed on the final build, and test 2 passed 3 of 3 serial runs (`tickets/.logs/bug-removed-party-cannot-redeem-its-way-back.rejoin-run{1,2,3}.log`). Anyone re-running it should wait for the sibling's own build to land rather than building it.

## Residuals (declared out of scope by the fix ticket, unchanged)

Admitting a machine that merely presents a valid unspent invitation (the revoked-peer gate carve-out), rotating the strand's read key, clawing back replicated data, and persisting the staged invitation across a process restart. A first join whose invitation row takes longer than ten passes to replicate emits the probable warning with the replication cause named; nothing stops. Busy passes count toward the probable trigger, judged acceptable because a strand transaction held open across ten passes is itself a stuck join.
