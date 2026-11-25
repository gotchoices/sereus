description: A test that proves machines wake each other when a shared table changes was failing about half the time. A check was added that the machines agree about who stores what before measuring starts — but measurement showed that was never the cause, so the check stayed as a guard, the test is still occasionally flaky, and the real cause stays with the people who own the other project.
architecture: docs/strands/app-schema.md#what-a-watcher-sees
files:
  - packages/integration-tests/src/harness/control-cohort.ts (`waitForCohortAgreement`, the generalized `probeCohort`)
  - packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts (`awaitSettledCohortView`, the call site, the module doc, `TEST_TIMEOUT_MS`)
  - docs/strands/app-schema.md ("What a watcher sees" — a corrected bullet; "Limits and accepted tradeoffs" — one new bullet)
  - tickets/.pre-existing-known.md (this scenario's entry, in-flight on the blocked report)
  - tickets/blocked/report-reactivity-registration-lands-outside-the-root-group.md (two addenda)
----

# What landed

A guard, not the fix the ticket was filed as. `waitForCohortAgreement` in the integration harness polls every given node's `findCluster` for eight fixed ring coordinates and resolves once all of them answer the same member set for every coordinate on two consecutive polls; `probeCohort` was generalized to take a key. The reactivity scenario calls it between the schema-tag watch wait and the seed commit, with a 20 s budget, and `TEST_TIMEOUT_MS` rose from 240 s to 270 s. `docs/strands/app-schema.md` gained a "Limits and accepted tradeoffs" bullet for the underlying defect.

The implement stage's own measurements disproved the ticket's premise, and it said so rather than claiming a fix: the machines already answer alike within about 260 ms of their watches opening, their answers do not change across the seed commit, and the scenario still failed with the wait in place. Nothing was relaxed to make the scenario green — `WAKE_BOUND_MS` is unchanged, no assertion was loosened, no test was skipped, and the ledger entry stayed in-flight on the upstream report.

# Review findings

## Checked

Read the implement diff (`ticket(implement): strand-reactivity-scenario-waits-for-a-settled-cohort-view`) before the handoff summary. Verified the new primitive against Optimystic's `libp2p-key-network.ts`: `findCluster(key)` and `servingCohortAt(coord)` both reduce to `assembleServingCohortAt`, so the guard does probe the same assembly the scenario's attribution and the upstream defect turn on, and nothing caches the cohort between polls — the probe stays live, as the module header claims. Confirmed the temporary diagnostic probe was removed and the working tree is clean. Ran `yarn lint` (including `check:docs`) and `yarn workspace @serfab/integration-tests typecheck`: both clean, before and after this pass. Ran the scenario once.

## Found and fixed in this pass

**The documented registration behaviour was wrong, in the section this ticket names as its anchor.** `docs/strands/app-schema.md` → "What a watcher sees" claimed "On a new strand every machine's watch opens at launch, so all of them register on the same renewal tick after the first commit." Every one of the twelve runs now on record disproves it: registrations land at 0 ms, about 27 s and about 29 s from the seed commit. The cause is upstream and verified by reading it — the reactivity watch service's `armTick` starts a machine's renewal timer when that machine's *first* subscription opens and re-arms it after each tick, so the machines' 30 s ticks are independently phased and each registers at its own next tick. The bullet now says that, and keeps the "all admitted" claim with its real reason (a root nobody has registered under holds the first registration that reaches it). The scenario's module doc carried the same error as "waits for every machine to register on its own, at nearly the same moment"; it now states the phasing and the measured spread, and points at the budget that covers it. This was not a consequence of the change under review — it was already wrong — but it is in the anchor section and it is the behaviour both failures turn on, so it is fixed here rather than filed.

**The guard's comment did not state its blind spot.** It probes eight *fixed* ring coordinates, while a notification is rooted at the log tail's own coordinate — which does not exist until the seed commit creates the tail, so no pre-commit wait can ask about it. That matters because the blocked report's remaining candidates are both coordinate-specific: a green guard says the machines agree about the strand in general, never that they agree about the tail. `awaitSettledCohortView`'s `NOTE:` now says so, so a future reader cannot mistake the guard for coverage of the coordinate in question.

**`TEST_TIMEOUT_MS`'s enumeration omitted a budget it has to cover.** It listed bring-up, the cohort-agreement and registration budgets, the settle and three rounds, but not the 10 s schema-tag watch wait. The constant is now stated as the sum it is — 239 s of worst case against a 270 s bound. (The handoff's reason for the bump, that 240 s "no longer covered the worst case", was off: 239 s fits inside 240 s. The bump is still right, because 1 s is not headroom.)

