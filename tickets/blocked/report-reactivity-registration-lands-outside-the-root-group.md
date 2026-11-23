description: A machine that asks to be notified about a table's changes in the first second of a strand's life is recorded by the wrong machine, so for about a minute and a half nobody tells it when the table changes. Filed in Optimystic 2026-11-22 as `fix/reactivity-registration-held-outside-the-tail-root-group` (optimystic `32c2b236`); this ticket waits for that fix to ship, then re-measures the scenario.
architecture: docs/strands/app-schema.md#what-a-watcher-sees
files:
  - packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts (where it was measured)
  - tickets/.logs/reactivity-push-probe.run1.log, .run2.log, .run3.log (the instrumented evidence)
  - tickets/.logs/optimystic-1-29-0.reactivity-2.log (the failing run, uninstrumented)
  - ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (`servingCohortAt`, `assembleServingCohort`)
  - ../optimystic/packages/db-p2p/src/cohort-topic/host.ts (`prepareRootPlacedCoord`, `dispatchRegister`, `rootGroupMembersFor`)
  - ../optimystic/packages/db-p2p/src/cohort-topic/topic-router.ts (`dialRootGroup`)
  - ../optimystic/packages/db-core/src/cohort-topic/registration/renewal.ts (the 3-strike failover)
  - ../optimystic/packages/db-p2p/src/reactivity/collection-watch.ts (the watch service that registers and renews)
difficulty: easy
----

> **Filed 2026-11-22** as Optimystic `tickets/fix/reactivity-registration-held-outside-the-tail-root-group.md` (`32c2b236`), at the maintainer's request. When an Optimystic release carries the fix: adopt it, run the scenario 12 times isolated, and close this ticket if none fails; until then the scenario's push assertion can fail about 1 run in 6, as `tickets/.pre-existing-known.md` records.

# Human action: report to Optimystic that a change subscription can be recorded by a machine that is not responsible for the table

> **Read the 2026-11-21 addendum at the end of this ticket before the sections below.** They explain the mis-registration by machines that have not finished classifying each other; a later measurement contradicts that explanation for the window in question. The defect itself — a registration recorded where no announcer can see it, for about 90 s — is unchanged and still worth reporting.

## Why this is a human's call, not an agent's

The defect and its fix are entirely inside Optimystic. `tickets/rules/sibling-repos.md` forbids agents here from editing, building or filing in `../optimystic`, so somebody has to carry this report to that project's board. Everything needed to write it is below, including the measurements. Nothing in Sereus has to change for the report to be filed; the Sereus-side consequences are handled separately by `strand-reactivity-scenario-waits-for-a-settled-cohort-view`.

## In plain terms

When a machine wants to be told about changes to a table, it registers itself with the small group of machines that store that table's newest data. Which machines those are is worked out from each machine's own picture of the network, and in the first second after a strand comes up that picture is still filling in: a machine that has not yet been classified as a storage machine is left out, and another takes its place. A registration made in that moment is therefore handed to the wrong machine. Nothing ever re-checks it. The machines that really are responsible never learn that anybody wanted to be told, so when the table changes they tell nobody — and the would-be listener finds out only from its own 30-second poll. It stays that way for about 90 seconds, until the registration's keep-alive gives up and starts over.

## What we measured

`packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts`, three machines, strand replication breadth 2 (so exactly one machine is outside the storage group of the table's log tail), Optimystic 1.29.0 at `e81f33e3`, Quereus 5.6.1, 2026-11-21. The scenario was run with a temporary probe that printed, at six points, each machine's registration handle for `default/app/Data`, the registration records each machine's cohort engine held at the tail's root coordinate, and each machine's own `keyNetwork.servingCohortAt` of that coordinate. The probe was removed afterwards; its output is in the logs named above.

The mis-registration happened in **3 of 3** instrumented runs. In every one of them, the machines that registered in the first second named a root group that disagreed with the settled one:

| Run | settled root group (all three machines agree) | registered in the first second | the group that machine's registration named | where its record landed |
| --- | --- | --- | --- | --- |
| 1 | p[2] + p[1] | p[1] | p[0] + p[1] | p[0] only — outside the settled group |
| 2 | p[2] + p[1] | p[1] | p[0] + p[1] | p[0] only — outside the settled group |
| 3 | p[1] + p[2] | p[1], p[2] | p[1] + p[0] | p[1] — inside the settled group, so the pushes worked |

In every run the machine that registered on a later renewal tick (27–30 s after the first commit) named the settled group correctly and was pushed normally. So the mis-registration is a property of *when* a registration is made, not of which machine makes it.

Three further details from the probe, the same in every run:

- **All three machines already agreed on the settled group 0.7–1.0 s after the bad registration.** The disagreement window is roughly the first second after the strand's first commit, which is also exactly when a table watched from launch first has a committed tail to register against.
- **The misplaced record's keep-alive never reached it.** Its `lastPing` stayed equal to its `attachedAt` for 74 s. The participant pings the primary the wrong member list assigned, which holds no record, so every ping is a strike.
- **The correction is the 3-strike failover, about 90 s later** (`MAX_PING_FAILURES` × `ttl/3`, Core TTL 90 s). In run 3 the re-attach landed on a member that did hold the record (`privileged-renew kind=reattach … answer=ok` in the debug log) and re-stamped its primary; in runs 1 and 2 the record had already been TTL-evicted and the participant re-walked and registered correctly. Until then `reactivityWatch.isAttached` reports the watch as registered while no machine in the settled root group holds its record.

The user-visible failure is the scenario's push assertion, which trips exactly when one of the first-second registrants is the machine outside the settled root group. That is what `tickets/.logs/optimystic-1-29-0.reactivity-2.log` shows on 2026-11-20: settled group p[2]+p[0], p[1] registered at 0 ms, and p[1] received no notification at all in rounds 1 and 3 — it woke at 19.2 s and 8.9 s, from its own tail read. Two of four runs failed that day; four runs on 2026-11-21 passed, because in each of those the first-second registrant happened to be inside the settled group.

## The mechanism, in Optimystic's own terms

1. `Libp2pKeyPeerNetwork.servingCohortAt(coord)` (`packages/db-p2p/src/libp2p-key-network.ts`) assembles the cohort live and deliberately does not cache it. Step 4 of its rule keeps only band members whose membership verdict is `serves`, and a serving self absent from the band is appended. A peer whose verdict has not been read yet is therefore left out and self (or a nearer already-classified peer) takes the slot. During the seconds after a strand's nodes connect, this answer is correct but time-varying.
2. The cohort-topic host binds exactly that call as its root group (`rootGroup: { membersAt: rootGroupAt }` in `libp2p-node-base.ts`), so a reactivity topic's root group is read through it on both sides of a register.
3. The registering node's walk reaches the root through `FretTopicRouter.dialRootGroup`, which dials the members *its own* read names, self first when self is among them. The admitting member checks it is in the group through `prepareRootPlacedCoord`, reading its own `snapshots.ensure(coord)` — and during the window its own read agrees, so the `RootPlacementRefusedError("not-member")` guard does not fire. The reply carries the admitting member's member list, which the participant adopts as `cohortMembers`.
4. The record is then held only where that wrong view put it, and the slot assigner stamps its `primary` over the wrong member list. Pushes read `host.registry.findByCoord(reactivityRootCoord(rootTail))` on the announcing member and fan out to the records *it* holds, so a record held outside the settled group is invisible to every announcer.
5. Nothing re-validates a live registration's member list against a later read. `RootGroupSnapshots` has a 5 s max age and `snapshots.drop(coord)` exists, but a holder that stops being a group member keeps the record, and the participant keeps a handle whose `cohortMembers` is wrong indefinitely. Only the renewal's 3-strike failover and re-walk repair it.

## Proposed change (the recommended default)

**Have the participant re-validate its registration's cohort view, and re-register when it has moved.** The watch service already runs a tick at the renewal cadence (`ReactivityCollectionWatch.tick`, 30 s on Core) and already holds the tail; comparing the handle's `cohortMembers` (or `cohortEpoch`) with a fresh `rootGroupMembers(rootKey)` read, and calling `register` again when they differ, cuts the deafness from ~90 s to at most one tick and costs one local read per tick. A cheaper variant of the same idea closes the common case at registration time: the participant compares the register reply's `cohortMembers` with its own read taken after the walk returns, and retries at once when they disagree.

Alternatives considered, and why they are second choices:

- **Act on the first `unknown_registration` instead of the third.** Smaller, but it only shortens the window (to ~30 s) and it weakens the deliberate tolerance for replication lag the 3-strike rule exists for.
- **Have a holder that is no longer a group member hand the record over or drop it.** More correct in principle — it also repairs the case where the participant is offline — but it needs a handoff path between a non-member and the group, and the member that must act is the one whose view was wrong.
- **Delay a first registration until the membership view has settled.** There is no signal for "settled"; `servingCohortAt` is correct at every instant and only its inputs are still arriving. This would be a guess dressed as a precondition.
- **Refuse to admit a registration whose participant-side and member-side member lists differ.** Both sides were wrong together in all three runs, so this catches nothing here.

**What happens if nothing is done.** No data is lost and no commit is missed: the watch service's 30 s tail read still bounds how stale a watcher's view can be, which is what the Sereus scenario observes as a late wake. The cost is that for ~90 s after a machine's first registration, change notifications can reach nobody, so an app watching a table right after a machine joins sees 30 s latency rather than tens of milliseconds. Sereus's scenario assertion stays a coin flip until its own ticket makes the measurement deterministic.

**Reversibility.** High. The recommended change is a comparison and a re-register on a path that already retries; it adds no wire field and no state. If it proves noisy (a re-register per tick on a genuinely churning ring) it can be gated on a changed `cohortEpoch` or dropped.

## Added 2026-11-21 by `strand-reactivity-scenario-waits-for-a-settled-cohort-view`: the machines agree about who serves, and the mis-registration still happens

The Sereus-side ticket added a wait that holds the seed commit until every machine answers the same serving cohort for eight fixed ring coordinates, on two consecutive polls (`waitForCohortAgreement` in `packages/integration-tests/src/harness/control-cohort.ts`). Three things came out of running it, and they narrow this report:

- **There is no pre-commit disagreement to wait for.** The wait resolves about 260 ms after the schema-tag watches open, in every run measured. The machines have classified each other by then.
- **Their answers do not move across the seed commit.** Sampled every 300 ms from before the commit to 1.2 s after it, in two instrumented runs, all three machines answered identically for six coordinates and the answers never changed.
- **The failure survives anyway.** With the wait in place the scenario's push assertion failed 2 of 12 isolated runs (it failed 2 of 4 on 2026-11-20 and 0 of 4 on 2026-11-21 without it). Both failing runs' registration pattern is this report's: one machine registered 0 ms after the seed commit, it was the machine outside the tail group, and it received no notification in the rounds where it was a watcher.

So the window is not one in which the machines disagree about **who serves the network** — measured, they agree before the commit and keep agreeing through it. Whatever differs is specific to the **tail's own root coordinate**: either `servingCohortAt` answers differently at a coordinate derived from a tail that has just been written than the stable coordinates do, or the registration is made against a tail the commit then rotates and its root coordinate moves with it. This report's mechanism section attributes the mis-registration to a `servingCohortAt` whose inputs are still arriving; that attribution should be re-checked against these two candidates before the proposed change is designed, because the recommended fix (re-validate the handle's `cohortMembers` against a fresh read) repairs a moved view but not a registration placed at the wrong coordinate.

This also retires one of the rejected alternatives above: "delay a first registration until the membership view has settled" is not merely a guess — on this topology the membership view is already settled when the bad registration is made.

The probe that produced the per-coordinate samples was temporary and has been removed from the scenario. The run logs it and the counts above came from were written under `tickets/.logs/`, which is pruned on an age and a run-count rule, so the numbers stated in this ticket are the record — do not expect the logs to still be there.

## Added 2026-11-21 by the review of that ticket: which registration goes wrong, narrowed to one configuration

A twelfth isolated run reproduced the failure, making it 2 of 12. Reading the `[reactivity] registered, from the seed commit:` line of all twelve runs together narrows the suspect registration, and rules out the simplest reading of it:

- **Registering at the instant of the seed commit is not by itself enough to break a registration.** In ten of the twelve runs the machine outside the tail group had registered 0–1 ms after the seed commit, and in eight of those ten it was pushed normally. So a registration made in the same instant as the commit that creates the tail usually lands correctly.
- **The two failures share one configuration, and it occurred three times.** In both, exactly ONE machine registered at the seed commit and the other two registered at separate later renewal ticks, about 27 s and about 29 s after it — rather than the usual two-at-the-commit, one-at-27 s split. That three-way-staggered pattern appeared in three of the twelve runs; the two where the lone seed-commit registrant was also the machine outside the tail group failed, and the one where it was inside the group passed.
- **What that is worth, and what it is not.** Three occurrences is suggestive, not established, and the configuration is not something this repo can force. Its value is as a filter: the registration line is printed before any assertion runs, so a reproduction attempt can discard the runs that cannot fail instead of repeating blind ones, and an upstream investigation has a named state to reproduce — one machine's registration made against a tail the commit is still rotating, while its two peers have not registered at all yet.

This does not change the defect or the recommended fix above, and it does not settle which of the two candidates named in the previous addendum is the cause. It does say the cause is sensitive to what the OTHER machines have done by the time a registration is made, which neither candidate accounts for on its own.
