description: When a user removes a dead machine from their cadre, a phone's offline queue now stops waiting for it and sends its saved changes, including when the phone had already met that machine or was started knowing about it.
architecture: docs/strands.md#offline-mode
prereq: offline-queue-waits-for-party-machines-that-hold-the-strand
files: packages/cadre-core/src/strand-party-machines.ts (`removed()`, `watchRemovedMachinesInSeed`), packages/cadre-core/src/strand-instance-manager.ts (`isNetworkMember` option, `watchSeedForRemovedMachines`, `StartStrandConfig.onRemovedMachineInSeed`), packages/cadre-core/src/cadre-node.ts (`queueSeedRemovalRebuild`, `rebuildWithoutRemovedMachine`, NOTE on `rotateAfterRemoval`), packages/cadre-core/test/strand-party-machines.spec.ts, packages/integration-tests/src/scenarios/strand-offline-waits-for-party-machine.integration.ts, docs/strands.md, docs/testing.md
----
# Removing a machine releases the offline queue waiting for it

## Validation still owed: run this first

`machine-removal*` and `strand-offline-queue-survives-restart` have **not run** against this change, and the target scenario could not be repeated. Both TODO items are open for that reason alone.

From partway through the validation, the stale-build guard refused every integration run with `@optimystic/quereus-plugin-optimystic: dist is stale`. Another agent is editing that sibling right now (`src/schema/index-walk.ts`, `index-manager.ts`, `optimystic-module.ts`, uncommitted). `tickets/rules/sibling-repos.md` says not to build it or work around the guard, so this is blocked on the sibling's build. I retried for about 5 minutes and it did not clear.

Once the guard is clear:

```
yarn workspace @serfab/integration-tests exec vitest run machine-removal strand-offline-queue-survives-restart
yarn workspace @serfab/integration-tests exec vitest run strand-offline-waits-for-party-machine
```

Run the second one a few times. It has passed twice in full, once on the final logic; the second pass came before the fix for a removal found during a build, described under "How it works".

What did run on the final code: `yarn typecheck` and `yarn lint` are clean. `strand-party-machines.spec.ts` passes 9 of 9. The `@serfab/cadre-core` suite passed (2608 passed, 1 skipped) before the last two edits, which only reworded comments.

## What changed

Optimystic's own gate runs ahead of the party-machine gate and could stay closed after a removal for two reasons. Each now has its own mechanism.

- **The strand node remembers the machine (`absent-members`).** On a strand node that tracks the party's machines, `isNetworkMember` now refuses a removed machine's strand peer id. It is read live from the tracker's last good read (`StrandPartyMachines.removed()`). Optimystic then answers `foreign` ahead of its remembered verdict, so cohorts and the absent-member list drop the machine.
- **The machine is in the running node's launch seed (`awaiting-bootstrap`).** A seed peer that is refused but serves the network counts as unheard for the node's whole life, and the seed is frozen. So when a read finds a removed machine among the peers of `config.bootstrapNodes`, the manager calls `StartStrandConfig.onRemovedMachineInSeed(strandId)`, and `CadreNode` rebuilds the runtime from a fresh seed.

The tracker's `onChange` now also fires when only the removed ids change, so the queue wakes at once rather than on its next re-check.

## How it works, where it differs from the plan

- **The rebuild calls `handleStrandHibernate` then `handleStrandWake`**, not the bare `quiesceStrand` and `resumeStrandRuntime`. That gives the app the `strand:hibernating` and `strand:waking` events, and the wake's existing handling of a failed rebuild.
- **Rebuilds are chained per strand** (`seedRemovalRebuilds`), so two removals give two rebuilds in turn. A strand already `hibernating` or quiescing when its turn comes is left down, since its next wake takes a fresh seed. A strand mid-build is not treated as down, because the quiesce waits for the build. My first version read "no `libp2pNode`" as down, which would have stranded a removal found during a build. Only inspection covers this.
- **I added a loop guard the ticket said was not needed.** The ticket reasons that a fresh seed cannot name a removed machine. I found one path by inspection where it can: a removed machine still configured in `network.relayAddrs` and still answering the strand-addr RPC. Without a guard that is an endless rebuild loop. `watchRemovedMachinesInSeed` keeps a per-strand set of ids a rebuild was asked for (`seedRemovalsAnnounced`), so such an id asks once, then logs on each later change of the machine lists and leaves the queue held. A later build whose seed leaves the id out forgets it, so a machine removed, re-added and removed again still asks. Reject this if you think the path is not real; the set is small to remove.

