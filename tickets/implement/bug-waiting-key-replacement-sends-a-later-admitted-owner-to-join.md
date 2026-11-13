description: After a device is removed, the apps can tell an owner device that joined the cadre later to finish a waiting key replacement by joining with the host's fresh invitation, which it cannot do, so the invitation is wasted and the replacement stays stuck. The waiting list should name the devices that can actually finish it.
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/types.ts (`PendingPartyKeyRotation`), packages/cadre-core/src/cadre-node.ts (`listPendingPartyKeyRotations` and its NOTEs, `pendingPartyKeyRecipients` NOTE, `isPendingPartyKeyRecipient`), packages/cadre-core/src/sealed-party-key.ts (`partyKeyRecipients`), packages/cadre-core/test/cadre-node-remove-machine.spec.ts ("records the party key rotation of a closed strand not running here as pending…"), packages/reference-app-rn/src/machines.ts (`waitingRotationLine`, `machineName`), packages/reference-app-rn/src/machines-section.tsx (`WaitingRotationRow`), packages/reference-app-web/src/lib/machines.svelte.ts (`waitingRotationLine`, `machineName`), packages/reference-app-web/src/Machines.svelte, docs/architecture.md (Removing a machine, `waitingOn` list), docs/reference-app-rn.md ("Key replacements waiting"), packages/reference-app-web/README.md ("Key replacements waiting")
repro: static
----
# The waiting key replacement list names the devices that can finish it

## The defect

When a machine is removed from a cadre, the party's new membership key for each private workspace (closed strand) is written to a `PendingStrandPartyKey` row with its private half sealed to the machines present at that moment (`CadreNode.pendingPartyKeyRecipients`). A machine admitted to the cadre later is not a recipient and cannot open it; `isPendingPartyKeyRecipient` and `readPendingPartyKey` already gate the driver and the membership reconciler on that.

`CadreNode.listPendingPartyKeyRotations` ignores who the key is sealed to. On an owner device admitted after the removal, a workspace waiting on `another-party` shows "ask this workspace's host for a fresh invitation and join with it from this device" (web: "this tab"). Joining there spends the host's one-time token, `adoptFormationMembershipInvite` stages the membership invitation in that machine's memory only, the reconciler leaves it staged because it cannot read the pending key ("Redeeming under the pending key" in `strand-membership-reconciler.ts`), and no recipient machine ever receives it. The replacement stays pending, the removed machine stays served in that workspace, and the line keeps giving the same instruction. The `owner-machine` line ("finishes on an owner device that runs it") has the same imprecision: an owner device that runs the strand but is not a recipient cannot finish it either.

Confirmed by reading; not run. The reproduction below pins the core half at the one-database layer.

## Why not refuse the join instead

An `OpenInvitation` carries a token, an sApp id and bootstrap addresses, not a strand id. The joiner learns which strand it joined only from the host's answer, after the host has spent the token. So `formStrand` cannot refuse before the spend without a protocol change. The fix is to tell the user the right device beforehand.

Rejected for this ticket, recorded as an alternative: `requestJoin` already persists a joined request's membership invitation in a party-wide `JoinSuccess` row and every owner machine stages it (`membershipInvitesToStage` in `pending-join-runner.ts`), so a re-invitation redeemed through `requestJoin` on any owner machine would reach a recipient. Moving the apps' Join via Invite from `formStrand` to `requestJoin` is a larger app change with its own semantics (retries, party-wide rows), and it does not help a non-owner or a machine that is not a recipient and not an owner. Leave it out; if owners keep hitting this after the fix, that is the next step.

## The change

### Core: the listing says who can open the key

Add to `PendingPartyKeyRotation` (types.ts):

```ts
/**
 * The machines of this cadre the new key is sealed to: control peer ids, each a live machine
 * (`listMachines`) or this node, in no particular order. Only these can redeem the host's
 * invitation under the new key or finish the replacement, and only those of them that hold an
 * owner key. A machine admitted after the removal is never one. Empty when every machine it
 * was sealed to has left the cadre.
 */
sealedTo: string[];
```

`listPendingPartyKeyRotations` computes it per row as `partyKeyRecipients(row.sealedKey)` filtered to the peer ids of `listMachines()` (read once per call, not per row), keeping this node's own peer id when it is a recipient. `partyKeyRecipients` reads only the envelope's public recipient ids, so a row sealed to other machines still lists. Read `listMachines` once at the top, after the `pending.size === 0` early return.

Keep `waitingOn` as it is: it says who outside the machine set has to act; `sealedTo` says which of the party's machines can act. Do not add a `waitingOn` state for an empty `sealedTo`: a removal of a recipient writes a replacement sealed to the machines present then (`signPendingPartyKeyReplacements` in `ControlDatabase.removeMachine`), so an empty list needs every recipient to leave without a removal writing one, and the apps cover it with one line (below).

Rewrite the two NOTEs this settles:

