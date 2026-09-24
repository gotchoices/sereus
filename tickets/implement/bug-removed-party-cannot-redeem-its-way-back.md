description: After someone is removed from a shared workspace, sending them a fresh invitation looks like it worked but silently achieves nothing — their device never even tries to accept it. Make the device try, and tell both sides when it cannot get back in.
architecture: docs/strands.md#removing-members
files: packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, docs/strands.md
repro: verified
difficulty: hard
----

# Re-arm the membership loop on a fresh invitation, and report the dead end

## The defect, in one paragraph

A party removed from a closed strand can be handed a fresh invitation — invitations travel the control network, which strand removal does not touch — and its node accepts it, persists the same party identity, and stages the credential. Nothing then redeems it. The one background loop that would (`StrandMembershipReconciler`, one per strand per machine) finished during the original join and latched a terminal stopped state; `start()` early-returns on that latch and only a strand relaunch builds a new loop. So the redemption is not refused, not retried and not reported. Behind that sits a second dead end that is real but never reached today: redeeming writes a `Strand.Member` row into the strand, and the machines that would carry that write are the ones the remaining members are refusing.

The end-to-end reproduction is test 2 of `packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts` ("re-joining after removal"), which already pins the current behaviour and says in its own comments that a fix flips its final assertion.

## Scope

Two of the three shapes the fix ticket weighed:

1. A fresh invitation staged after the loop finished is actually attempted.
2. When the attempt cannot succeed, both sides are told instead of sitting silent.

**Out of scope, deliberately:** admitting a machine that merely presents a valid unspent invitation (a carve-out in the revoked-peer gate). That changes the removal security posture and is the maintainer's call, not this ticket's. Also out of scope: rotating the strand's shared read key, clawing back replicated data, and persisting the staged invitation across a process restart — all documented residuals.

## The three code changes

### 1. The loop can be re-armed, and only from the right stops

`StrandMembershipReconciler.stop()` currently latches one `stoppedFlag` for four very different reasons, and `start()` refuses to run again on any of them. Split the terminal stops into re-armable and permanent, and add a way back in.

Re-armable stops (a fresh invitation is exactly the thing that should reopen them):

- the `done` path — member row seated and this machine's binding written;
- the self-revoked stop — this node's own party is flagged revoked by the enforcer.

Permanent stops (a fresh invitation changes nothing about them):

- sealed strand (`ConsumedInvite.NotSealed`): nobody can ever be admitted;
- undecodable party key: nothing can be signed;
- **the public `stop()`** — `releaseRuntime` and `clearOwnMemberPeerBinding` both call it and mean it. `clearOwnMemberPeerBinding` in particular stops the loop and awaits `settle()` precisely so no pass can re-register the binding it is about to delete; a later re-arm that restarted the loop would undo that. `releaseRuntime` also deletes the reconciler from the manager's map, so only the `clearOwnMemberPeerBinding` path (reached from `CadreNode.unpublishStrand`) is actually exposed here — but make the rule structural rather than relying on the map.

The re-arm itself clears the stopped and done latches, resets the idle counter, the idle-escalation latch, the "no redemption is happening" escalation latch (below) and the retry ladder, and kicks one immediate pass. It is a no-op when the last stop was permanent, and a plain kick when the loop is still running.

### 2. A staged invitation is never dropped while it is still redeemable — and `done` waits for it

This is the part the fix ticket did not anticipate and the part most likely to be got wrong, so read it before writing any code.