## Use cases to check

- A phone whose strand met a machine after launch: the machine stops for good, a transaction queues, `removeMachine` commits it. The strand node stays the same object.
- A phone that hibernated and woke while the machine was up, so its seed names the machine: same flow, and the strand node is replaced.
- Other members are unaffected: a peer the predicate admits takes the same path as with no predicate. Only nodes offering offline mode build the tracker, so always-on nodes behave as before.

## Tests added

| Test | What it verifies |
| --- | --- |
| Scenario: `removing a machine this node met releases the queue without a rebuild` | The member refusal alone releases a queue held by the strand node's memory of the machine; pins no rebuild by object identity |
| Scenario: `removing a machine in the launch seed releases the queue through one rebuild` | The rebuild releases a queue held by the seed; pins that the strand node was replaced |
| Spec: `asks for a rebuild for a removed machine in the seed, and not for one outside it` | The seed test, and that a change in the removed ids alone fires the listener (the live list stays empty) |
| Spec: `does not ask again while a rebuilt seed still names the machine, and asks again once a seed has left it out` | The loop guard and when it forgets |

The existing scenario's bring-up moved into a shared `withOfflineParty` helper, unchanged in behaviour.

Each arm was run without its mechanism:

| Build | Met arm | Seeded arm |
| --- | --- | --- |
| Prereq's build, no fix | Fails on the 60 s bound | Fails on the 60 s bound |
| Member refusal only | Passes, 166 ms | Fails on the 60 s bound |
| Full fix | Passes, 151–171 ms | Passes, 249–265 ms |

Times run from the start of `removeMachine` to the `committed` status, on loopback. Logs are in `tickets/.logs/removing-a-machine.*.log`.

## Known gaps for the reviewer

- **The ticket's claim about rotation order is only partly true (read from the code, not run).** It says the queue drains and then the rotation runs, following from the existing retry. Rotation writes are refused while the queue holds, so `removeMachine` reports that strand `pending`, and nothing re-drives it when the queue drains. The triggers are launch, resume, the first-sync gate opening, party key table changes and cohort growth. A seeded removal does get a resume, but its queue may not have drained by then. So on a closed strand the removed machine can stay a member until a later trigger. This is older than this ticket and applies to any removal made with a queue holding transactions, so I parked it as a `NOTE:` on `rotateAfterRemoval` instead of widening the change. Please judge whether it needs a ticket: a removal is a security action, so this may be more than a tripwire.
- **No closed strand runs through this path in any test.** The arms use an open strand, and the `machine-removal` scenarios do not offer offline mode, so they exercise neither the predicate nor the rebuild. They only show those paths are unaffected. A rebuild racing a rotation in flight should fail that drive into `pending`, and the resume re-drives it (every step reads before it writes). That is by inspection.
- **The redial loop was not changed.** It still dials a removed machine it holds a FRET (peer table) record for, at up to one round per 5 minutes while the record lasts, and a removed machine that is alive and connected still counts as a connected member, which pauses dialing others. Neither affects the release. Passing removed ids through its `isRevoked` would be a small change if you want it.
- **By inspection only, as the ticket expected:** a machine removed and re-added; the moment before the tracker's first read; a removed machine's row stating a third party's id (`NOTE:` at the predicate); two removals or a removal during a rebuild; a hibernating or building runtime; a queue draining with nobody else there.
- **A narrow race is left open, with a `NOTE:` on `rebuildWithoutRemovedMachine`:** a force-hibernate landing between the rebuild's quiesce and its resume is undone by the resume, and its cancelled timers leave the strand up until the next activity. The revisit is making the two steps one transition in the manager.
- **`docs/architecture.md` is unchanged.** Its removal section says nothing about the offline queue, so nothing there became wrong.
