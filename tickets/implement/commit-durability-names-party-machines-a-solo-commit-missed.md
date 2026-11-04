description: When a phone saves a change alone, the report it gives the app should name the party's own machines that still need that change, so a change waiting for an unreachable node no longer looks the same as one saved by a cadre of one machine.
architecture: docs/strands.md#a-commits-durability
prereq: offline-queue-waits-for-party-machines-that-hold-the-strand
files: packages/cadre-core/src/strand-commit-durability.ts, packages/cadre-core/src/strand-database.ts (`StrandDatabaseConfig`, `commits` ~127), packages/cadre-core/src/strand-instance-manager.ts (`buildStrandDatabase`), packages/cadre-core/src/index.ts, packages/cadre-core/test/ (a new `strand-commit-durability.spec.ts`), docs/strands.md
difficulty: easy
----
# A commit's durability names the party's machines it did not reach

Outside offline mode a lone commit is allowed by design, so nothing should be held. But Optimystic's `durability.overall.unconfirmed` lists only what `absentCohortMembers` knows, so a commit made before this phone has met its node reports `cohort: 1`, nobody owed. An app cannot tell that from a cadre of one.

This does not change Optimystic's report, which stays passed through unchanged at `report`. Sereus adds what it knows, read from the prereq's `StrandPartyMachines`.

```ts
export interface StrandCommitDurability {
  // ...existing fields...
  /**
   * The party's other machines known to hold this strand that do not hold this commit yet: those
   * not in `report.durability.overall.cohortPeerIds`, or named in its `unconfirmed`. Empty when
   * {@link heldElsewhere} is true. Absent on a node offering no offline mode, which does not track them.
   */
  readonly awaitedMachines?: readonly PartyStrandPeer[];
}
```

`StrandCommitRecord` takes an optional `partyMachines: () => readonly PartyStrandPeer[]` (the tracker's `machines`). `reportCommit` runs synchronously inside the commit, so it reads the tracker's last good answer and does not wait for a read. `reportHeld` replaces the entry with `awaitedMachines: []` when the field is present.

This applies to a commit in either mode: an online solo commit, and a queued transaction reported when it finally commits.

## Edge cases & interactions

- **`overall` undefined, or no `cohortPeerIds`.** The answering layer could not name the cohort: list every tracked machine, since none is confirmed to hold it. `heldElsewhere` is false there. Unit test.
- **`otherCohorts`.** The scalars describe the weakest answer, so this reads them and ignores the rest. A machine in another cohort's answer could be listed as awaited although that block reached it; the list is an over-report and `heldElsewhere` stays the answer to survival. By inspection, with a `NOTE:`.
- **A row arrives just after a commit.** That commit lists nobody and the next lists the machine. `strand:commit-durability` reads a snapshot and is not re-sent. By inspection.
- **A machine that ran the strand then left it but stays in the cadre.** It is listed until removed, as in the prereq. By inspection.
- **Frozen records.** Each entry stays frozen and is replaced on change, per the class comment. Freeze the array too. By inspection.
- **`strand:commit-held` for a commit with awaited machines.** The list clears when `heldElsewhere` turns true. A `local` commit is not reported held at once: `DurabilityFollower.follow` answers `held` only for a fully durable answer, a below-full commit is recorded in the under-replication ledger, and the event fires when the drain settles it, which `docs/strands.md` → Limits states for a lone founder ("until a member joins and takes the copies"). With two machines out, the first to take the copies clears the list while the second still lacks them. That is accepted: the field answers "who was this commit waiting for" until another machine holds it, and `heldElsewhere` is the survival answer. Leave a `NOTE:` at `reportHeld`. By inspection.

## Tests

`strand-commit-durability.spec.ts`, one table over `reportCommit` with a supplied machine list:

| overall | machines | `heldElsewhere` | `awaitedMachines` |
|---|---|---|---|
| `local`, cohort self, no `unconfirmed` | A | false | A |
| `local`, `unconfirmed: [A]` | A | false | A |
| `majority`, cohort self + A | A | true | empty |
| undefined | A | false | A |
| `local`, cohort self | none | false | empty |

## Docs

`docs/strands.md` → "A commit's durability", one bullet under "How an app reads it": "**`awaitedMachines` names the party's own machines known to hold the strand that do not hold this commit yet** ([Waiting for the party's own machines](#waiting-for-the-partys-own-machines)). It tells a commit waiting for a machine this node has not reached apart from one made by a cadre of one. Optimystic's `unconfirmed`, in `report`, names only peers this strand node has met." Correct the line in "Limits" about a lone founder if it no longer reads true.

## TODO

- Add `awaitedMachines` and the `partyMachines` input to `StrandCommitRecord`
- Pass the tracker's reader from `buildStrandDatabase` through `StrandDatabaseConfig`
- Export `PartyStrandPeer` from `index.ts` if the prereq did not
- Add the spec table, update `docs/strands.md`
- Run `yarn typecheck`, `yarn lint`, the `@serfab/cadre-core` suite, `joiner-first-commit-over-slow-relay`
