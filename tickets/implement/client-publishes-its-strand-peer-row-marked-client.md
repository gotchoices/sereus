description: A phone that uses a party's shared workspaces without storing them now records its network identity for the party, marked as a non-storing machine, so the key replacement after a machine removal keeps it admitted while the offline write queue still waits only for machines that store the workspace.
prereq: strand-peer-row-carries-the-machines-role
architecture: docs/strands/membership.md#binding-the-partys-machines
files: packages/cadre-core/src/strand-party-peers.ts, packages/cadre-core/src/strand-party-machines.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/test/strand-party-peers.spec.ts, packages/cadre-core/test/strand-party-machines.spec.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/strands/membership.md, docs/strands/keys.md, docs/strands/writes.md, docs/cadre/node.md, docs/cadre/control-schema.md, .release-notes.pending.md
repro: static
difficulty: medium
----

# A client publishes its `StrandPeer` row, marked `client`

Second of three tickets for `client-locked-out-of-closed-strand-after-party-key-replacement`. The first (`strand-peer-row-carries-the-machines-role`) gave the row a `Role` column, null for a serving machine and `'client'` for one that stores no blocks. This ticket makes every machine publish its row, makes the one reader that must ignore clients ignore them, and updates the docs that state the old limit. The third (`scenario-client-survives-party-key-replacement`) proves it end to end.

## What the code does today, read from it

- `StrandInstanceManager.buildStrandRuntime` publishes this machine's `StrandPeer` row at bring-up only when `roles.strandCohortMember` is on (the `servesBlocks` guard around `config.partyPeers.publishOwn`).
- The membership loop's step 6 (`StrandMembershipReconciler.publishOwnStrandPeer`) calls the same `publishOwn` seam on every pass, with no role guard, and `CadreNode.publishStrandPeer` has none either. The loop runs on every closed strand the party holds a key for, clients included (`docs/cadre/node.md` → "Membership is unchanged").

So the skip the filed ticket describes holds only on open strands, where no loop runs. On a closed strand a client's row is written by its first loop pass, with no role, and from then on it counts as a machine a serving sibling's offline queue waits for (`strand-party-machines.ts`), which is the outcome the skip existed to prevent. The lockout as filed occurs on a closed strand only when the row is not yet in the party's control database when the replacement binds machines: the loop disabled, or the write deferred while this node was alone or refused because its own `CadrePeer` row had not arrived. Both the stated defect and this inconsistency resolve at the same sites, so this ticket covers both.

## The change

**Every machine publishes.** Remove the `servesBlocks` condition around `publishOwn` in `buildStrandRuntime` and rewrite the comment above it: the row is written for every machine and every strand, and the role column says whether the machine serves. The `PartyStrandPeerSource.publishOwn(strandPeerId)` signature stays; the role is the node's, so `CadreNode.publishStrandPeer` passes `this.roles.strandCohortMember ? null : 'client'` to `insertStrandPeer`. `deferredStrandPeerWrites` keeps storing the strand peer id alone; the role is read again at the retry.

**The partition carries the role.** `PartyStrandPeer` (`strand-party-peers.ts`) gains `serves: boolean`, true when the row's role is not `'client'`. `partitionPartyStrandPeers` sets it from the row. `PartyStrandPeers.live` includes clients; `removed` is a list of ids and does not change.

**Only the machine tracker filters.** `StrandPartyMachines.read` keeps `peers.live.filter((peer) => peer.serves)` as `machines()`; `removed()` keeps every removed id, client or not. Rewrite the module and class comments: the tracker is the party's other machines that *serve* the strand, which is what a queued transaction must not be committed without; a client is in no cluster and never counted. Everything downstream of `machines()` then sees serving machines only without a change of its own: the composed gate `cohortGateWaitingForMachines`, `StrandInstanceManager.unreachedPartyMachines` (what `CadreNode.getUnreachedStrandMachines` reports), the commit durability record's awaited machines, and the redial loop's `partyMachines` (`strand-peer-redial.ts`), where a client must not count as "a member is connected".

**The binders read `live`, unfiltered.** The key replacement's `readSiblingPeerIds` (`cadre-node.ts`, feeding `StrandPartyKeyRotationDriver.bindMachines`) and the loop's `reconcileSiblings` already map `peers.live` to ids and need no code change. Update the module comment of `strand-party-key-rotation.ts` (step 3: every live machine, clients included) and the comment on `PartyStrandPeers.live` to say clients are in it and why, and the `publishOwnStrandPeer` comment in the reconciler to drop the idea that bring-up may have skipped the row.

**The scenario assertion flips.** `strand-client-node-holds-no-blocks.integration.ts` step 6 asserts the client published no row. It now asserts the row set is all three machines, the client's row has role `'client'` and the two serving rows have none. That scenario launches an open-strand row, so this also shows the bring-up write runs on open strands for a client; edit its header comment to match.

**Docs.**

