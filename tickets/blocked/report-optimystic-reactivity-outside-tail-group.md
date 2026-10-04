description: A short draft note for the Optimystic maintainers: the plugin README still says change notifications work only when every machine is in every storage group, but a real-network test shows a machine outside the group is notified too, so the sentence looks out of date. Posting it is a maintainer's call.
files: packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts, docs/strands.md (#what-a-watcher-sees), ../optimystic/packages/quereus-plugin-optimystic/README.md (§Network change notification, "Today, every machine in every cohort")
----
# Human action: tell Optimystic the plugin README's "every machine in every cohort" caveat looks stale

**Blocked on:** a maintainer posting this to Optimystic (optimystic-tend); the README lives in `../optimystic`, which this repo does not edit.

## Context for the maintainer

The plugin README (§Network change notification) says a notification verifies only when "every machine is in every cohort: `clusterSize` and `cohortTopic.wantK` equal to the number of machines". Optimystic has since rooted each collection's notification tree at the storage group of its log tail block (its `docs/reactivity.md` §Origination point; Optimystic ticket `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`, complete). `strand-reactivity-scenario` tested the case the caveat rules out, on Optimystic 1.10.0: three machines with `clusterSize` 2 and the default `wantK` 16, so neither number equals the machine count.

In every run where all three machines registered, the machine outside the tail block's storage group received the notification and its `Database.watch` fired. In the scenario's final form that was 7 of 7 runs, two rounds each, within about 50 ms of the committing machine's insert returning (52 ms before to 53 ms after). Earlier variants of the scenario agree in every run where all machines registered. The machine outside the group was identified per round from the delivered notification's tail (`servingCohortAt(reactivityRootCoord(tail))`), and "notified" means its node's `reactivitySubscribers.deliver` was called for the collection and a wake followed.

The separate defect found in the same runs (machines that register in a burst lock later ones out) is `report-optimystic-reactivity-registration-burst-on-a-small-strand`; post both together if convenient.

## Draft

> **quereus-plugin README: "every machine in every cohort" looks out of date**
>
> §Network change notification says a notification verifies only when `clusterSize` and `cohortTopic.wantK` equal the number of machines. Since notifications are rooted at the tail block's storage group, that no longer seems to hold. On 1.10.0, with 3 machines, `clusterSize` 2 and the default `wantK` 16, the machine outside the tail's storage group was pushed every time all machines had registered: 7 of 7 runs, two commits each, within ~50 ms of the commit returning. The README sentence (and the `clusterSize`/`wantK` advice that follows it) could be replaced by the real precondition, a registration at the tail's root, plus the burst limit we reported separately.
>
> Scenario: `packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in gotchoices/sereus.