**The blocked report cited logs that get pruned as "the evidence".** `tickets/.logs/` is swept on age and run-count rules, so a long-lived blocked ticket whose evidence is a log path will outlive its own evidence. The report now states that the numbers in the ticket are the record.

**Stale failure rate.** The rate stated in the implement handoff, the ledger entry and the blocked report (1 of 11) is now 2 of 12 in all three places.

## Found, and recorded rather than fixed

**The flake reproduced on the first review run, and both failures share one configuration.** The scenario failed with the same assertion as every prior occurrence — `round 1 (p[0] commits), watcher p[1] outside the tail group: a notification reached its subscribers and woke the watch`. Reading the registration line of all twelve runs together both rules out the obvious reading and narrows the suspect:

- Registering at the instant of the seed commit is *not* by itself enough to break a registration. In ten of twelve runs the machine outside the tail group had registered 0–1 ms after the seed commit, and eight of those ten were pushed normally.
- Both failures instead share a three-way-staggered pattern: exactly one machine registered at the seed commit and the other two registered at separate later ticks (about 27 s and about 29 s), rather than the usual two-at-the-commit, one-at-27 s split. That pattern occurred in three of twelve runs; the two where the lone seed-commit registrant was also the machine outside the tail group failed, and the one where it was inside passed.
- Three occurrences is suggestive, not established, and this repo cannot force the configuration. Its value is as a filter — the registration line prints before any assertion runs, so a reproduction attempt can discard runs that cannot fail — and as a constraint on the upstream diagnosis: the cause is sensitive to what the *other* machines have done by the time a registration is made, which neither of the report's two candidates accounts for on its own.

This is upstream work that agents here may not do, and the defect already has an owner, so it went onto `blocked/report-reactivity-registration-lands-outside-the-root-group` as a second addendum rather than becoming a ticket. The ledger entry carries the new rate and a one-line pointer to it.

**The guard was kept, deliberately.** The ticket invited the judgment, and the case for removing it is real: it has never been observed to wait (260 ms is its own two minimum polls), its premise was disproven by the measurement that shipped with it, it cannot see the coordinate the failure turns on, and it has exactly one caller. Against that, `awaitSettledCohortView` carries a `NOTE:` stating the decision, the measurement behind it, and a revisit condition — remove it if the upstream report closes on a different cause. That report is open, so the condition has not tripped, and a review pass should not overturn a decision already recorded with its reasoning at the site. The new measurement above moves the case further toward removal without closing the report; whoever closes the report should delete the guard and `waitForCohortAgreement` with it, as that `NOTE:` instructs.

## Found, considered, and left alone

**`waitForCohortAgreement` duplicates `waitForCohortOn`'s scaffolding** — roughly twenty-five lines of the same shape: validate, resolve the key network up front, destructure the wait options, carry a `lastError` out of a condition that `waitUntil` would otherwise swallow, rewrap the timeout in a message that names what was actually seen. Factoring it would mean changing a shared harness utility with callers across the scenario suite, for an idiom with two instances, the newer of which is itself slated for deletion. Not worth the churn now; if a third caller wants the idiom, the shared poller belongs in `wait-utils.ts` rather than copied a third time.

## No new or cut tests, with reason

The implement stage added none and that was right: the change is a wait inside one existing integration scenario, and the scenario is the test. Review added none either. The guard's two refusal paths are argument validation, not branching logic. Its agreement/vacuity/twice-in-a-row decision tree *is* real branching logic that nothing else enforces, which would normally argue for a unit test — but it is logic inside a guard whose own `NOTE:` schedules its removal, so pinning it would be building on something marked for deletion. Nothing was cut, because nothing was added.

## Test run

`yarn vitest run src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in `packages/integration-tests`, isolated, with `DEBUG=sereus:integration:cohort`: **failed**, on the known in-flight assertion above. It is the pre-existing failure already recorded in `tickets/.pre-existing-known.md` as `in-flight` against `blocked/report-reactivity-registration-lands-outside-the-root-group`, so no `.pre-existing-error.md` was written — the entry says not to re-report it. The guard resolved in 260 ms, matching every prior run. `yarn lint` and the integration-tests typecheck pass.

The twelve-run count takes the implement stage's eleven at face value; the logs under `tickets/.logs/` account for ten of them (nine passes and one failure), plus this review's failure.
