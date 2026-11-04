description: When a user removes a dead machine from their cadre, a phone's offline queue now stops waiting for it and sends its saved changes, including when the phone had already met that machine or was started knowing about it. On a private workspace, the replacement of the party's key that locks the machine out now also finishes once those saved changes have gone.
architecture: docs/strands.md#offline-mode
prereq: offline-queue-waits-for-party-machines-that-hold-the-strand
files: packages/cadre-core/src/strand-party-machines.ts (`removed()`, `watchRemovedMachinesInSeed`), packages/cadre-core/src/strand-instance-manager.ts (`isNetworkMember` option, redial `isRevoked`, `watchSeedForRemovedMachines`, `StartStrandConfig.onRemovedMachineInSeed`), packages/cadre-core/src/cadre-node.ts (`queueSeedRemovalRebuild`, `rebuildWithoutRemovedMachine`, `handleQueueState`), packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/test/strand-party-machines.spec.ts, packages/integration-tests/src/scenarios/strand-offline-waits-for-party-machine.integration.ts, docs/strands.md, docs/architecture.md, docs/testing.md
----
# Removing a machine releases the offline queue waiting for it

Optimystic's reachability gate runs ahead of the gate that waits for the party's machines, and it could stay closed after a removal for two reasons. A third change makes the key replacement follow the queue.

- **The strand node remembers the machine (`absent-members`).** On a strand node that tracks the party's machines, `isNetworkMember` refuses a removed machine's strand peer id, read live from the tracker's last good read (`StrandPartyMachines.removed()`). Optimystic then answers `foreign` ahead of its remembered verdict, so cohorts and the absent-member list drop the machine.
- **The machine is in the running node's launch seed (`awaiting-bootstrap`).** A seed peer that is refused but serves the network counts as unheard for the node's whole life, and the seed is frozen. So when a read finds a removed machine among the peers of `config.bootstrapNodes`, the manager calls `StartStrandConfig.onRemovedMachineInSeed(strandId)`, and `CadreNode` rebuilds the runtime from a fresh seed through `handleStrandHibernate` then `handleStrandWake`. Rebuilds are chained per strand, and a strand already down is left down, since its next wake takes a fresh seed.
- **The key replacement runs when the queue empties.** Membership writes are refused while the queue lists a transaction, so `removeMachine` on a held queue reports the strand `pending`. `CadreNode.handleQueueState` drives the pending rotation when the queue's depth reaches 0.

The tracker's `onChange` also fires when only the removed ids change, so the queue wakes at once rather than on its next re-check. `watchRemovedMachinesInSeed` keeps a per-strand set of ids a rebuild was asked for (`seedRemovalsAnnounced`), so an id still in the rebuilt seed asks once and is then only logged. The redial loop treats a removed machine as revoked, on an open strand too.

## Tests

| Test | What it verifies |
| --- | --- |
| Scenario: `removing a machine this node met releases the queue without a rebuild` | The member refusal alone releases a queue held by the strand node's memory of the machine; pins no rebuild by object identity |
| Scenario: `removing a machine in the launch seed releases the queue through one rebuild` | The rebuild releases a queue held by the seed; pins that the strand node was replaced |
| Scenario: `removing a machine from a closed strand holding a queue finishes the key replacement once the queue drains` | The party key is swapped after the queue drains; failed its 60 s bound before the review's fix |
| Spec: `asks for a rebuild for a removed machine in the seed, and not for one outside it` | The seed test, and that a change in the removed ids alone fires the listener |
| Spec: `does not ask again while a rebuilt seed still names the machine, and asks again once a seed has left it out` | The loop guard and when it forgets |

## Review findings

**Read first:** the whole diff of `ticket(implement): removing-a-machine-releases-an-offline-queue-waiting-for-it`, then the handoff, Optimystic's `network-membership-gate.ts`, the hibernation manager, the rotation driver and the quiesce and resume ordering in the manager.

**Validation on the final code.**

- `yarn typecheck` and `yarn lint`: exit 0.
- `strand-offline-waits-for-party-machine` (4 of 4), `strand-offline-queue-survives-restart` and `machine-removal`: 6 of 6 in one run. This settles the validation the implement stage could not run. The target file's three original tests had also passed once before the review's edits.
- Queue release on loopback, from the start of `removeMachine` to `committed`: 171 ms met, 265 ms seeded, 373 ms closed.
- `@serfab/cadre-core` suite, after the logic edits and before one comment-only edit: 2607 passed, 1 skipped, 1 failed. The failure is below.