`ensureMembership` checks `isStrandMember` against **the local replica only** (the function's own doc says so: "`false` can mean 'not replicated here yet', never a durable verdict"). On a removed party, the removal usually has **not** replicated — the cohort cut it off at roughly the moment the removal was written — so the removed party's own view still shows it as a member. A naive re-arm therefore lands in the already-member arm, where today's code:

- calls `burnLeftoverInvite`, which fails (the burn is a strand write and the cohort refuses this machine), logs it, and **clears the staged invitation** for any non-busy failure;
- falls through to `ensureBinding`, where `registerMemberPeer` finds the binding row already present locally and returns without writing (it is insert-if-absent, guarded by a local read);
- latches `done` and stops again.

Net effect of a naive re-arm: the fresh credential is destroyed locally, the loop re-latches, and the only trace is a debug line. That is worse than today, where the invitation at least stays staged. So:

- **Classify burn failures the way consume failures are classified.** `burnInvite` writes only the `Strand.ConsumedInvite` row, under the same `NotExpired` / `NotCancelled` / `NotSealed` / primary-key constraints, so `classifyConsumeFailure` already routes it correctly — reuse it and widen its doc comment to say it serves both writes rather than forking a second classifier. Clear the staged invitation only on success, `dead-invite` or `sealed`; keep it staged on `busy` (today's behaviour) and on `retry` (the new case: a write the cohort refused, or any failure nobody classified).
- **Do not latch `done` while an invitation is still staged.** Today `ensureBinding` finishes the loop as soon as the binding write returns. Make the done condition "binding in place **and** no invitation still staged", so a party whose burn keeps being refused keeps a live loop that can heal later instead of stopping with an unsettled credential in hand.

This contradicts the accepted-tradeoff `NOTE:` currently on `burnLeftoverInvite` ("a burn that failed for a TRANSIENT reason is never retried"). That decision was made when the burn arm could only ever see an invitation staged *before* the first join finished. Re-arming makes it reachable with a freshly issued invitation that the app wants redeemed, which is a material change in the surrounding facts. **Replace that NOTE** with one recording the new rule and why it changed — do not leave the old one standing next to code that contradicts it.

### 3. Report the dead end

Two triggers, one report, fired at most once per re-arm cycle:

- **Confirmed** — a pass finds `isSelfRevoked()` true *and* an invitation staged. The node knows it was removed and is holding a credential it cannot spend. Today this branch stops the loop with a debug line; instead report, and **keep going** (do not stop while an invitation is staged): a manager re-admission lifts the refusal, replication resumes, and the still-running loop then sees the member row, burns the leftover credential and finishes by itself. Keep today's stop for the self-revoked case with **no** invitation staged.
- **Probable** — N consecutive unfinished passes with an invitation staged and nothing settling it. Mirror `IDLE_PASSES_BEFORE_ESCALATION` with an exported `UNFINISHED_PASSES_BEFORE_ESCALATION` (10 is the same order: about five minutes once the ladder reaches the 30 s cap). This is the case that matters most in the field, because it is what a removed party that never learned it was removed actually hits. The message must name both possible causes — this party may have been removed and the remaining members are refusing its machines, or the invitation's row has not replicated here yet — and the remedy: a remaining manager admits this party's key directly with `addMemberByManager`.

Surfaces, both of them:

- One `console.warn`, in the style of the two the reconciler already emits.
- A new `CadreNodeEvents` entry so an app can react rather than scrape logs. Wire it exactly as `onSelfRevoked` → `strand:revoked` is wired today: a `StrandMembershipReconcilerDeps` callback → a `StartStrandConfig` callback on `StrandInstanceManager` → `CadreNode.emit`. Suggested name `strand:rejoin-blocked` with `{ strandId: string }`; document it in `types.ts` beside `strand:revoked`, including that it is a *suspicion* on the probable trigger, not a verdict.

### Wiring

`CadreNode.adoptFormationMembershipInvite` stages the invitation (`pendingMembershipInvites.set`) and is the only place that does. Follow that set with a notification through the manager — a new `StrandInstanceManager` method alongside `refreshRevocationEnforcement`, forwarding to `this.membershipReconcilers.get(strandId)?.rearm()` and logging when no reconciler is armed. A first join has no reconciler yet (the strand is added after `formStrand`), so the notification is a no-op there and bring-up arms a loop that finds the invitation normally.

Delete the two stale `NOTE:` blocks that describe the bug as unfixed once it is fixed: `strand-membership-reconciler.ts` (the self-revoked branch in `doPass`) and `cadre-node.ts` (inside `adoptFormationMembershipInvite`). Both name this ticket by slug.

## What this does not change

Only one machine of a removed party holds the staged invitation (the one that ran `formStrand`; the cache is in-memory and per-node). It does not need to be pushed to the party's other machines: once that machine seats the party's `Strand.Member` row, every sibling machine's leftover `MemberPeer` row stops being an orphan and the remaining members stop refusing it. The party heals as a unit.

The admission posture is unchanged. The loop could already redeem a staged invitation after a quiesce/resume (a resume rebuilds the reconciler and the staged invitation survives in `CadreNode`'s map); this makes the same path reachable without the resume. Nothing new is admitted — the strand write gate still decides, and a restart still forgets the staged invitation entirely.

## Tests

- **The reproduction, at the lowest layer that shows it** — `packages/cadre-core/test/strand-membership-reconciler.spec.ts`, which already drives a real closed strand DB on a local transactor. A loop that has latched `done`, then a fresh invitation staged and the loop re-armed: the invitation is redeemed and the member row is seated again. Today this asserts nothing happens.
- **The stale-member-row arm** (change 2): a re-armed loop whose local replica still shows the party as a member and whose burn is refused keeps the invitation staged and does not latch `done`. `failNextWriteBatch` in that spec is the existing way to refuse one write batch.
- **The confirmed report** (change 3): self-revoked with an invitation staged reports once, fires the callback, and does not stop.
- **Not worth a test**: the `CadreNode` → manager → reconciler notification path is wiring, and `strand-instance-manager-membership.spec.ts` already covers arming/lifecycle with mocks.
- **Rewrite integration test 2** rather than deleting it — its own comments ask for this. Its subject becomes "a fresh formation after removal is attempted and reported, and still needs a manager to complete". What it should assert depends on something only a real run can settle: whether the removed party's replica has converged on its own removal by then. **Run it and write down what actually happened**, then assert that. Either path ends in the same place — the manager admission at the end of the test is still required and still heals everything — so the closing assertions stand; it is the middle section, and the comment block explaining which mechanism is operative, that has to be rewritten to the truth. The long comment at the file head (the "TWO TESTS" section) describes the old behaviour too.

## Validation, and a blocker to check first

`yarn workspace @serfab/cadre-core test` and the one integration scenario; `yarn lint` and the typecheck.

**The DB-backed specs could not be run during this fix pass.** The stale-build guard refuses with:

```
Stale build detected: these tests run real compiled output.
  - @quereus/quereus: dist is stale — src was edited after the last build.
```

`../quereus` is a sibling repository this project may not build or edit (`tickets/rules/sibling-repos.md`), so its source is being worked on elsewhere. Check the guard again before starting; if it still reports stale, the design work below can proceed but the ticket cannot be validated, and that is a blocking condition to record rather than work around. Related background: `fix/debt-tests-only-valid-against-linked-optimystic`.

`tickets/backlog/debt-hoist-strand-read-helpers-integration` also lists the same integration scenario file among the files it will touch. Different root cause (hoisting duplicated test read helpers), no conflict expected, but land order matters if both move at once.

## Documentation

`docs/strands.md`, under "What removal still does not do", currently says the redemption "is not refused, not retried and not reported, it is simply never attempted" and calls that a bug due to be fixed. Rewrite that bullet to the post-fix reality: the attempt now happens and the failure is reported to the app, and re-admission still has to be authored by a remaining manager because the strand write is refused. The neighbouring "It does not cancel an unspent invitation" bullet leans on the same claim ("the first of them is a bug due to be fixed") and needs the same correction — with the point sharpened, since once the loop genuinely attempts redemption the network refusal is the only barrier left, which makes cancelling invitations at removal time worth more than it was.

## TODO

- [ ] Check the stale-build guard; if `../quereus` is still stale, record the blocker in the handoff rather than building the sibling.
- [ ] Split the reconciler's terminal stops into re-armable (done, self-revoked) and permanent (sealed, undecodable key, public `stop()`), and add `rearm()`.
- [ ] Reuse `classifyConsumeFailure` for burn failures; keep the invitation staged on `busy` and `retry`, clear it on success, `dead-invite` and `sealed`.
- [ ] Make the `done` latch require that no invitation is still staged.
- [ ] Replace the accepted-tradeoff `NOTE:` on `burnLeftoverInvite` with one recording the new rule and why the old decision no longer holds.
- [ ] Report the dead end: the confirmed trigger (self-revoked + staged invitation, which no longer stops the loop) and the probable one (`UNFINISHED_PASSES_BEFORE_ESCALATION`), each once per re-arm cycle, via one `console.warn` and one new event.
- [ ] Add the `strand:rejoin-blocked` event: reconciler dep → `StrandInstanceManager` config → `CadreNode.emit`, documented in `types.ts` beside `strand:revoked`.
- [ ] Notify the manager from `CadreNode.adoptFormationMembershipInvite` after staging, via a new `StrandInstanceManager` method.
- [ ] Delete the two `NOTE:` blocks that describe this bug as unfixed (`strand-membership-reconciler.ts` `doPass`, `cadre-node.ts` `adoptFormationMembershipInvite`).
- [ ] Unit specs: the re-armed redemption, the stale-member-row arm, the confirmed report.
- [ ] Rewrite integration test 2 and the file-head comment to the behaviour a real run shows.
- [ ] Update both affected bullets in `docs/strands.md`.
