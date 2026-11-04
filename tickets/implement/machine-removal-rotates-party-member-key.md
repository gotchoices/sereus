description: Removing a machine from a cadre does not cut it off from the cadre's shared workspaces, so a stolen phone keeps reading and writing them with every other participant. When a machine is removed, the cadre now replaces its membership key in each workspace it manages, so the removed machine is left holding a key that no longer counts, and the app is told per workspace whether that happened.
prereq: strand-peer-rows-and-sibling-binding
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/strand-party-key-rotation.ts (new), packages/cadre-core/src/cadre-node.ts (`removeMachine` ~9809, `planMachineRemoval` ~9763, `controlWriteCouldFork` ~9602, `runDrainControlReplication` ~4918, `resolveStrandPartyKey` ~7034, `ensureStrandPartyKey` ~6978, the strand watcher queryable ~3210, event wiring ~1822 in types.ts), packages/cadre-core/src/machine-removal.ts, packages/cadre-core/src/control-database.ts (`removeMachine` ~2725, `revouchOwnerKey` ~2673 as the one-transaction swap idiom, `deleteStrandAndPartyKey` ~2941), packages/cadre-core/src/seed-bootstrap.ts (`removeMachine`), packages/cadre-core/src/strand-instance-manager.ts (`resumeStrand` ~1732, `foundExistingStrand` ~1808 as the launch-config rewrite idiom, `clearOwnMemberPeerBinding`), packages/cadre-core/src/strand-membership-writer.ts (`addMemberByManager`, `addManager`, `removeManager`, `leaveStrand`, `revokeMember`, `registerMemberPeer`), packages/cadre-core/src/types.ts (`MachineRemovalPlan`, `MachineRemovalResult`, the event map), packages/cadre-core/test/cadre-node-remove-machine.spec.ts, docs/architecture.md (Removing a machine; Deletes made while alone), docs/strands.md (Removing Members: Revocation is forward-looking only; What removal still does not do; Closed-Strand Member Key Handling)
difficulty: hard
----
# Removing a machine rotates the party's member key in each strand it manages

**Decided by the maintainer on 2026-11-03: rotate.** Third ticket of the chain (`control-schema-strand-peer-and-pending-party-key` → `strand-peer-rows-and-sibling-binding` → this → `scenario-machine-removal-rotates-party-key`). This ticket covers the strands where the party holds a manager seat (its own strands by default). Strands it does not manage are left pending and reported; the cross-party flow is `plan/party-key-rotation-across-parties`.

## The gap, restated

`removeMachine` is a control-database act. A strand is a separate network with its own membership. The removed machine keeps the party's member identity (`StrandPartyKey`, replicated) and the read secret, its `Strand.MemberPeer` binding points at a party that is still a `Strand.Member`, so the closed-strand gate (`strand-revocation-enforcer.ts`) keeps serving it, and it could re-bind itself with the key it holds.

## The behaviour

After the removal, for each closed strand the party belongs to, the party moves to a fresh member key K'. Every remaining machine ends up bound under K'; the old key K resigns and leaves the strand; the removed machine's binding under K becomes an orphan, and the existing gate denies it with no new gate logic. The removed machine never receives K', because the control database no longer syncs to it.

Settled facts the design rests on (from the research; keep them in the module doc):

- A `MemberPeer` binding is signed by the member key, which every machine of the party holds, so any party machine can bind any peer id under the party key. `StrandPeer` rows (previous tickets) say which peer ids are the party's remaining machines and which the removed machine's.
- The gate denies a peer id only when it has an orphaned binding and no live one. A remaining machine bound under both K and K' stays served when K leaves.
- `leaveStrand` is self-signed by the departing key, and `removeManager`'s resign branch needs another manager standing. So K can remove itself once K' is a manager, and no second party is involved in a strand the party manages.
- The founder bootstrap is safe after a rotation: it skips `Member` and `Manager` when either table has rows, so a founder restart never tries to re-seat K' as a founding row.

## Where the new key lives before it is current

The removal transaction writes a `PendingStrandPartyKey` row per closed strand (own `Strand` rows of type `'c'` and `JoinedStrand` rows of type `'c'`, each with a fresh `generateStrandMemberKey()`), in the same owner approval. The removal and the intent to rotate are then exactly as durable as each other. A strand that already has a pending row gets it replaced in that transaction (delete plus tombstone, insert fresh) with `Superseded` carrying the replaced key's public half appended to its own list, because the replaced key may already have reached the machine just removed. `ControlDatabase.removeMachine` takes the list; `SeedBootstrapService.removeMachine` passes it through; `CadreNode.removeMachine` builds it from `planMachineRemoval`. A removal that finds `machine: null` writes nothing (the remover elsewhere wrote the rows).

## The rotation driver

