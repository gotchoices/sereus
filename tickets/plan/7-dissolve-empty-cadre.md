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
