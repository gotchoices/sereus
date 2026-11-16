# Removing a machine

This document describes how an owner takes a machine out of a party's cadre: the calls an app makes, what the removal writes, how the other machines and the removed machine react, and how the party's membership key is replaced in each closed strand. It is for app developers building a device list and for maintainers changing the removal path.

Related: [adding machines](membership.md) · [owner keys](owner-keys.md) · [who a node trusts and admits](control-security.md) · [how a party's machines converge](control-convergence.md) · [closed-strand keys](../strands/keys.md) · [closed-strand membership](../strands/membership.md) · [glossary](../concepts.md#glossary)

## What the app calls

`CadreNode.removeMachine(peerId)` takes a phone, an app or an always-on node out of the cadre. It needs this node's owner key. Owner keys are not machines and are neither listed nor removed by these calls ([Removing an owner key](owner-keys.md#removing-an-owner-key)).

```typescript
const machines = await ownerNode.listMachines();             // what the app lists
const plan = await ownerNode.planMachineRemoval(peerId);     // read-only, for the confirmation step
if (plan.refusal === null && plan.machine !== null) {
	const result = await ownerNode.removeMachine(peerId);
}
const pending = await ownerNode.listPendingPartyKeyRotations();
```

- `listMachines()` returns one `CadreMachine` per live `CadrePeer` row.
- `planMachineRemoval(peerId)` writes nothing. It returns the machine (null when no live row names it here), a refusal if there is one, the invitations the machine could use to come back, and where each closed strand's key will be replaced.
- `removeMachine(peerId)` throws `MachineRemovalRefusedError` before any write, with code `not-an-owner` when this node holds no enrolled owner key, or `self` for this node's own machine: leaving a cadre is the embedder's own flow, which stops the node and deletes the cadre's data. A machine already removed elsewhere removes nothing and returns an empty result.

## What one transaction removes

`ControlDatabase.removeMachine` writes all of the following in one transaction, under one owner approval:

- **The machine's `CadrePeer` row**, with a tombstone. This ends its membership and removes its address.
- **Its `DeviceToken` row**, when it has one, with a tombstone. A removed phone must not be woken by push.
- **A withdrawal tombstone for every live invitation the machine could redeem to return**: one targeted at it, or one it already redeemed that has uses left. Without this a removed device could redeem a live invitation again.
- **A `PendingStrandPartyKey` row for every closed strand the party holds a membership key for.** It holds a new key sealed to the identity keys of the machines that remain. The removed machine receives this transaction and cannot open the key.

The writes share a transaction so that no machine reads the removal half-applied, and so that the tombstone never arrives without the pending row. The strand membership reconciler would read that state as "no key replacement" and undo the cut the replacement is meant to make ([Binding the party's machines](../strands/membership.md#binding-the-partys-machines)).

Owner grants are left alone, because none names a machine. Every tombstone is re-issued when the cohort grows, so a removal committed while alone still reaches the other machines ([Deletes made while alone](control-convergence.md#deletes-made-while-alone)).

## Connections close on evidence

The protocol guard already refuses a removed peer's streams. Each machine also hangs up its control connections to any peer that a `CadrePeer` tombstone names and that has no live row. On the remover this happens before `removeMachine` returns; every other machine follows once the tombstone has replicated to it.

The rule denies only on evidence held. A peer that merely dropped out of the authorized set keeps its connection, and so does a re-admitted machine, which has a tombstone and a live row under a new stamp.

## The removed machine learns of it

A node reports its own removal when a `CadrePeer` tombstone names its peer id, it has no live row, and an earlier refresh in the same process saw its live row. The last condition keeps a machine that is joining again from reporting itself removed when its new store receives the old tombstone before its new row.

The node then emits `cadre:removed` once, and `removedFromCadre()` returns the same record. Stopping the node and deleting the cadre's data belong to the embedder, which owns the storage and the process.

## The party's key in each closed strand

A removed machine still holds the party's membership key for each closed strand, and a strand is a separate network with its own membership, so removal from the cadre alone would leave the machine a member there. The party therefore moves to a new membership key in each closed strand, starting from the pending rows the removal wrote. [Replacing the party's key](../strands/keys.md#replacing-the-partys-key) describes the mechanism; this document covers what the app sees.

`removeMachine` runs the replacement itself for each closed strand that runs on this node, waking a hibernating one first. The final control write of a replacement is a second owner approval.

## What the plan, the result and the pending list say

Each of the three classifies every closed strand the party holds a membership key for. The comments on `StrandKeyRotationPlan`, `StrandKeyRotationOutcome` and `PendingPartyKeyRotation` in `types.ts` define each value.

- **The plan** says where the replacement will run: `here`, `later` (the strand does not run on this node) or `another-party` (the party holds no manager seat in the strand).
- **The result** says what happened: `rotated`, `pending` (an owner machine of the party that runs the strand finishes it) or `needs-another-party` (the strand's host re-invites the party, or one of the strand's managers admits the new key by hand).
- **The pending list**, `listPendingPartyKeyRotations()`, is what an app shows until each replacement finishes, on any machine of the party, because the result reaches only the caller, once. Each entry gives the strand, the new key's public half, the machines the key is sealed to (`sealedTo`) and who acts next (`waitingOn`): `owner-machine`, `another-party` or `sealed`.

`sealed` means the strand has no managers and the new key is not a member. Nobody can admit the key, and the removed machine stays a member until the strand is re-formed. The removal's own result reports this case as `needs-another-party`.

No event announces a pending row that replicated from another machine. An app reads the list again on `strand:party-key-rotation-blocked`, on `strand:party-key-rotated`, and after its own `removeMachine`.

## Limits and accepted tradeoffs

- **A removed machine keeps what it already has.** It keeps every control row and strand block it synced, and the read secret each closed strand delivered to it. No code encrypts strand data with that secret, and the secret is never replaced in a running strand ([Closed-strand keys](../strands/keys.md#limits-and-accepted-tradeoffs)). A machine that lags on the tombstone keeps serving it until its own rows catch up.
- **Removing a machine does not remove an owner key it held.** Whoever holds a lost device can still sign owner writes, including a new invitation for that device, so apps offer removing the key together with removing the machine.
- **The removed machine learns of its removal only if the tombstone reaches it** before the others cut it off. A machine that was offline usually never learns, and one that synced the tombstone and restarted before acting does not report it again, so embedders persist what they did.
- **The key replacement has limits of its own.** The new key is unencrypted once it is current, a pending replacement cannot be withdrawn, a machine admitted after the removal cannot finish it, and a pending row written while the remover was alone is lost with the remover ([Closed-strand keys](../strands/keys.md#limits-and-accepted-tradeoffs)).
- **A modified client can return to a strand as a stranger.** A strand's network admits a peer with no binding, so a removed machine that presents a new strand peer id is served ([Closed-strand membership](../strands/membership.md#limits-and-accepted-tradeoffs)).
- **Concurrent removals collide.** Two owners removing the same machine collide on the tombstone's key and the second transaction fails whole. Two removing different machines collide on the pending row and the second plans again. If the owners are partitioned, both commit, each seals its key to the machine the other removed, and the row that survives the merge names a removed machine as a recipient (ticket `forked-control-collection-sync-livelocks`).