New module `strand-party-key-rotation.ts`, owned by `CadreNode`, one single-flight run per strand. It runs on an **owner machine that runs the strand** (an owner signer is enrolled, the strand instance is live with a database). Non-owner machines never drive; they only bind siblings through the reconciler. Triggers: `removeMachine` itself (awaited, so the result can say `rotated`), a closed strand launching or resuming here, a change to `PendingStrandPartyKey` or `StrandPartyKey` (one `watchTables` subscription), and control-sibling growth (for a swap deferred while alone). `removeMachine` also resumes hibernating closed instances it tracks before driving, so a phone that backgrounded its strands rotates them in the same call.

Each run reads the pending row and the strand's rows, then continues from wherever the state says it is. Every step reads before it writes, and a duplicate-key rejection on an insert counts as done, so two owner machines driving the same strand converge:

1. **Clean up superseded keys.** For each public key in `Superseded` that holds a `Member` row: `removeManager` by K if it holds a `Manager` row, then `revokeMember` by K. Its bindings become orphans beside K's, which is harmless to remaining machines (they stay bound under K, then K').
2. **Seat K'.** `addMemberByManager(K, K')`. If K holds no `Manager` row, stop here: emit `strand:party-key-rotation-blocked { strandId, reason: 'needs-another-party' }` once per pending stamp, leave the row, and report `needs-another-party`.
3. **Bind under K'**: this machine's own strand peer id and every live sibling's from `StrandPeer` (the same fresh membership read the reconciler uses). `registerMemberPeer(K', id)` each.
4. **Promote K'**: `addManager(byK, K')`. After the bindings, so a key that was seated but never bound cannot exist beyond step 2.
5. **K steps down**: `removeManager` resign branch signed by K (K' now stands), then `leaveStrand` signed by K. The removed machine's binding under K is now the orphan; remaining machines are live under K'.
6. **Swap the control row**, one transaction and one owner approval across every strand whose steps 1 to 5 are complete in this run: delete `StrandPartyKey` K with its tombstone, insert `StrandPartyKey` K', delete the pending row with its tombstone (new `ControlDatabase.swapStrandPartyKeys(entries, ownerKey, sign)` on the `revouchOwnerKey` and `deleteStrandAndPartyKey` idioms). Deferred while `controlWriteCouldFork`, re-run on growth, like every background control write. After the commit: `strandManager.rekeyParty(strandId, K')` and `strand:party-key-rotated { strandId }`.

Crash recovery is the same run: pending row present and K' not a member → step 2; K' member but K still a member → steps 3 to 5 as needed; K gone from the strand, control still K → step 6; no pending row → nothing. A run that finds K' already current (another driver swapped) ends.

## Re-keying a running instance

`StrandInstanceManager.rekeyParty(strandId, key)`: replace the retained launch config with a fresh object (the `foundExistingStrand` idiom), stop and `settle` the old reconciler, build and start a new one, kick a pass; no-op when the key is unchanged; a hibernating instance only updates the retained config. `CadreNode` calls it on the driver's swap and, on every machine, when a `StrandPartyKey` change leaves a tracked closed instance's config key behind the stored one. `resumeStrand` must re-resolve the key from the control row rather than trust the retained config, since the swap can happen while an instance hibernates. The enforcer needs no re-key: its deny set is derived from the rows.

## What an app is told

- `MachineRemovalPlan.strands: StrandKeyRotationPlan[]`, one per closed strand: `{ strandId, rotation: 'here' | 'later' | 'another-party' }`. `here`: the strand runs here and K holds a `Manager` row. `another-party`: runs here, no manager seat. `later`: not running or not readable here (hibernating counts as `here` if it can be resumed; a strand this machine's filter excludes is `later`).
- `MachineRemovalResult.strands: StrandKeyRotationOutcome[]`: `{ strandId, outcome: 'rotated' | 'pending' | 'needs-another-party' }`. `pending` covers a strand not driven here and a swap deferred while alone.
- Events `strand:party-key-rotated` and `strand:party-key-rotation-blocked` as above. The reference apps' wording changes with the scenario ticket.

## Edge cases & interactions

- **Partial failure anywhere in steps 1 to 6**: the next run continues from the state; the pending row is the durable intent; K is held until step 6. Verified by the driver test's resume-from-each-state case.
- **Remover crashes between steps 5 and 6**: control still names K, which has left the strand. Every machine's reconciler under K finds no member row and waits; the next driver run swaps. Covered by the same test.
- **Ordering against offline siblings**: step 3 binds every sibling with a `StrandPeer` row before K leaves, so a sibling offline through the rotation returns already bound. A sibling whose row had not replicated to the driver returns orphaned and is healed by the previous ticket's sibling binding. The scenario ticket proves the first; the second is by inspection.
- **Strand not running on the remover**: `later` and `pending`; the pending row waits for any owner machine running the strand; the app says which strands. The removal is not held up.
- **Removal made alone** (`controlWriteCouldFork`): the removal and its pending rows commit alone as today; the swap waits for a sibling. The tombstones re-issue on growth; the pending rows have no re-issue path (the `NOTE:` at the table): if that remover is lost before finishing, the rotation is lost with it. Documented limit.
- **Two owners removing two machines at once**, connected: the second removal's pending insert collides on the primary key, the whole transaction fails as today's same-machine collision does, and a retry re-plans and replaces the pending key. Partitioned: both commit locally and the pending collection forks (`tickets/blocked/forked-control-collection-sync-livelocks.md`); the drivers' idempotent steps still converge on whichever row each side holds, and step 1 cleans the other side's key up once the control rows merge. Documented, not guarded.
- **Second removal while a rotation is pending**: the pending key is replaced with `Superseded`; step 1 revokes the seat the old pending key may already hold. Verified by the driver test.
- **A stale pending row on the removing node.** The table has no reap branch, so a node can hold a physical pending row whose stamp is already retired (the tombstone arrived, the delete did not). `queryPendingStrandPartyKey` reads that as absent, so the plan sees no rotation pending; the fresh insert then collides on the primary key, and replacing the row through `queryPendingStrandPartyKeyStampId` collides on `Revocation`'s key because the tombstone exists. Either fails the whole removal on that node. Found by reading `control-schema-strand-peer-and-pending-party-key`'s writers, not run. Decide how the replace path treats this before relying on it.
- **A strand leaves the party while its rotation is pending.** `deleteStrandAndPartyKey` removes the `Strand` and `StrandPartyKey` rows, and nothing removes the pending row (`deleteJoinedStrand` and a strand move likewise). The row then holds a private key for a strand the party no longer has, it cannot be reaped, and the driver finds no strand to run it on. Found by reading `control-schema-strand-peer-and-pending-party-key`'s writers, not run. Remove the pending row with its tombstone in the same transaction, as `deleteStrandAndPartyKey` does the `StrandPartyKey` row, and decide what a strand move does with a pending rotation.
- **The removed machine receives K' from a sibling lagging on its tombstone.** The existing fail-open window ("a machine that has not yet processed the removal"); the swap happens strictly after the removal commit, which narrows it. Document under Removing a machine.
- **Strand with no `StrandPartyKey` row** (a joined closed strand whose identity never seated): skip with a log; nothing to rotate.
- **Pre-split strands** (`PreSplitStrandIdentityError`): the driver never runs there, since the founder bootstrap refuses the launch.
- **Open strands**: no pending row, no plan entry.
- **Owner keys** stay separate; a removed phone's owner key still signs until `removeOwner`. The docs keep saying so.
- **The removed machine with a modified client** can present a fresh strand peer id with no binding and is admitted by the deny-list gate as a stranger; rotation kills its recorded identity, not an unrecorded one. The evidence arm is on `backlog/feat-strand-member-allowlist-admission`; state it under "Revocation is forward-looking only".
- **Read secret not rotated**: past blocks stay readable to the removed machine; rotating it is re-forming the strand. Unchanged.

## Tests

- `cadre-node-remove-machine.spec.ts` (one database): a removal with one closed strand not running here writes a pending row with a fresh key and reports `pending`; a second removal while it is pending replaces the row with `Superseded` naming the first key's public half. One test, two assertions along the way.
- `strand-party-key-rotation.spec.ts` (a real strand engine as `strand-membership-reconciler.spec.ts` uses, a stub control seam): from a founded closed strand with bindings for self, two siblings and the removed machine under K, a full run ends with K' as member and manager, bindings for self and both siblings under K', K absent, the removed machine's binding under K orphaned, and the swap called once. The same test parametrised over "crash after step N" states (re-run from each) must reach the same end state. One behaviour, one parametrised test.

## TODO

- `ControlDatabase.removeMachine`: the pending rows in the transaction; `swapStrandPartyKeys`; `SeedBootstrapService.removeMachine` pass-through.
- `machine-removal.ts`: the plan's per-strand projection from the strand rows, the running instances and their `Manager` rows.
- `strand-party-key-rotation.ts`: the driver, its triggers, single-flight per strand, the two events.
- `StrandInstanceManager.rekeyParty`; `resumeStrand` re-resolving the key; `CadreNode` wiring on `StrandPartyKey` changes.
- `CadreNode.removeMachine`: resume tracked closed strands, drive, report; `planMachineRemoval`: the plan entries.
- `types.ts`: the plan and result fields, the events; `index.ts` exports.
- Docs: `docs/architecture.md` Removing a machine (replace "What removal does not do" with the rotation, its limits and the per-strand report; a Proof line for the specs), Deletes made while alone (the swap and the pending row); `docs/strands.md` the three sections named in `files:`; the `removeMachine` doc comment.
- Tests above; `yarn lint`; `yarn workspace @serfab/cadre-core test`.
