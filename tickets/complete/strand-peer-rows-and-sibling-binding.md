description: Each machine records, in the cadre's shared control record, the network identity it uses in each private workspace. With that, a machine binds its sibling machines to the party's current workspace membership key as well as itself, so a sibling that was offline when the key changed is already bound when it returns, and a machine wrongly bound under a key gets its binding cleared.
prereq: control-schema-strand-peer-and-pending-party-key
architecture: docs/strands.md#closed-strand-member-key-handling
files: packages/cadre-core/src/strand-party-peers.ts (new: `PartyStrandPeers`, `PartyStrandPeerSource`, `partitionPartyStrandPeers`), packages/cadre-core/src/strand-membership-reconciler.ts (`partyPeers` dep, `reconcileSiblings`, `bindSiblings`, `clearRemovedMachines`, `publishOwnStrandPeer`, `latchDone`, `rearm(cause)`), packages/cadre-core/src/strand-revocation-enforcer.ts (`onSelfRestored`, `trackSelfRevoked`), packages/cadre-core/src/strand-instance-manager.ts (`StartStrandConfig.partyPeers`, the publish after `createLibp2pNode`, `notifyPartyPeersChanged`, `rearmMembershipReconciler`), packages/cadre-core/src/cadre-node.ts (`publishStrandPeer`, `publishDeferredStrandPeers`, `readPartyStrandPeers`, `partyStrandPeerSource`, `describeMachineRows`, the `strand-party-peers` watch in `start()`), packages/cadre-core/src/control-database.ts (`queryMachineRowsFresh`, `liveCadrePeerRows`), packages/cadre-core/src/ed25519-key.ts (`ed25519MessageSigner`), packages/cadre-core/src/owner-signer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-revocation-enforcer.spec.ts, packages/cadre-core/test/strand-party-peers.spec.ts (new), docs/strands.md (Binding the party's machines), docs/architecture.md
difficulty: hard
----
# Every machine publishes its strand peer id, and binds its siblings

Second ticket of the key-rotation chain (`control-schema-strand-peer-and-pending-party-key` → this → `machine-removal-rotates-party-member-key` → `scenario-machine-removal-rotates-party-key`). Implemented in `ticket(implement): strand-peer-rows-and-sibling-binding`; reviewed here.

## What was built

- **The row write.** `CadreNode.publishStrandPeer` writes this machine's `StrandPeer` row through `ControlDatabase.insertStrandPeer`, signed by the identity key (`ed25519MessageSigner`, shared with `softwareOwnerSigner`). Called in the background by `StrandInstanceManager.buildStrandRuntime` right after the strand's libp2p node exists, closed strands only, launch and resume alike, party key or not. Skipped while a write could fork the party; a deferral or a refusal lands in `deferredStrandPeerWrites`, re-attempted by the growth drain, by the party-machine watch (added in review, below) and by every reconciler pass. A row found present is remembered per session. An ephemeral identity writes nothing.
- **The reconciler's new steps.** `StrandMembershipReconcilerDeps.partyPeers` is one strand-scoped seam (`PartyStrandPeerSource`: `publishOwn`, `read`, `isRotationPending`). After the own binding: bind every live sibling id with no binding under the current key; clear every removed id that has one, through the self branch of `removeMemberPeer`, only when no rotation is pending (a failed pending read clears nothing); re-attempt the own row. A pass that wrote is not done; done needs every known sibling bound. A `read()` that rejects keeps the loop live on the flat poll interval; a write that fails is retried on the ladder, each sibling's write contained on its own.
- **Who is live, who is removed.** `CadreNode.readPartyStrandPeers` reads the strand's `StrandPeer` rows plus `ControlDatabase.queryMachineRowsFresh()` (the `CadrePeer` rows and every tombstone through storage, not the membership views) and projects them with the pure `partitionPartyStrandPeers`: live = a `CadrePeer` row that passes the membership predicate (false for self); removed = a `CadrePeer` tombstone naming the peer id and no live row; `removed` never contains an id in `live`.
- **Wakes.** One `watchTables` subscription in `CadreNode.start()` on `StrandPeer`, `CadrePeer`, `Revocation` re-arms every armed reconciler (`StrandInstanceManager.notifyPartyPeersChanged`); `rearm` takes a `cause` for the log. `StrandRevocationEnforcer.onSelfRestored` fires on the exit edge of `trackSelfRevoked` and the instance manager wires it to `rearm`.
- **Docs.** `docs/strands.md` → "Binding the party's machines" under Closed-Strand Member Key Handling, the device-record bullet under Removing Members, the false-alarm sentence on the `strand:revoked` bullet. `docs/architecture.md`: the `StrandPeer` schema row, the `registerMemberPeer` bullet, the new consumer under Table change subscriptions.

## Validation

- Against a current sibling build (19:03 to 19:06 on the day of review): the six targeted cadre-core files (`strand-membership-reconciler`, `strand-revocation-enforcer`, `strand-party-peers`, `strand-instance-manager-membership`, `strand-instance-manager-revocation`, `control-database-strand-peer`), 124 tests, passed; the full `yarn workspace @serfab/cadre-core test`, 191 files, 2581 tests passed, 1 skipped. That run covers `control-store-migration.spec.ts` and `control-schema-versions.spec.ts`, owed from the previous ticket's review. `yarn lint` exit 0.
- After the review's edits: `yarn workspace @serfab/cadre-core typecheck` exit 0, `yarn lint` exit 0. **The test re-run after the edits, and the three integration scenarios owed from the previous review (`control-schema-migration-mixed-releases`, `control-db-two-node-convergence`, `control-delete-while-alone-convergence`), were refused by the stale-build guard:** `@quereus/quereus` committed an edit to `packages/quereus/src/vtab/module.ts` at 19:10 with no rebuild (its board is empty, so no agent there is about to build). Per `tickets/rules/sibling-repos.md` nothing was built. The edits the re-run would cover are small and typechecked (the signer hands bytes to the plugin instead of base64url text, which the plugin's `toBytes` passes through unchanged; the watch callback calls an existing method before the existing one). Re-run once the sibling's `dist` is current:

  ```
  yarn workspace @serfab/cadre-core test
  yarn workspace @serfab/integration-tests exec vitest run control-schema-migration-mixed-releases control-db-two-node-convergence control-delete-while-alone-convergence
  ```

