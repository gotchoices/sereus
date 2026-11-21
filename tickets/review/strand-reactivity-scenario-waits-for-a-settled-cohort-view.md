description: A test that proves machines wake each other when a shared table changes was failing about half the time. It now checks that the machines agree about who stores what before it starts measuring — but measurement showed that was never the problem, so the test still fails occasionally and the real cause stays with the people who own the other project.
architecture: docs/strands/app-schema.md#what-a-watcher-sees
files:
  - packages/integration-tests/src/harness/control-cohort.ts (the new `waitForCohortAgreement`, and the generalized `probeCohort`)
  - packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts (`awaitSettledCohortView`, the call site, the module doc)
  - docs/strands/app-schema.md ("Limits and accepted tradeoffs", one new bullet)
  - tickets/.pre-existing-known.md (this scenario's entry, kept in-flight with the new rate)
  - tickets/blocked/report-reactivity-registration-lands-outside-the-root-group.md (an addendum, and a corrected `description:`)
difficulty: medium
----

# What landed, and the finding that changes what it means

## The headline a reviewer needs first

The ticket's premise does not hold, and the measurements are in the handoff below. The scenario was supposed to be flaky because it began measuring while the machines still disagreed about which of them stores the watched table's log tail; waiting for them to agree was supposed to move the measurement out of that window. There is no such window to move out of: the machines already answer alike about who serves the strand within about 260 ms of their schema-tag watches opening, their answers do not change across the seed commit, and the scenario still failed 1 of 11 isolated runs with the wait in place.

So the wait shipped as a **guard**, not as the fix it was filed as, and the ticket's honesty clause applies: the ledger entry in `tickets/.pre-existing-known.md` stays in-flight on the blocked report, `WAKE_BOUND_MS` was not widened, and no assertion was relaxed. The new measurement is recorded on `blocked/report-reactivity-registration-lands-outside-the-root-group`, which owns the defect, because it contradicts that report's stated mechanism and the human carrying it to Optimystic needs to know before they design the fix.

A reviewer's most valuable judgment here is whether a 260 ms guard that demonstrably does not fix the flake should stay in the scenario at all. The case for keeping it is in `awaitSettledCohortView`'s comment: it converts one class of silent nondeterminism into a named failure. The case for removing it is that a wait which cannot help is how folklore starts. Either call is defensible; the code states which one was made and why.

## What changed

**`packages/integration-tests/src/harness/control-cohort.ts` — `waitForCohortAgreement(viewers, options)`.** Polls every given node's `findCluster` for each of eight fixed ring coordinates and resolves once every node answers the same member set for every coordinate on two consecutive polls. Takes the usual `WaitOptions`; on timeout it throws naming which coordinate the nodes disagreed about and what each of them answered, or — when they agree on an empty cohort — that nobody has classified anybody yet. Refuses fewer than two nodes immediately rather than after a timeout. `probeCohort` now takes an optional key, defaulting to the module's existing `CONTROL_COHORT_PROBE_KEY`, so the one-shot and minimum-size helpers are unchanged. Exported through the harness barrel by the existing `export * from './control-cohort.js'`.

**Several keys, not one, and why that is not the module header's reason.** The header argues one key is representative because below the configured breadth the closest-k set is simply every serving peer. That argument does not hold on three machines at breadth two, where a cohort is a two-member selection — and for an agreement probe the selection is what makes the probe work. A node that has classified only two peers answers that same pair at every coordinate, so at a coordinate whose true nearest two are that pair it agrees with fully-informed nodes and a single-key wait accepts it. Across eight fixed coordinates the fully-informed nodes' selections vary while the under-informed node's cannot. The header now points at this exception so a reader does not apply its bound to the new function.

**`strand-reactivity-wakes-watchers.integration.ts`.** `awaitSettledCohortView` calls the wait after `awaitSchemaTagWatches` and before the seed commit, with its own 20 s budget (`COHORT_AGREEMENT_BUDGET_MS`). `TEST_TIMEOUT_MS` went from 240 s to 270 s, because the old value no longer covered the worst case once the agreement budget was added to the schema-watch, registration, settle and three-round budgets. The module doc's REGISTRATION section and the helper's own comment say what the wait establishes, what it was measured to be worth, and that it should be removed rather than kept if the upstream report closes on a different cause.

**`docs/strands/app-schema.md` → "Limits and accepted tradeoffs".** One bullet: a watcher whose table is first committed to in the seconds after its machine joins can be registered outside the group that announces that table's commits, is then woken only by the 30 s tail read for up to 90 s, and why that happens is not yet settled. "What a watcher sees" was left alone — every bullet there still holds.

## Tests

**No new test.** The change is a wait inside one existing integration scenario plus the harness primitive it calls; the scenario is the test, and it was run eleven times (below). A unit test over `waitForCohortAgreement` would have to mock a key network — a module this repo does not own — to produce the disagreement it waits for, which is the wrong layer. Its two refusal paths (fewer than two nodes; a node with no attached key network) are named throws on arguments, not branching logic worth pinning.

## What was measured, and how to re-measure it

All runs isolated, fresh process each, `yarn vitest run src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in `packages/integration-tests`, 2026-11-21, Optimystic 1.29.0 / Quereus 5.6.1.

**Final code: 10 passed, 1 failed of 11.** The failing run is `tickets/.logs/reactivity-settled.timing.log`: `round 1 (p[0] commits), watcher p[1] outside the tail group: a notification reached its subscribers and woke the watch: expected undefined to be defined` — the same assertion and the same shape as the baseline failures (p[1] registered 0 ms after the seed commit, was the machine outside the tail group, and received no notification in round 1). The others are `reactivity-settled.run1.log` … `run9.log`. Baseline for comparison: 2 failed of 4 on 2026-11-20 and 0 of 4 on 2026-11-21, so 1 of 11 against 2 of 8 — not an established improvement at these numbers.

**The wait resolves in 258–268 ms** in every run where it was timed (`DEBUG=sereus:integration:cohort`, which prints `cohort agreement across 8 probe keys after Nms`). That is its first two polls at the 250 ms default interval, so it waits for nothing.

**The views do not move across the seed commit.** Two instrumented runs (`tickets/.logs/reactivity-probe.diag1.log`, `.diag3.log`) sampled every machine's cohort for six coordinates every 300 ms from before the commit to 1.2 s after it. All three machines answered identically at every sample and no answer changed. The probe that produced this was temporary and is out of the scenario; nothing in the committed code prints it.

**One design decision came from a failed run worth knowing about.** An earlier version of the wait also required that the agreed selections, taken together, name every machine — on the reasoning that a machine nobody has classified can appear in no selection. That timed out at 20 s on a healthy network (`tickets/.logs/reactivity-probe.diag2.log`): all three machines agreed on the same pair at all eight coordinates with the third machine in nobody's cohort, which is a *consistent* network — every machine places a block in the same place — and the scenario passes in it (`reactivity-probe.diag3.log` is such a run, green). That requirement was dropped; the wait now holds only to agreement, with an empty cohort excluded as vacuous. The function's doc says so under "AGREEMENT, NOT SIZE".

**`yarn lint`** (including `check:docs`) passes, and `yarn workspace @serfab/integration-tests typecheck` is clean.

## Use cases and what to exercise

- **The wait in its intended use.** Run the scenario. With `DEBUG=sereus:integration:cohort` the resolve time prints; it should be a few hundred ms. A multi-second resolve is itself news and belongs in the ledger.
- **Its failure message.** The timeout path is what the wait is for, and it is the part no run exercised: all eleven runs resolved it. A reviewer who wants to see the message can shorten `COHORT_AGREEMENT_BUDGET_MS` to something under 250 ms locally, or call the wait on nodes from two different networks, and check that it names a coordinate and each node's answer rather than a generic timeout.
- **Another scenario that measures placement.** The helper takes bare `Libp2p` nodes and a label each, so a control-network scenario can use it the same way; `waitForControlCohort` remains the right tool for "the cohort is big enough", and the two should not be confused.

## Known gaps, stated plainly

- **The scenario is still flaky, by design of this handoff rather than by oversight.** 1 of 11. The remaining cause is upstream and parked in `blocked/`.
- **The guard's value is unproven.** It has never fired. It is justified by reasoning, not by a run.
- **Eight coordinates is a judgment, not a measurement.** It is enough to make a three-machine-at-breadth-two topology's selections vary (observed: all three possible pairs appear across six coordinates in `reactivity-probe.diag1.log`). On a network much wider than its cluster size the wait's premise weakens; the function's doc says so, and nothing enforces it at runtime.
- **The alternative candidates for the real cause are untested here.** The addendum on the blocked report names two — `servingCohortAt` answering differently at a coordinate derived from a freshly written tail, or the registration being placed against a tail the commit then rotates — and labels them as candidates. Neither was instrumented, and neither can be fixed in this repo.
