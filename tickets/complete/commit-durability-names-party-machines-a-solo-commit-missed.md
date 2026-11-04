description: When a phone saves a change alone, the report it gives the app now names the party's own machines that still need that change, so a change waiting for an unreachable node no longer looks the same as one saved by a cadre of one machine.
architecture: docs/strands.md#a-commits-durability
prereq: offline-queue-waits-for-party-machines-that-hold-the-strand
files: packages/cadre-core/src/strand-commit-durability.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-commit-durability.spec.ts, packages/integration-tests/src/scenarios/strand-offline-waits-for-party-machine.integration.ts, packages/cadre-core/README.md, docs/strands.md
----
# A commit's durability names the party's machines it did not reach

`StrandCommitDurability` has an optional `awaitedMachines: readonly PartyStrandPeer[]`: the party's other machines known to hold the strand (the last good answer of `StrandPartyMachines`) that are not in `report.durability.overall.cohortPeerIds`, or are named in its `unconfirmed`. Optimystic's report stays unchanged at `report`.

- **Wiring.** `StrandInstanceManager.buildStrandDatabase` passes `partyMachines` through `StrandDatabaseConfig` to `StrandCommitRecord`, which reads it synchronously inside `reportCommit`. A node with no tracker (no offline mode offered) leaves the field absent. On a node offering offline mode the field is present in both modes.
- **Matching.** Machines are compared by `strandPeerId`, since the report names strand-network peers.
- **Clearing.** The list is empty whenever `heldElsewhere` is true. `reportHeld` replaces the entry with an empty list when the field was present.
- **No cohort named** (`overall` undefined, or no `cohortPeerIds`): every tracked machine is listed.

An empty list on a commit not held elsewhere does not prove a cadre of one (`docs/strands.md` → "A commit's durability").

## Tests

- `packages/cadre-core/test/strand-commit-durability.spec.ts`: one table over `reportCommit`.
- `strand-offline-waits-for-party-machine.integration.ts`: step 2 commits alone outside offline mode against a real unreachable node and asserts the node is named, and the end of the scenario asserts the list is empty once that commit is held.

## Review findings

Read the diff of `ticket(implement): commit-durability-names-party-machines-a-solo-commit-missed` first, then the handoff, the prereq's tracker, Optimystic's `WriteDurability` and `mergeDurability`, and the database's lifecycle.

**Checked, no defect**

- *Peer ids:* `cohortPeerIds` and `unconfirmed` are strand peer ids, and the filter uses `strandPeerId`. The spec's distinct ids would catch a mix-up, and the new integration step checks it on real ids.
- *`otherCohorts` direction:* below `majority` a non-self machine cannot be both in the weakest answer's cohort and confirmed, because `local` and `unrouted` confirm only this node. So ignoring `otherCohorts` can only over-report, as the implementer's `NOTE:` says.
- *Lifecycle:* the only `new StrandDatabase` is in `buildStrandDatabase`. `retryUnreachableJoin` reads the same map entry, and a resume builds a new tracker. `releaseRuntime` stops the tracker along with the database, and a stopped tracker still answers `machines()` safely.
- *Event path:* `CadreNode` emits the record unchanged, so `strand:commit-durability` carries the field. `PartyStrandPeer` was already exported from `index.ts`.
- *Bounded memory, resources:* no new listener or timer; the record's 256-entry limit is unchanged.
- *Spec table:* every row covers a distinct branch or a named edge case, so none was cut.

**Found and fixed in this pass (minor)**

- *Wiring and clearing were unverified on a running node* (the implementer's first two known gaps). Added the integration step above, at no extra bring-up cost. The scenario passed 3 of 3 runs at about 10 s per run, so `reportHeld`'s clearing is now observed rather than inferred.
- *Doc contract too strong.* The new bullet read as though an empty list meant a cadre of one, which the ticket's own purpose invites an app to conclude. It is not true when the `StrandPeer` row has not arrived, the read is pending or failed, or the commit is torn with its cohort reached. Stated that in `docs/strands.md` and on the field's doc comment.
- *Docs the change should have touched.* Added `awaitedMachines` to the `strand:commit-durability` row of `packages/cadre-core/README.md`, to "Writable does not mean connected", and to "Outside offline mode nothing is held" in `docs/strands.md`.
- *Stale comments.* The two comments in `strand-instance-manager.ts` listing the tracker's readers now include the commit record.

**Parked as tripwires**

- A failed tracker read is not retried by a commit, so in online mode the list can stay empty until the next control-table change: new `NOTE:` on `StrandCommitRecord`'s `partyMachines` parameter.
- `otherCohorts` over-report: the implementer's `NOTE:` on `machinesAwaited`, left as is.
- With two machines out, the first to take the copies clears the list: accepted-tradeoff `NOTE:` on `reportHeld`, left as is.

**Major:** none, so no ticket filed. **Pre-existing failures:** none seen.

**Validation:** `yarn typecheck` and `yarn lint` pass. The `@serfab/cadre-core` suite passes (195 files, 2606 passed, 1 skipped). `strand-offline-waits-for-party-machine` passes 3 of 3. `joiner-first-commit-over-slow-relay` (about 12 minutes) was not re-run, because this pass changed no runtime code in `cadre-core`, only comments; the implement stage's run stands.
