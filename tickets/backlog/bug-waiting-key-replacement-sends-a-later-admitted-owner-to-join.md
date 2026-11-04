description: After a device is removed, the apps can tell an owner device to finish a waiting key replacement by joining with the host's fresh invitation, even when that device joined the cadre after the removal and cannot do it. The invitation is used up and the replacement stays stuck, with nothing on screen saying why.
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/machine-removal.ts (`pendingRotationWaitingOn`), packages/cadre-core/src/cadre-node.ts (`listPendingPartyKeyRotations`, `adoptFormationMembershipInvite`), packages/cadre-core/src/types.ts (`PendingPartyKeyRotation`), packages/cadre-core/src/strand-membership-reconciler.ts ("Redeeming under the pending key"), packages/reference-app-rn/src/machines.ts (`waitingRotationLine`), packages/reference-app-web/src/lib/machines.svelte.ts (`waitingRotationLine`)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: It takes an owner device added between the removal and the host's re-invitation, and the recovery is only a second invitation used from an older device, so a maintainer may defer it until owners report it.
----
# A waiting key replacement tells an owner device to join when that device cannot finish it

## What goes wrong

When a machine is removed from a cadre, the party's new membership key for each private workspace is stored in a `PendingStrandPartyKey` row, sealed to the machines that remain at that moment. A machine admitted later cannot open it.

`CadreNode.listPendingPartyKeyRotations` reports `waitingOn: 'another-party'` without looking at who the key is sealed to. So on an owner device admitted after the removal, both reference apps show "ask this workspace's host for a fresh invitation and join with it from this device" (or "this tab").

Following that instruction on such a device:

1. `formStrand` spends the invitation's one-time token at the host and stages the membership invitation in this machine's memory (`adoptFormationMembershipInvite`).
2. The membership reconciler cannot read the pending key here, so it leaves the invitation staged "for a machine that can read the key".
3. Staged invitations are in-memory and per machine, so no machine that can read the key ever receives it. The replacement stays pending and the removed machine stays served in that workspace.
4. The list still shows the same instruction, so the owner has no sign that anything failed.

## Expected behaviour

An owner device that cannot redeem under the pending key does not tell its user to join from it. The line names a device that can (an owner device that was in the cadre when the machine was removed), and the listing gives the apps what they need to tell the two apart.

The `PendingPartyKeyRotation.waitingOn` doc in `types.ts` and architecture.md ("a fresh invitation redeemed on an owner device of this party") have the same imprecision and should say which owner device.

The `NOTE:` on `listPendingPartyKeyRotations` already names the comparison that would tell (`partyKeyRecipients(row.sealedKey)`) for a related case, a row no live machine can open. A fix should settle that case in the same change if it is the same field.

## To confirm

Found by reading the code; not run. A scenario in the shape of `scenario-party-key-rotation-across-parties` would confirm it: remove a machine so a strand is `another-party`, admit a new owner machine that runs the strand, redeem the host's fresh invitation on that machine, and check that the new key is never seated and the invitation is not redeemed elsewhere.
