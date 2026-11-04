description: When a user removes a dead machine from their cadre, a phone's offline queue should stop waiting for it and send its saved changes. Today a machine the phone has already met stays on an internal list of expected members after removal, so the queue would keep waiting.
architecture: docs/strands.md#offline-mode
prereq: offline-queue-waits-for-party-machines-that-hold-the-strand
files: packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime`, `createLibp2pNode` options ~896), packages/cadre-core/src/strand-party-machines.ts, packages/cadre-core/src/cadre-node.ts (`resumeStrandRuntime` ~6160, launch config ~7475), packages/cadre-core/src/peer-addr-book.ts (`groupAddrsByPeerId`), packages/integration-tests/src/scenarios/strand-offline-waits-for-party-machine.integration.ts, docs/strands.md, ../optimystic/packages/db-p2p/src/network-membership-gate.ts (read only), ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (`membershipOf`, `heardFromBootstrapPeer`, read only)
----
# Removing a machine releases the offline queue waiting for it

The prereq's gate releases by itself when a removed machine leaves `StrandPartyMachines`. Optimystic's own gate, which runs first, can still stay closed for two reasons, and Sereus cannot edit either list:

- **`absent-members`.** A machine this strand node once identified is in `rememberedServing`, restored across restarts when `networkState` is configured. `absentCohortMembers` keeps naming it. The accepted-tradeoff `NOTE:` at `membershipOf` says the same and names "a declared member list or an explicit forget-peer operation" as remedies.
- **`awaiting-bootstrap`.** A machine in this strand node's launch seed that never answered stays unheard for the life of the node, since `bootstrapNodes` is frozen. A launch with the machine connected on control and its strand port blocked gets there.

Removal must end the hold in both, or the user is left with no way forward but discarding acknowledged transactions.

## Decisions

**A removed machine's strand peer id is refused through `NodeOptions.isNetworkMember`.** It is Optimystic's existing, synchronous, read-live predicate. On a strand node with a `StrandPartyMachines` tracker, pass `isNetworkMember: (peerId) => !machines.removed().has(peerId)`, with `removed()` the last good read's `PartyStrandPeers.removed` as a `ReadonlySet`. `membershipOf` then answers `foreign` ahead of any remembered verdict, `isSelectable` keeps the peer out of cohorts, and `servingPeersOutside` stops returning it. A peer the predicate admits takes the same path as with no predicate, so every other member is unaffected. Only a literal `true` admits (fail closed), so the expression must return a boolean.

**A removed machine in the runtime's seed triggers one rebuild.** The predicate does not solve this half and makes the identified case worse: `heardFromBootstrapPeer` treats a refused peer that serves the network as unheard, and upstream's accepted-cost `NOTE:` there gives the remedy as "take that peer out of the bootstrap configuration". The seed is frozen in the node, so that means a new node. `resumeStrandRuntime` already re-resolves the seed from connected siblings, which cannot include a removed machine. When a tracker read finds an id in both `removed` and the peers of `config.bootstrapNodes` (`groupAddrsByPeerId`), the manager calls a new `StartStrandConfig.onRemovedMachineInSeed(strandId)`. `CadreNode` runs `quiesceStrand` then `resumeStrandRuntime`, the same pair hibernation runs (`cadre-node.ts` ~6062, ~6106). The app sees what it sees on a wake. A rebuild drops the running database's in-memory followed commits, an existing limit of a rebuild.

Rejected: an upstream "forget this peer" call. It would avoid the rebuild but needs a `blocked/` round for a case removal hits rarely, and it would leave the remembered half to a new API when a predicate already exists. If the rebuild proves disruptive, that is the revisit: leave a `NOTE:` at the callback saying so.

## Edge cases & interactions

- **A machine removed and re-added.** It has a tombstone and a live row under a fresh stamp, so `partitionPartyStrandPeers` keeps it out of `removed` and the predicate admits it on the next read. Existing behaviour of that function; by inspection.
- **Predicate before the first read.** `removed()` is empty, so everyone is admitted for the few milliseconds until the read, and the restored `rememberedServing` is read as before. The gate's `settled()` wait does not cover the predicate, but a queue cannot send past the inner gate's own closed answer either. By inspection.
- **A removed machine states a third party's id.** A machine can state any id in its own row before removal, and `removed` then refuses that id on this party's machines. One id per (strand, machine), and the row was signed by a machine the party trusted then. Effect: that peer is left out of this node's cohorts. An id a live sibling recorded is never read as removed. Leave a `NOTE:` at the predicate. By inspection.
- **Two removals, or a removal during a rebuild.** `resumeStrand` joins a rebuild in flight and returns a live instance unchanged, so run the quiesce and resume serialized per strand and re-check after the resume whether a removed id is still in the new seed. It cannot be, since the seed comes from answers by live siblings and from formation addresses (another party's). A loop guard is not needed, but log if it ever is. By inspection.
- **Runtime hibernating or building.** No tracker is running while hibernating, and the next resume resolves a fresh seed. While a build is in flight, wait for it to settle before rebuilding, as `resumeStrand` handles. By inspection.
- **Party key rotation.** `removeMachine` writes `PendingStrandPartyKey` for closed strands, and rotation writes are refused while the queue holds transactions. The hold releases, the queue drains, then the rotation runs. The order follows from the existing retry; the `machine-removal` scenario must still pass.
- **Queue drains alone.** With the machine gone and nobody else, the transaction commits at `local`, correctly, since this is now a cadre of one.
- **Only nodes offering offline mode.** The predicate and rebuild depend on the tracker, so an always-on node's strand behaves as before. Its `rememberedServing` keeps the removed machine, as it does today.

## Tests

Two arms in `strand-offline-waits-for-party-machine.integration.ts`, each pinning a separate mechanism. In both, the phone holds a `queued` transaction while the node is stopped for good, then calls `removeMachine(node)`, and the status reaches `committed` within a bound:

- **Met, not seeded.** The phone's strand connected to the node after launch. Assert the phone's strand node is the same object afterwards, which pins that no rebuild ran.
- **Met and seeded.** Hibernate and resume the phone's strand while the node is up, so its seed names the node, then stop the node. Assert the strand node was replaced.

Before the fix each arm fails on its bound, so run each against the prereq's build once to confirm.

## Docs

`docs/strands.md`, in "Waiting for the party's own machines", add one bullet: "**Removing the machine releases the wait.** `CadreNode.removeMachine` takes its strand peer id out of the machines waited for, and the strand node refuses that id as a member, so a machine this node once met stops counting too. If the machine is in the running node's launch seed, the strand's runtime is rebuilt once, as on a hibernation wake." Add a sentence to "What the app has to call" in `docs/architecture.md` → Removing a machine only if it would otherwise be wrong.

## TODO

- Add `StrandPartyMachines.removed()`
- Pass `isNetworkMember` on strand nodes with a tracker
- Add `StartStrandConfig.onRemovedMachineInSeed` and the rebuild in `CadreNode`, serialized per strand
- Add both scenario arms and confirm each fails without its mechanism
- Update `docs/strands.md`
- Run `yarn typecheck`, `yarn lint`, the `@serfab/cadre-core` suite, the scenario, `machine-removal` and `strand-offline-queue-survives-restart`
