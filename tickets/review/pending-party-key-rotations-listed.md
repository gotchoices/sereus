description: A membership key replacement that waits on another party, or on an owner device that is not running, leaves a pending record behind that no app could read. Apps can now list these waiting replacements, with who can move each one forward and which key to name. The code is written, but its tests have not run, because a neighbouring repository this one links in is being edited.
prereq: party-key-rotation-redeems-an-invitation-under-the-pending-key
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/control-database.ts (`queryPendingStrandPartyKeys`, `PENDING_PARTY_KEY_COLUMNS`), packages/cadre-core/src/cadre-node.ts (`listPendingPartyKeyRotations`, `pendingRotationStrandState`, `closedStrandState`), packages/cadre-core/src/machine-removal.ts (`pendingRotationWaitingOn`, `PendingRotationStrandState`), packages/cadre-core/src/types.ts (`PendingPartyKeyRotation`), packages/cadre-core/test/cadre-node-remove-machine.spec.ts, docs/architecture.md (Removing a machine), docs/strands.md (Replacing the party's key)
----
# Listing the party key replacements still pending

## Gap to close first: no vitest run has happened, and the listing itself has never executed

**Blocked on a sibling's build.** Every attempt to run vitest in `@serfab/cadre-core` (01:05 to 01:12 on 2026-11-04) was refused by the stale-build guard: `@quereus/quereus: dist is stale`. `../quereus` has uncommitted work in progress. `planner/analysis/change-scope.ts` and `expression-fingerprint.ts` are newer than its 00:54 build. `tickets/rules/sibling-repos.md` forbids building it from here, so I did not. `yarn check:published` cannot stand in, because it runs from `HEAD` and this work is uncommitted.

**Ran and passed:**

- `yarn workspace @serfab/cadre-core typecheck` (the config includes `test/`, so the new spec code is type-checked), `yarn lint`, `yarn check:test-file-typecheck-coverage`: all exit 0.
- The `waitingOn` table, outside vitest: a scratch script, since deleted, bundled with esbuild and run with node against the real `machine-removal.ts`. All 9 rows matched: the 6 in the spec, plus hibernating and two failed-read rows. The bundle's input list held no `@quereus/quereus` file, so the stale build played no part. This checks the function's logic. It is not a run of the spec.

**Not run:**

- `cadre-node-remove-machine.spec.ts`, including the new `describe`.
- `yarn workspace @serfab/cadre-core test`.
- `ControlDatabase.queryPendingStrandPartyKeys()` and `CadreNode.listPendingPartyKeyRotations()` have not run against any database, so the new SQL is checked by type-checking and by reading only. I did not run them through a vitest config without the guard, because that would exercise the stale engine the guard refuses.

**Owed by review, once the guard passes:**

- `yarn workspace @serfab/cadre-core exec vitest run cadre-node-remove-machine`, then `yarn workspace @serfab/cadre-core test`.
- Run the real read once. The ticket deliberately keeps no permanent test on it, because `scenario-party-key-rotation-across-parties` will assert it on a real network, and that scenario cannot start until this ticket completes. Temporarily add this as the last line of the spec's `records the party key rotation of a closed strand not running here…` case:

  ```ts
  expect(await node.listPendingPartyKeyRotations()).toEqual([{ strandId, publicKey: replaced!.publicKey, superseded: [pending!.publicKey], waitingOn: 'owner-machine' }]);
  ```

If the guard still refuses at review, say so in the output rather than treating this as validated. `tickets/blocked/removed-machine-receives-new-party-key.md` is the precedent for routing to `blocked/` under "a dependency outside this repository". The unblock is the Quereus owner running `yarn workspace @quereus/quereus build` in `C:\projects\quereus`.

## What was built

A `PendingStrandPartyKey` row outlives the `removeMachine` call that wrote it whenever the replacement cannot finish on the removing machine. `MachineRemovalResult.strands` reports that once, to the caller. `CadreNode.listPendingPartyKeyRotations(): Promise<PendingPartyKeyRotation[]>` is the durable read an app shows until the swap.

```ts
interface PendingPartyKeyRotation {
  strandId: string;
  publicKey: string;     // what another party's manager admits by hand
  superseded: string[];  // earlier pending keys this one replaced, public halves
  waitingOn: 'another-party' | 'sealed' | 'owner-machine';
}
```

- **Which rows.** Every live row (retired stamps hidden, through the new `ControlDatabase.queryPendingStrandPartyKeys()`, which returns a `Map` by strand id and shares the column list, row mapping and revoked-stamp filter with the single-row read) whose strand has a `Strand` or `JoinedStrand` row here.
- **`waitingOn`.** The pure `pendingRotationWaitingOn` in `machine-removal.ts`, beside `rotationSite`, over `PendingRotationStrandState` (`ClosedStrandState` plus `sealed` and `pendingKeySeated`, each `'unknown'` with no live database or when the read fails).
- **`closedStrandState` is reused** for runtime and manager seat. Its `partyKey` argument is now `string | null` (null gives seat `unknown`), and its log line no longer names `planMachineRemoval`, since it now has two callers.
- **`PendingPartyKeyRotation` is exported** through the existing `export * from './types.js'`, so `index.ts` needed no edit.
- **No new event**, recorded as a `NOTE:` on the method, with the revisit condition. **No withdrawal**, stated in `docs/architecture.md`.

## A call for the reviewer to check

The ticket says `sealed` wins over `another-party`, and does not cover a sealed strand whose new key is already seated. I made a seated key win over `sealed`: that case answers `owner-machine`. The `sealed` state tells the app "nobody can admit the key", which is false once the key is in. And the driver can finish there: with the new key a member it binds machines and writes the old key's self-signed leave, and `docs/strands.md` says members can still leave and register device records on a sealed strand. The old key is not the last member at that point, so the last-member rule does not stop it. This added the one spec row beyond the ticket's five.

## Tests

In `cadre-node-remove-machine.spec.ts`, `describe('pendingRotationWaitingOn')`, one `it.each` table, one expectation per row:

| Input | Verifies |
|---|---|
| sealed, no seat | `sealed` beats `another-party` |
| sealed, new key seated | a seated key beats `sealed` (the call above) |
| live, no seat, key not a member | `another-party` |
| live, no seat, key a member | `owner-machine`: the app stops asking the host |
| live, manager seat | `owner-machine` |
| not running here, all reads unknown | `owner-machine` |

Nothing on `listPendingPartyKeyRotations` itself, as the ticket specifies.

## Behaviour checked by inspection only

- A row sealed to other machines still lists, since only public columns are read.
- A hibernating strand answers `owner-machine`, and the listing does not wake it.
- A machine removed from the cadre gets `[]`. A stopped node throws, and that check runs first.
- A row for a joined strand the party has left stays in the table and is not listed.

## Known limits, for the reviewer to weigh

- **Local view.** `isStrandMember` and `isStrandSealed` read what this machine has replicated, so a seat or a seal that has not arrived yet can briefly show as `another-party`. The docs say the answer is judged from this machine's view.
- **A held strand with no `StrandPartyKey` row.** It lists as `owner-machine`, as the ticket's "which rows" rule requires, but the driver treats that state as "nothing to rotate" (`StrandPartyKeyRotationDriver.prepare`), so no owner machine clears the entry. Reaching it takes a party deleting its own key row while a replacement is pending. I did not add handling for it.
- **Raw held-strand reads.** `queryStrands` and `queryJoinedStrands` apply no retired-stamp filter, the same as the removal plan's read, so a strand row whose tombstone arrived without its delete counts as held.

## Docs

- `docs/architecture.md`: a "What the app lists afterwards" paragraph with the three states, and a "A pending replacement cannot be withdrawn" paragraph, both after "What the app is told".
- `docs/strands.md`: one sentence on the cross-party bullet pointing at the listing, which replaces the parenthetical that anticipated it.

## Usage

An app reads the list with its machines list, after its own `removeMachine`, and on `strand:party-key-rotation-blocked` and `strand:party-key-rotated`. For `another-party` it tells the owner to get a fresh invitation from the host and join with it, or to have the host admit `publicKey`. The reference apps' use of this is `reference-apps-show-pending-party-key-rotations`.
