description: Each machine records, in the cadre's shared control record, the network identity it uses in each private workspace. With that, a machine binds its sibling machines to the party's current workspace membership key as well as itself, so a sibling that was offline when the key changed is already bound when it returns, and a machine wrongly bound under a key gets its binding cleared.
prereq: control-schema-strand-peer-and-pending-party-key
architecture: docs/strands.md#closed-strand-member-key-handling
files: packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime` ~768, the reconciler construction ~1015, `clearOwnMemberPeerBinding` ~1577, `notifyMembershipInviteStaged`), packages/cadre-core/src/strand-membership-reconciler.ts (`StrandMembershipReconcilerDeps`, `attempt` ~590, `ensureBinding` ~754, `rearm`), packages/cadre-core/src/strand-revocation-enforcer.ts (`trackSelfRevoked` ~579, `onSelfRevoked`), packages/cadre-core/src/cadre-node.ts (`controlWriteCouldFork` ~9602, `runDrainControlReplication` ~4918, `readMachines` ~9838, the reconciler deps wiring ~11142), packages/cadre-core/src/strand-membership-writer.ts (`registerMemberPeer`, `removeMemberPeer`, `listMemberPeers`), packages/cadre-core/src/control-database.ts (`insertStrandPeer`, `queryStrandPeers`, `queryPendingStrandPartyKey`), docs/strands.md (Closed-Strand Member Key Handling; Removing Members, the device-record bullet), docs/architecture.md (MemberPeer registration + manager rotation)
difficulty: hard
----
# Every machine publishes its strand peer id, and binds its siblings

Second ticket of the key-rotation chain (see `control-schema-strand-peer-and-pending-party-key` for the chain and the reason the tables exist). This one makes the running node write `StrandPeer` rows and extends the per-strand membership reconciler so the party's bindings in a closed strand no longer depend on each machine writing its own.

## The row write

At every closed-strand launch and resume, once the strand's libp2p node exists (`buildStrandRuntime`, after `createLibp2pNode`), the node writes its `StrandPeer` row for that strand: `(strandId, own control peer id, strand node peer id)`, through `ControlDatabase.insertStrandPeer`. Rules:

- **A background control write.** Not awaited by the launch and never fails it. Skipped while `controlWriteCouldFork` (the node is alone with other party members), and re-attempted by the control-sibling growth drain (`runDrainControlReplication`, beside the self-record re-touch) and by each reconciler pass below (insert-if-absent, so repeats cost one read). A refusal because the machine's own `CadrePeer` row is absent on this node is logged and retried the same way.
- **Regardless of party key.** A storage replica launched without a `partyMemberPrivateKey` still has a strand peer id and still gets bound by its siblings. Open strands write nothing: no `Member` table, nothing to bind.
- **Signer.** The node's identity key, as the self record. No owner needed, so every machine kind writes its own row.

## The reconciler's new work

`StrandMembershipReconcilerDeps` gains `getPartyPeers(): Promise<{ live: string[]; removed: string[] }>`: the strand peer ids of this party's machines for this strand, from `queryStrandPeers` joined to the membership views. `live` is the rows whose control peer id is a live machine under the membership predicate (`readMachines`'s `trusted` test, this node excluded, read **fresh** rather than from the cached membership view, as the NOTE at `planMachineRemoval` describes, because the lag of that view is exactly the window the rotation races against). `removed` is the rows whose control peer id has a `CadrePeer` tombstone and no live row. A row that is neither (an unknown peer id) is ignored.

`attempt` runs, after the existing membership and own-binding steps and under the same once-per-pass, own-transaction, never-throw contract:

1. **Bind live siblings.** For each `live` id with no `MemberPeer` row under the current party key, `registerMemberPeer(currentKey, id)`. The binding is signed by the party key, which every machine of the party holds, so this is the party vouching for its own machine. A pass that binds a sibling is not "done" until a later pass finds nothing left to bind; the done state adds "every live sibling is bound".
2. **Clear removed machines, when no rotation is pending.** For each `removed` id with a `MemberPeer` row under the current party key, `removeMemberPeer` through the self branch (signed by the current key). Only while `queryPendingStrandPartyKey(strandId)` is null: while a rotation is pending, the removed machine's binding under the current (old) key is the orphan the rotation is about to create, and clearing it would hand the removed machine a clean slate the deny-list gate admits. After the swap, this step clears a binding under the new key that a sibling lagging on the removal's tombstone wrote for the removed machine in step 1. Clearing the stamp retires it; the orphaned binding under the old key stays.
3. **Re-attempt the own `StrandPeer` row** if it is still absent (the background write above).

Step 1 reads bindings with `listMemberPeers(db, currentKey)` once per pass and compares in JavaScript (the scan-not-seek idiom). The reconciler is woken for these steps by what wakes it today (its ladder, a staged invitation) plus a new seam: `StrandInstanceManager.notifyPartyPeersChanged(strandId)`, which `CadreNode` calls when `CadreControl.StrandPeer`, `CadrePeer` or `Revocation` change (one `watchTables` subscription, coalesced), so a sibling's row arriving binds it within the coalescing window rather than at the next backstop.

## Re-arming on un-revocation

A machine whose only binding is orphaned (its sibling rotated the key before this machine's `StrandPeer` row reached it) is denied by every other machine, so its own reconciler cannot write; its enforcer flags it self-revoked, and the loop stops ("stop rather than fight"). The heal comes from a sibling binding it (step 1 on the sibling), after which its own enforcer's next refresh drops its peer id from the deny set. That transition must restart the loop: `StrandRevocationEnforcer` gains `onSelfRestored` beside `onSelfRevoked` (fires on the set-membership edge in `trackSelfRevoked`), and `StrandInstanceManager` wires it to `reconciler.rearm()`. `rearm` after a self-revoked stop is a re-armable stop today, so no change to the stop classes.

## Edge cases & interactions

- **Lagging membership view binds a removed machine under the new key.** Step 1 on a sibling that has the new key but not yet the removal's tombstone. Narrowed by the fresh read; closed by step 2 once the tombstone arrives, since the pending row is gone by then (the swap deletes it in the same transaction). Verified by the reconciler test below.
- **Step 2 must never run while a rotation is pending.** The pending row is the gate. A rotation parked indefinitely (`needs-another-party`, later ticket) keeps the removed machine's binding as it is today: served, like before this work. By inspection, and pinned by the reconciler test.
- **A replica without a party key** writes its `StrandPeer` row but runs no reconciler; its siblings bind it. A party whose every strand machine lacks the key (none is an owner machine running the strand) binds nobody, as today.
- **Self-revoked false alarm.** A sibling not yet bound under the new key after the old key left raises `strand:revoked` once. The next ticket's driver binds every known sibling before the old key leaves, so this is reached only by a `StrandPeer` row that had not replicated to the driver. The app's "you were removed" screen can show briefly; the heal and `onSelfRestored` recover the loop; the docs say the signal is best-effort already. Name it in `docs/strands.md`'s "What the app has to call" bullet.
- **Two machines binding the same sibling at once** collide on the `MemberPeer` primary key; the loser's write is refused and its next pass finds the row. By inspection of `registerMemberPeer`'s insert-if-absent guard plus the duplicate-key path.
- **Offline-mode strands.** Every write here passes `joinOpenTransaction: false` and treats `StrandOfflineQueueBusyError` as busy, as the existing steps do. No new behaviour.
- **Hibernating instance.** Nothing runs; resume rebuilds the reconciler and re-runs every step. By inspection.
- **Cost.** One `queryStrandPeers` read and one `listMemberPeers` scan per pass, per closed strand. `NOTE:` at the pass: fine at party scale; if a party ever runs many strands on many machines, read `StrandPeer` once per control change rather than per pass.

## Tests

In `strand-membership-reconciler.spec.ts` (the real engine, stub deps), two tests:

- A pass binds each `live` sibling peer id under the party key, leaves a `removed` id's binding in place while a pending key is reported, and clears it on the next pass once none is. Expected: `MemberPeer` rows for self and both live siblings; the removed id's row present then absent; its stamp retired.
- An enforcer-side `onSelfRestored` re-arms a loop that stopped self-revoked and the pass then completes the own binding. Expected: the own `MemberPeer` row appears after the restore signal with no invitation staged.

## TODO

- `StrandInstanceManager.buildStrandRuntime`: the background `StrandPeer` write via a new `CadreNode` seam; the growth drain re-attempt; `notifyPartyPeersChanged`.
- `CadreNode`: the `watchTables` subscription on `StrandPeer`, `CadrePeer`, `Revocation` feeding `notifyPartyPeersChanged`; `getPartyPeers` built on `queryStrandPeers` and a fresh membership read.
- Reconciler: deps, the two steps, the done-state extension, the per-pass reads.
- Enforcer: `onSelfRestored`; instance manager wiring to `rearm`.
- Writer: `listMemberPeers` already exists; confirm `removeMemberPeer`'s self branch accepts a peer id other than this node's (it should: the signature is the member key's).
- Docs: `docs/strands.md` Closed-Strand Member Key Handling (the row, who binds whom), Removing Members (the device-record bullet: a party's own machines now also bind and clear each other's records), `docs/architecture.md` MemberPeer registration.
- Tests above; `yarn lint`; `yarn workspace @serfab/cadre-core test`.