**Found and fixed in this pass.**

- **Defect, reachable in this ticket's own flow, verified by running it:** the rotation after a removal on a held queue never re-ran when the queue drained. The implement stage had parked this as a `NOTE:` and asked for a judgement. I added closed-strand arms: on a held queue, the party key was still not swapped 60 s after the removal, in both the met and the seeded flow, so the removed machine stayed a member of the closed strand. A removal is a security action and the fix is one trigger, so it is fixed (`handleQueueState`) rather than ticketed. Both arms then finished about 400 ms after the removal began. The met arm is kept as the regression test. The seeded arm and a no-queue arm were one-off probes and are not kept.
- **Redial loop:** a removed machine that is alive and connected counted as a connected member, which paused dialing the party's other machines, and the queue waits for those. It was also still dialed from its peer record. It now counts as revoked to that loop. Read from the code, not run, and left without a test because it is one wiring line.
- **Docs:** `docs/strands.md` (membership refusal and the removal bullet), `docs/architecture.md` (the party key watch's trigger list) and `docs/testing.md` now say the replacement runs on the drain. The removal section of `docs/architecture.md` was otherwise still correct.

**Checked by a probe, no change.** A rebuild racing a rotation: closed strand, machine in the seed, no queue. `removeMachine` returned `pending` after 1320 ms, because the rebuild took the database away during the drive, and the resume's drive swapped the key 285 ms later. The implement stage's reading was right. An app sees `pending` and then `strand:party-key-rotated`.

**Checked by reading, no change.**

- **Predicate:** a peer it admits takes the same path as with no predicate, verdicts are read live and not cached, and self is always admitted, so a re-added machine counts again on the next read.
- **Loop guard:** kept. `resolveCohortSeed` unions live siblings' answers with formation addresses. I did not trace `resolveSiblingSeed` further, so whether a removed relay can reach a fresh seed rests on the implement stage's reading. The guard is small, and without it that path would be an endless rebuild loop.
- **A node stopping during a rebuild:** `resumeStrand` refuses while the manager is stopping and refuses an untracked strand, and the chain logs the failure.
- **A failed rebuild** leaves the strand `hibernating` with no check-in armed by the rebuild. An armed idle timer or the next activity brings it back, and the transactions stay in the journal. Accepted as logged, since it needs a failed seed read or a failed build.
- **Tests:** the implementer's specs and scenarios meet the bar; none cut.

**Tripwires left at their sites.**

- `CadreNode.handleQueueState`: a queue held for another reason, such as a second unreachable machine, keeps the removed machine a member of a closed strand until it drains, unless another owner machine drives the rotation. New in this pass. If a lost phone's removal must not wait on that, this is the site.
- `rebuildWithoutRemovedMachine`: a force-hibernate landing between the quiesce and the resume. From the implement stage, kept.
- The predicate in `strand-instance-manager.ts`: a removed machine's row stating a third party's id. From the implement stage, kept.
- `watchRemovedMachinesInSeed`: a removed machine still configured as this node's relay. From the implement stage, kept.

**Tickets filed:** none. Nothing left over passes the filing bar: the one defect is fixed, and the rest is conditional.

**Failures not caused by this ticket.**

- `machine-removal-rotates-party-key`: uncaught libp2p `StreamStateError`s in two of three runs (37 and 60), one 60 s timeout in the third, and run times up to about four times those in an earlier log. The scenario does not offer offline mode, so the code changed here does not run in it. That is inferred from reading; it was not run at an earlier commit. Reported in `tickets/.pre-existing-error.md` for triage. Note its tests passed in two of those runs and vitest still fails such a run.
- `control-database-solo-warm-start.spec.ts`, "founding a CLOSED strand as the last member standing": the known `ensureOwnerKey() (genesis) timed out after 15000ms`, once under the full suite, then 6 of 6 alone. It matches the one-off record in `tickets/.pre-existing-known.md`, so it is not re-reported. The record's `DEBUG` step was not run, because a run alone would not show a load failure.

**Still by inspection only:** a machine removed and re-added, the moment before the tracker's first read, two removals in a row, a removal during a build, and a removed machine stating a third party's id. No scenario removes a machine on a closed strand that is shared with another party while the queue holds, so the `needs-another-party` outcome on a drain is unrun.

**Source size:** `cadre-node.ts` is 12,092 lines (`wc -l`), about 70 of them from this ticket and its review (`git diff --numstat`, `git show --numstat`). It was already very large, and no split is proposed here.
