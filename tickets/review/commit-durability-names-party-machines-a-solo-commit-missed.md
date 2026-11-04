description: When a phone saves a change alone, the report it gives the app now names the party's own machines that still need that change, so a change waiting for an unreachable node no longer looks the same as one saved by a cadre of one machine.
architecture: docs/strands.md#a-commits-durability
prereq: offline-queue-waits-for-party-machines-that-hold-the-strand
files: packages/cadre-core/src/strand-commit-durability.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-commit-durability.spec.ts, docs/strands.md
----
# A commit's durability names the party's machines it did not reach

`StrandCommitDurability` gains an optional `awaitedMachines: readonly PartyStrandPeer[]`. It lists the party's other machines known to hold the strand (the last good answer of the prereq's `StrandPartyMachines`) that are not in `report.durability.overall.cohortPeerIds`, or are named in its `unconfirmed`. Optimystic's report stays unchanged at `report`.

- **Wiring.** `StrandInstanceManager.buildStrandDatabase` passes `partyMachines` through `StrandDatabaseConfig` to `StrandCommitRecord`, which reads it synchronously inside `reportCommit`. A node with no tracker (no offline mode offered) leaves the field absent. The field is present in either mode on a node offering offline mode, because the tracker exists whenever `config.offline` and `config.partyPeers` do.
- **Matching.** Machines are compared by `strandPeerId`, since the report names strand-network peers. The spec gives the control and strand ids different values so a comparison on the wrong id fails.
- **Clearing.** The list is empty whenever `heldElsewhere` is true. `reportHeld` replaces the entry with an empty list when the field was present.
- **No cohort named** (`overall` undefined, or no `cohortPeerIds`): every tracked machine is listed.

## Tests added

`packages/cadre-core/test/strand-commit-durability.spec.ts`, one table over `reportCommit`:

- Alone, machine not in the cohort: not held, machine listed.
- Alone, machine named in `unconfirmed`: not held, machine listed.
- `majority` with the machine in the cohort: held, list empty.
- `overall` undefined: not held, machine listed.
- Alone with no tracked machines (a cadre of one): not held, list empty.

## Validation run

`yarn typecheck`, `yarn lint` and the `@serfab/cadre-core` suite pass (195 files, 2606 passed, 1 skipped). `joiner-first-commit-over-slow-relay` passes (5 passed, 1 expected fail, the `it.fails` arm the test documents); it takes about 12 minutes. `cadre-core` was rebuilt first so that scenario ran against this code.

## Known gaps, for the reviewer

- **No end-to-end assertion on the new field.** The ticket specified a unit table only, and `joiner-first-commit-over-slow-relay` does not read `awaitedMachines`. So the wiring from `buildStrandDatabase` to a real commit is checked by the type checker and by reading, not by a running node. `strand-offline-waits-for-party-machine.integration.ts` would be the natural place to assert it, if a reviewer thinks it is worth the run time. That scenario was not run for this ticket.
- **`reportHeld` clearing and array freezing are by inspection**, as the ticket specified.
- **`partyMachines` is read when each database is built**, from the map entry of the current runtime. The tracker is created before the database and removed by the runtime's release, so a database should never outlive it. Checked by reading.

## Parked as `NOTE:` (per the ticket)

- `machinesAwaited`: ignores `otherCohorts`, so the list can over-report a machine that another cohort's answer shows holding a block.
- `StrandCommitRecord.reportHeld`: with two machines out, the first to take the copies clears the list while the second still lacks them.

## Behaviours accepted by inspection

- A `StrandPeer` row arriving just after a commit: that commit lists nobody and the next lists the machine. `strand:commit-durability` reads a snapshot and is not re-sent.
- A machine that ran the strand, left it and stays in the cadre is listed until removed, as in the prereq.

## Docs

`docs/strands.md` → "A commit's durability" has a new bullet under "How an app reads it". The "Limits" line about a lone founder still reads true (a lone founder has no tracked machines, and nobody else holds its copies), so it is unchanged.
