description: When a machine is removed from a cadre while it is online, it is sent the replacement key meant to lock it out of the cadre's private workspaces, so a tampered copy of the app on a stolen phone could use that key to get back in. The removal has to replace the key without the removed machine ever receiving it.
prereq: scenario-machine-removal-rotates-party-key
architecture: docs/architecture.md#removing-a-machine
repro: verified
files: packages/cadre-core/src/control-database.ts (`removeMachine`, `pendingPartyKeys`), packages/cadre-core/src/control-schema.ts (`PendingStrandPartyKey`), packages/cadre-core/src/cadre-node.ts (`removeMachine`, `driveRotationIfPending`, `driveTrackedPendingRotations`), packages/cadre-core/src/strand-party-key-rotation.ts (`bindMachines`), packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts
----
# A machine online at its removal receives the new party key

Removing a machine replaces the party's membership key K with a fresh key K' in each closed strand, so the removed machine is left holding a key that no longer counts. The private half of K' sits in `PendingStrandPartyKey.PrivateKey`, written in the same control transaction as the machine's tombstone (`ControlDatabase.removeMachine`), and the machine being removed ends up with that row in its own store.

How it gets there is not yet separated, and the fix depends on it. The likely path is the commit itself, since the machine is still in the control cohort when the transaction commits. A background read on the machine (its party key watch, or its reconciler's `isRotationPending`) could also pull the block in before the cut. Establish which, or close both.

The design assumed otherwise: `docs/architecture.md` said the removed machine never receives K', because the control database no longer syncs to it. That sentence is removed; "What removal still leaves" now states the actual behaviour and names this ticket.

## Reproduction (ran it, saw it)

In `machine-removal-rotates-party-key.integration.ts` (A1 the owner, A2 stopped, A3 online and being removed), straight after `owner.removeMachine(a3MachineId)`:

```ts
const a1Pending = await owner.getControlDatabase()!.queryPendingStrandPartyKey(strandId);
await owner.stop();
const a3Pending = await a3Node.getControlDatabase()!.queryPendingStrandPartyKey(strandId);
```

Observed in one run: A3 held no control connections, `a3Pending` was not null, and `a3Pending.privateKey` equalled `a1Pending.privateKey`. A1 was stopped before this read, so the answer came from A3's own store. An earlier run with A1 still up showed the same key on A3, and A3's `StrandPartyKey` still naming K.

## What this does and does not allow

- **A client running this code is still cut.** The scenario proves it: A1 and B hang up the removed machine and it neither reads nor pushes. It keeps `StrandPartyKey` on K and does not use the pending key without an owner signer.
- **A modified client holding K' (read from the code, not run).** K' becomes the party's member and manager key, and admission to a strand is a deny list, so a client presenting a fresh strand peer id is admitted as a stranger (`backlog/feat-strand-member-allowlist-admission`) and could then sign as the party. This defeats the purpose the removal states for a stolen phone.
- **A removed machine that also holds an owner key (read from the code; one run did not show it).** `driveRotationIfPending` and `driveTrackedPendingRotations` check for an enrolled owner signer but not whether this machine was itself removed, and `bindMachines` always adds the machine's own strand peer id. So an unmodified removed phone with an owner key looks able to drive the rotation and bind itself under K'. One probe gave A3 an owner key: over 30 s after the removal no such binding reached A1 or B and both stayed cut. That is one run of a race, so it does not rule this out. Confirm or dismiss this arm while fixing the site above; if the machine never receives the row the arm cannot occur.

## Expected behaviour

A machine being removed does not hold the private half of K' in any store, whether it was online at the removal or came back afterwards. The party's other owner machines can still finish a rotation another one started.

## Constraints a fix has to keep

These are stated in `docs/architecture.md` → "Removing a machine" and the module doc of `strand-party-key-rotation.ts`:

- The tombstone must never reach a machine without the signal that a rotation is pending. The membership reconciler reads "tombstone and no pending row" as "no rotation", and would clear the binding the rotation means to orphan, leaving the removed machine admitted as a stranger.
- Any owner machine running the strand can resume a rotation after a crash, and two owner machines driving one strand converge on one key.
- A removal commits in one owner approval, and the swap in a second.
- The `Superseded` handling stays either way: a second removal can remove a machine that legitimately held an earlier pending key.

## Regression test

Add the reproduction above to the scenario as an assertion that the removed machine holds no pending key, and remove its header's "Not proved here" paragraph and the sentence in "What removal still leaves".
