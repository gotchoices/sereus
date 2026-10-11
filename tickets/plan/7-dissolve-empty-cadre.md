description: After an app has moved its strands into the user's main cadre, the app's original one-node cadre is left with nothing in it and should be removed, so the app runs only as a member of the main cadre.
prereq: move-strand-between-cadres
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-rn/src/phone-node/config.ts, docs/architecture.md
difficulty: medium
----

# Dissolve an empty cadre

## What to build

- `dissolveParty(partyId)` on a node: allowed only when every strand (`Strand`, `JoinedStrand`) and pending join in the party is also present in the target party (moved by `move-strand-between-cadres`, whose B-side rows may not have been deleted), and no machine other than this node in `CadrePeer`. It stops the party's control network on this node and deletes the party's local storage.
- Dissolving is local: it deletes B's storage on this node and writes nothing to B's control database. (It could not delete the last `OwnerKey` row anyway: `OwnerKey.MinOneOwner`.)
- If other machines remain (for example, cadre B had its own always-on node), refuse and name them. Removing those machines first is the user's choice.
- Where the app's party id is persisted (cadre-rn config / app settings), switch it to the joined party, so the next launch starts as a member of A only.

## Edge cases & interactions

- Crash mid-dissolve: the next start finds an empty, half-removed party and finishes removing it, rather than founding it again. (Inspection; a durable "dissolving" marker written first.)
- Another app on the phone also uses cadre B (it joined B earlier): B is then not empty (that app's machine is in `CadrePeer`), so the refusal above covers it.
- Writes made in B while alone that have not replicated anywhere: with no other machine, there is nowhere for them to go. Confirm the move in `move-strand-between-cadres` happened first.

## TODO

- Implement `dissolveParty` and the party-id switch.
- Document it in docs/architecture.md.
- Test: B moves its only strand to A, dissolves, restarts, and comes up as A only.

## Note from planning `app-joins-existing-cadre-by-invitation`

After a join, the phone kit's saved start record already names the joined party (`origin: 'joined'`) and keeps the left one as `formerPartyId`; the "switch the persisted party id" step is done by the join. Dissolving deletes party B's storage (`controlStorageScope(B)`, the `<record>.<B>` node-local keys, the anchor slot for B) and clears `formerPartyId`. Only one node runs per app, so dissolving never stops a live B node.

## Note from planning `move-strand-between-cadres`

The move leaves B's rows in place (nothing is deleted in B; its node never runs again on the normal path). "Every strand is also present in the target party" is therefore read from the kit, not from B's storage: the phone kit keeps one secure-store record per source party, `cadre/strand-move/<base64url B>`, for as long as anything from B is still to be adopted, and deletes it when the adoption reports nothing left to retry. So B may be dissolved when the saved start names B as `formerPartyId` and no record for B exists; a record still present means the move is pending or partly refused, and dissolving must refuse and name the strands in it (`PhoneNode.pendingStrandMove()`). A strand the move refused permanently (A already participated in it under its own identity) stays in the record's `refused` list, so dissolving over it is the user's explicit choice, not a default.

## Note from implementing `move-strand-between-cadres`

Two corrections to the note above, from what landed in `packages/cadre-rn/src/phone-node/strand-move.ts`:

- **A permanent refusal does not keep the record.** The record is deleted as soon as an adoption reports nothing under `failed`, refusals included; the refusals are listed in that adoption's report (`JoinCadreResult.strandMove.report.refused`, or `finishStrandMove()`'s return), not kept. A refused strand is one A already participates in under its own identity, so its data stays reachable from A after B is dissolved; what is lost is B's own seat in it. If dissolving should still ask the user about those, the dissolve flow has to keep the refusals itself.
- **`pendingStrandMove()` returns `{ fromPartyId, toPartyId, strandIds, refused }`** for the record of `formerPartyId` (the running start's, else the saved one's), whatever party it names. `toPartyId` can differ from the running party when the app joined a third party before the move finished; dissolving must refuse then too, since the record is adopted only into `toPartyId`.

A join from a stopped app also writes the record: the kit starts B's node for the export alone. So "the saved start names B as `formerPartyId` and no record for B exists" holds only after the move finished, whichever way the join ran.