- The real-network proof of this ticket's wiring is `scenario-machine-removal-rotates-party-key`.

## Review findings

Read the implement diff in full before the handoff, then every file it touched and the writers it calls (`registerMemberPeer`, `removeMemberPeer`, `listMemberPeers`, `insertStrandPeer`, `queryStrandPeers`, `queryPendingStrandPartyKey`, `MembershipView.readThrough`, `table-change-watch.ts`'s run model), and the next ticket in the chain for the ordering the pending gate relies on.

**Checked and found right:**

- The pass order and the done state: a pass that wrote or could not read is never done; a failed `read()` lands on the flat poll interval through the same `lastPassIdle` flag the admitted-wait uses, and the ladder reset there is correct. The existing `noteAttemptOutcome` counters are unaffected (they key on the staged invitation).
- `removeMemberPeer`'s self branch signs over the row's own `MemberKey`, so it clears any peer id bound under the party key; the reconciler test runs it against `removed-machine`.
- `partitionPartyStrandPeers`: a re-added machine (tombstone plus live row under a fresh stamp) is live; a removed machine's row naming a live id cannot clear it; self is excluded by the membership predicate in `describeMachineRows`, which is `peerId !== selfPeerId && hasAnchoredProof`.
- `queryMachineRowsFresh` reads `CadrePeer` and `Revocation` through storage; the chain tables stay on the views, and a chain row missing makes a machine untrusted, which the projection ignores. Right for a reader that must not bind a machine whose removal reached storage with no change event.
- The pending gate's wake: the swap deletes the pending row with a tombstone, which is a `Revocation` change the watch hears, so "settled while pending" cannot strand a removed machine's binding.
- The watch's `onChange` runs from a timer after the commit, never inside it, so a control write from the callback is safe (the fix below relies on it).
- `trackSelfRevoked`'s edge: a first clean refresh fires nothing; one entry and one exit each fire once.
- Two machines binding or clearing one id at once: the loser's write is refused or throws "still present", is logged, and the next pass finds the row as the winner left it.
- Teardown: the watch is disposed before the control database closes; a pass in flight during `stop()` has its reads reject (`requireControlDatabase`) and its reconciler stopped by `releaseRuntime`, so nothing reschedules.
- `owner-signer.ts` still imports only what it did (through `ed25519-key.ts`), so the React Native loading claim holds.

**Minor, fixed in this pass:**

- A replica with no party key runs no reconciler, so a `StrandPeer` row refused at launch because its own `CadrePeer` row had not replicated yet was retried only on cohort growth, which may never come again in the session; the replica then stays unbound by its siblings after a rotation and is denied until restart. The party-machine watch now re-attempts the deferred rows before re-arming the loops (the arrival that fires it may be the row the insert needs), in `CadreNode.start()`; the field and method comments and `docs/strands.md` say so.
- `ed25519MessageSigner` encoded the message as base64url text and its comment justified that by Ed25519's determinism; the plugin's `toBytes` returns a `Uint8Array` unchanged, so the signer now passes the bytes straight through and the comment states that. `owner-signer.ts` gets the same path.
- The module doc of `strand-membership-reconciler.ts` now states the constraint the pending gate rests on: the removal writes the machine's tombstone and the pending row in one transaction. A tombstone that arrives without its pending row reads as "no rotation" and clears the binding the rotation meant to orphan, leaving the removed machine admitted as a stranger. That is the next ticket's contract to keep (its text already says "in the same owner approval").
- `strand-party-peers.spec.ts`'s `machine()` helper computed `isSelf` from `trusted`; now `peerId === 'self'`.
- The watch comment claimed `StrandPeer` is touched by every launch's publish; a publish deferred while alone touches nothing, and the growth drain's re-attempt does. Reworded.

**Major:** none. The one design-level concern (the gate's dependence on the tombstone and pending row committing together) is a constraint on the next ticket, already written into its text, so a doc sentence at the site is the right record, not a ticket.

**Tests:** none cut. The reconciler test drives the real engine over steps 4 and 5 with the pending gate flipped; the enforcer test pins the exit edge; the projection test pins seven row shapes with real branching. None restates the implementation or verifies a mock. None added: the defect fixed is `CadreNode` wiring with no unit seam below the node, the same depth the handoff declined to test; the scenario ticket proves the wiring on a real network. A reviewer of that scenario may want a replica arm (a machine without the party key, bound by a sibling), which this ticket does not add.

**Tripwires (recorded at the site, indexed here):**

- `attempt` in `strand-membership-reconciler.ts`: per-pass `StrandPeer`, fresh membership and `MemberPeer` reads, and every closed strand's loop woken per heartbeat of any party machine; read `StrandPeer` once per control change if a party ever runs many strands on many machines.
- The `strand-party-peers` watch in `CadreNode.start()`: same cost, same remedy; plus the untouched-table caveat of `table-change-watch.ts`.
- `readStrandPeerRows` in `control-database.ts` (from the previous ticket): walks every strand's rows per call.

**Considered and left alone:**

- The deferred-write map outlives `stopStrand`: a stopped strand's row is still written on growth. The row states a stable id and is true whether or not the strand runs here. A strand deleted from the party while its row is deferred would have its insert refused on each growth and logged; the queue entry is per session and nothing else is harmed.
- A self-revoked stop re-armed by every heartbeat re-stops at once: one `isSelfRevoked` call and two debug lines per heartbeat.
- A `read()` that fails on a party founded before schema v4 whose `StrandPeer` collection nobody has written keeps one failing control read per closed strand per poll interval while the other machines are offline; the alternative (latch done) would leave siblings unbound until the next control change. Owned by `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`.
