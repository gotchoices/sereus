description: The test that proves a strand wakes watchers on its other machines fails about half the time, because it starts measuring while the machines still disagree about which of them is responsible for the watched table. Make it wait until they agree, and write down the real limit it keeps tripping over.
architecture: docs/strands/app-schema.md#what-a-watcher-sees
files:
  - packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts (REGISTRATION note, `seedThenAwaitRegistrations`)
  - packages/integration-tests/src/harness/control-cohort.ts (`readCohort`, `waitForCohortOn` — where the new wait belongs)
  - docs/strands/app-schema.md ("What a watcher sees", "Limits and accepted tradeoffs")
  - tickets/.pre-existing-known.md (the in-flight entry for this scenario)
difficulty: medium
----

# The reactivity scenario measures a strand whose machines have not finished agreeing

## What is wrong

`strand-reactivity-wakes-watchers.integration.ts` commits its seed row as soon as every machine's network watch is open — about a second after the strand comes up. A table watched from launch has no committed tail until that seed, so the first machine whose tail read straddles the commit registers for change notifications in that same second. That is the one moment when the machines have not finished classifying each other, so the root group each of them computes for the table's log tail is still moving. A registration made then is recorded by whichever machine the unsettled view named, which may be a machine outside the settled root group; no announcer can see it there, and nothing re-checks it for about 90 seconds.

The scenario's push assertion therefore fails exactly when the first-second registrant happens to be the machine outside the settled root group — two of four runs on 2026-11-20, and none of four on 2026-11-21. The mis-registration itself happened in three of three instrumented runs; only its victim varies. The full measurement, the mechanism and the upstream fix are on `report-reactivity-registration-lands-outside-the-root-group` (`tickets/blocked/`), which owns the defect: it is inside Optimystic and cannot be fixed here.

This ticket does the part that belongs here: measure the promise the scenario exists to measure — that a commit is pushed to the machine outside the tail's storage group — on a strand whose machines have finished agreeing, and record the convergence limit so the next reader does not rediscover it.

## What the wait is

A machine's view of who serves a ring coordinate is assembled live from the membership verdict it holds for each peer (`servingCohortAt` in Optimystic's `libp2p-key-network.ts`, step 4 of its rule: only peers verdicted `serves` are kept). The condition the scenario needs is "every machine has classified every other machine as serving", and the observable proxy for it is that every machine answers the same member set for one fixed probe key. `packages/integration-tests/src/harness/control-cohort.ts` already owns that probe key and the one-shot read (`readCohort`), so the wait belongs beside them and is reusable by any scenario that measures placement rather than reachability.

Two things to get right in the helper:

- **Agreement, not size.** On a strand of three machines at breadth two the cohort for the probe key is a *selection* — a specific pair, not every serving peer — so the module header's "in a party smaller than k, closest-k is every peer" argument does not apply here. Do not restate it at the new call site. What makes the probe valid for this purpose is the opposite: because it is a selection, it changes as soon as a verdict changes.
- **Hold it for two consecutive polls** before resolving, so a view that is still moving is not caught mid-flight at a moment two machines coincide.

A failure must print each machine's view, so a timeout reads as "these two machines disagree" and not as a generic convergence timeout — `waitForCohortOn` already sets that pattern.

## Honesty about what this does and does not prove

The wait narrows the window the upstream defect needs; it does not close it. A membership verdict can in principle move again after the wait resolves, and the registration still happens on whatever view holds at the first tail read. So this is a reduction in flakiness to be *measured*, not asserted. If the scenario is still not reliably green, the right outcome is to say so, leave the ledger entry in `tickets/.pre-existing-known.md` in place pointing at the blocked report, and stop — not to widen `WAKE_BOUND_MS` or relax the push assertion, either of which would hide the broken promise this scenario exists to hold.

## TODO

- Add a cross-machine agreement wait to `packages/integration-tests/src/harness/control-cohort.ts` — poll `readCohort` on every given node until all of them answer the same member set twice in a row; take the usual `WaitOptions`; on timeout throw naming each node's last view. Export it through the harness index like its neighbours.
- Call it in `strand-reactivity-wakes-watchers.integration.ts` after `awaitSchemaTagWatches` and before the seed commit, with a budget of its own (the ring reaches every member within a few seconds; see the `control-cohort.ts` header).
- Extend the scenario's REGISTRATION note with why the seed waits for agreement: a registration made before the machines agree on the tail's root group is recorded outside that group, and the watcher is then push-deaf for about 90 s. Add a `NOTE:` at the wait naming `report-reactivity-registration-lands-outside-the-root-group`, so the wait is removed when upstream closes it rather than being inherited as folklore.
- Add one bullet to `docs/strands/app-schema.md` → "Limits and accepted tradeoffs": a watcher whose table is first committed to in the seconds after its machine joins can be registered outside the group that announces the table's commits, and is then woken only by the 30 s tail read for up to 90 s, until its registration's keep-alive gives up and registers again. Cite the blocked ticket slug. Leave "What a watcher sees" alone — every bullet there still holds; this is the limit beside them, not a correction to them.
- Run `yarn vitest run src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in `packages/integration-tests` six times, isolated, fresh process each; record the pass count and the per-round lines in the handoff. Compare against the baseline of 2 failures in 4 runs (2026-11-20) and 0 in 4 (2026-11-21).
- Update the scenario's entry in `tickets/.pre-existing-known.md`: if the runs are green, close it with the measured pass rate and the note that a recurrence means the registration landed outside the settled group again (the fingerprint is the same assertion); if they are not, keep it in-flight on the blocked report and record the new rate.
- `yarn lint` (the doc check runs inside it) before handing off.