- `docs/strands/membership.md` → Binding the party's machines: replace the "publishes no row" bullet with one saying the row states whether the machine serves, that the key replacement and the loop bind every live machine including clients, and that only the offline queue reads the role. Add to that doc's "Limits and accepted tradeoffs": the role is recorded at the machine's first publish for a strand and never changes, so a machine reconfigured between client and serving keeps its first statement for strands it already ran; the queue then waits for a machine that became a client, or stops waiting for one that became serving. Remedy: a new strand, or the revisit condition that a self-signed update branch on the row would lift it.
- `docs/strands/keys.md` → the limits list: delete the bullet "A replacement cannot bind a machine that holds no strand blocks".
- `docs/strands/writes.md` → "Which machines count": a machine whose row says it serves; a client's row is read and skipped.
- `docs/cadre/node.md` → "No `StrandPeer` row" bullet becomes "A `StrandPeer` row marked `client`", linking to the membership doc for who binds it and to writes.md for why the queue skips it.
- `docs/cadre/control-schema.md` → the Tables row's readers column already names the three readers; add a limits bullet only if the membership limit is better placed there (one home: pick membership.md and link from here, or the reverse).
- `.release-notes.pending.md` → in the client section, replace the "publishes no `StrandPeer` row" bullet with: a client publishes its row marked `client`; a serving sibling's queue never waits for it; the key replacement binds it; and the mixed-release caveat, that a machine still on the previous release reads a client's row as unverifiable and ignores it, so until every machine of the party has updated, an owner machine on the old release that drives a replacement still leaves the client unbound. Add a short section that the control schema is at version 5 and what the column is; the "do not remove a machine" warning goes.

## Edge cases & interactions

- **A client whose row has not reached the party when the replacement runs** is still unbound when the old key leaves. Recovery is the existing path: when its row arrives, the party-machine watch re-arms every sibling's loop, a sibling binds it under the current key, and the revoked-peer enforcer on each serving machine stops refusing it once that binding replicates (`docs/strands/membership.md`: "A sibling binds it under the current key, the other machines stop refusing it"). Verify by inspection that `reconcileSiblings` binds from `live` with no role test and that the enforcer watches `Strand.MemberPeer`; name the window in the membership doc bullet.
- **A removed client.** Its row and its `CadrePeer` tombstone put its id in `removed`; the loop clears its binding under the current key outside a replacement and leaves it as the orphan during one, as for a server. The redial loop refuses the id through `removed()`. By inspection; the partition spec arm below pins the partition half.
- **A client whose party runs offline mode.** The client's own tracker now reads other clients' rows too and must skip them: a phone must not wait for another phone. Pinned by the tracker spec arm.
- **A serving machine connected only to a client.** `memberConnected` in the redial loop counts a party machine as a member connection; with clients out of `machines()`, a server whose only connection is a phone keeps dialing its serving siblings. By inspection of `superviseStrandPeerRedial`'s use of `partyMachines`.
- **The row write is deferred or refused on a client** exactly as on a server: alone with other party members, or own `CadrePeer` row not yet here; the growth drain, the party-machine watch and the loop's step 6 retry it. A client on an ephemeral identity writes nothing, as today. By inspection of `publishStrandPeer`.
- **A client of an open strand.** No loop, no bindings; its row only lets a sibling look up its strand address, and the tracker skips it. Observed by the flipped scenario assertion.
- **Mixed releases.** A version-4 sibling drops the client's row (previous ticket). Its tracker and its binders behave as before this change; a version-5 sibling binds the client. State the window in the release note; no test.
- **The role changes between restarts.** `insertStrandPeer` logs the mismatch (previous ticket); the docs state the limit. No code path rewrites the row.
- **`onChange` listeners of the tracker** fire only when the serving set or the removed set changes; a client row arriving changes neither and wakes nobody. By inspection of `read`'s comparison, which runs after the filter.

## Tests

- `strand-party-peers.spec.ts`: extend the one existing case with a live client row (`role: 'client'`) expected in `live` with `serves: false`, a serving row with `serves: true`, and a removed client row expected in `removed`.
- `strand-party-machines.spec.ts`: one new `it` on `StrandPartyMachines`: a read whose `live` holds a serving sibling and a client answers `machines()` with the serving sibling alone, and `removed()` with every removed id.
- `strand-client-node-holds-no-blocks.integration.ts`: assertion 6 flipped as above. Run that file in the foreground if its wall clock fits; otherwise say so in the handoff.

No test for the key replacement driver or the reconciler: both already bind whatever `live` holds, and the scenario ticket covers the chain.

## TODO

- `strand-party-peers.ts`: `PartyStrandPeer.serves`, set in `partitionPartyStrandPeers`; comments on `live`.
- `strand-party-machines.ts`: filter in `read`; module and class comments.
- `strand-instance-manager.ts`: drop the `servesBlocks` guard, rewrite the comment.
- `cadre-node.ts`: `publishStrandPeer` passes the node's role.
- Comments in `strand-party-key-rotation.ts` (step 3) and `strand-membership-reconciler.ts` (step 6).
- Spec arms in `strand-party-peers.spec.ts` and `strand-party-machines.spec.ts`; scenario assertion 6 and header.
- Docs listed above and `.release-notes.pending.md`.
- `yarn workspace @serfab/cadre-core test` in the foreground, then `yarn lint`; the scenario file if it fits.