- The `listPendingPartyKeyRotations` NOTE "`waitingOn` does not look at who the key is sealed to…": the lost-machine case it describes (the party loses every recipient and recovers by re-joining under a fresh key) now shows as the listing naming the lost devices, and removing one of them writes a replacement sealed to the machines present. Replace the NOTE with one line saying that, or drop it if the `sealedTo` doc already says it.
- The `pendingPartyKeyRecipients` NOTE ("a machine admitted after the removal is not a recipient…"): keep the fact, point at `PendingPartyKeyRotation.sealedTo` as where the app learns it.

### Apps: name the devices

`waitingRotationLine` in both apps (`reference-app-rn/src/machines.ts`, `reference-app-web/src/lib/machines.svelte.ts`, same wording, "this device" vs "this tab") takes the machines list as well as `owner`, and resolves `sealedTo` against it: this device is a recipient when the `isSelf` machine's peer id is in `sealedTo`; others are named with the app's existing `machineName`/`machineCode` (the web `machineName` is module-private today; export or reuse as needed). A peer id in `sealedTo` with no row in the app's list is skipped.

Lines for `another-party`:

- Owner and this device a recipient: unchanged, "‹id›: ask this workspace's host for a fresh invitation and join with it from this device; or have the host admit key".
- Otherwise, with other recipients: "‹id›: ask this workspace's host for a fresh invitation and join with it from an owner device among The phone 1a2b3c4d, The always-on node 5e6f7a8b (this device cannot: it joined after the removal); or have the host admit key". Drop the parenthesis on a non-owner device, which cannot join for the party anyway; keep it on an owner device that is not a recipient, since that is the case this ticket is about.
- No recipient left: "‹id›: none of the devices this key was sealed to is in this cadre any more; have the host admit key". Admission by hand is the one route left (the driver still needs a recipient to finish after the seat, so say only what is true: check with `strand-party-key-rotation.ts` whether a seat admitted by hand finishes with no recipient; if not, the line says that removing a device writes a fresh replacement, and the key is not offered).

Line for `owner-machine`: "‹id›: finishes on an owner device that runs it, among ‹names›" when this device is not a recipient or there are other recipients; "‹id›: finishes on an owner device that runs it." when this device is the only recipient, unchanged; the no-recipient line as above when `sealedTo` is empty. `sealed` is unchanged.

Callers: `WaitingRotationRow` in `machines-section.tsx` and the `{#each}` in `Machines.svelte` pass the machines list they already hold (`MachinesState.machines` on web; check the RN section's state for the list it renders). The Copy button and the trailing key stay shown on every `another-party` line that offers the key.

### Docs

- architecture.md → Removing a machine, "What the app lists afterwards": add `sealedTo` to the listed fields, one clause on why (only recipients can redeem the host's invitation under the new key), and in the `another-party` item replace "an owner device of this party" with "an owner device of this party the new key is sealed to (`sealedTo`)".
- `PendingPartyKeyRotation.waitingOn` doc in types.ts: the same replacement in its `another-party` and `owner-machine` items.
- docs/reference-app-rn.md "Key replacements waiting" and packages/reference-app-web/README.md "Key replacements waiting": the new wording, one item each, not a retold diagnosis.

## Reproduction test

Extend the existing one-database test in `cadre-node-remove-machine.spec.ts` ("records the party key rotation of a closed strand not running here as pending, and a second removal replaces the pending key…") rather than adding a new one. After the first removal, admit a third machine with the same `issueInvitation`/`mintContactJoiner`/`redeem` helpers (the invitation needs one more use, or issue a second), then assert `listPendingPartyKeyRotations()` lists the strand with `sealedTo` containing this node and `second` and not `first` (removed) or the third machine (admitted after). After the second removal, assert the replaced row's `sealedTo` contains this node and the third machine, not `second`. Check first that the strand counts as held by the listing (`heldStrandRows`); if a founded-but-not-running strand is not listed, assert on `partyKeyRecipients` filtered the same way through the method under test, not through a copy of its logic.

No app-side test: the reference apps have no tests for these line builders today, and the wording is pinned in the docs.

## TODO

- Add `sealedTo` to `PendingPartyKeyRotation` with the doc above; fix the `another-party` and `owner-machine` items of the `waitingOn` doc.
- Compute it in `listPendingPartyKeyRotations` (recipients ∩ live machines, `listMachines` read once); rewrite the two NOTEs.
- Extend the remove-machine spec as described; run `yarn workspace @serfab/cadre-core test cadre-node-remove-machine`.
- Check whether a by-hand admission finishes with no recipient left, and word the empty-`sealedTo` line accordingly.
- Update `waitingRotationLine` and its callers in both reference apps; export the web `machineName` if needed.
- Update architecture.md, reference-app-rn.md and the web README.
- `yarn lint`, the two apps' type checks, and the cadre-core build/tests; confirm `party-key-rotation-across-parties.integration.ts` still compiles (it uses `toMatchObject`, so the new field needs no edit there).
