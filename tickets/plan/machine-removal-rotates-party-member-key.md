description: Removing a machine from a cadre does not cut it off from the cadre's shared workspaces, so a stolen phone keeps reading and writing them with every other participant. When a machine is removed, the cadre should replace its membership key in each workspace, so the removed machine is left holding a key that no longer counts.
architecture: docs/architecture.md#removing-a-machine
files: packages/cadre-core/src/cadre-node.ts (`removeMachine`, `publishStrand`'s `StrandPartyKey` mint), packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/cadre-core/src/control-database.ts, schemas/control.qsql (`StrandPartyKey`), schemas/strand.qsql (`Member`, `MemberPeer`), docs/architecture.md (Removing a machine), docs/strands.md (Removing Members, What removal does to the network), docs/reference-app-rn.md (What removal does not do), packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts
difficulty: hard
----
# Removing a machine rotates the party's member key in each strand

**Decided by the maintainer on 2026-11-03: rotate.** This was option A of `decide-removed-machine-strand-access`. Two rejected options stay rejected: a party-signed "this machine is no longer ours" record in the strand, which stops only a machine that cooperates because it can bind itself again with the key it holds; and documenting the gap only, which leaves the stolen-phone case with no path.

## The gap

`CadreNode.removeMachine` is a control-database act. A strand is a separate network with its own membership, and removal touches none of it:

- **The machine keeps the keys.** Every machine of a party holds the party's member identity for each closed strand (`StrandPartyKey`, replicated in the control database) and the strand's read secret (`MemberPrivateKey`).
- **The strand gate does not refuse it.** The closed-strand gate (`strand-revocation-enforcer.ts`) denies machines whose `Strand.MemberPeer` binding points at a party that is no longer a `Strand.Member`. The removed machine is bound to its party, which is still a member, so every machine in the strand keeps serving it.
- **It can bind itself again.** It holds the party member key, so clearing its binding would not stop it.

## The behaviour

After `removeMachine` commits, the remover does this for each closed strand the party belongs to:

1. Mints a fresh party member key, a new `StrandPartyKey` row replacing the old one through the guarded delete and tombstone.
2. Seats a `Strand.Member` row for the new key.
3. Lets each remaining machine's membership reconciler bind itself under the new key. It already writes its own `MemberPeer` binding on a short retry ladder.
4. Removes the old `Member` row.

The existing gate then denies every machine still bound to the old key, the removed one included, with no new gate logic. The removed machine never receives the new key, because the control database no longer syncs to it.

Seating the new `Member` row needs a strand manager's signature. Where the party is a manager (strands it founded, by default), the remover signs. Where it is not, another party's manager has to admit the new key, a cross-party request with no flow today.

## Limits this does not remove

- **The read secret is not rotated.** Blocks the removed machine holds stay readable to it, and so does anything it can fetch from a machine that has not yet processed the removal. Rotating the read secret is re-forming the strand (`docs/strands.md` → "Revocation is forward-looking only") and is out of scope.
- **Owner keys stay separate.** A lost phone that held an owner key can still sign until that key is removed (`removeOwner`), so it could undo this work. The app's flow has to keep saying so.
- **Open strands** have no member list to rotate.

## What the plan has to settle

Split this into `prereq:`-chained tickets. Rotation in the strands the party manages comes first, and the cross-party request after it. Until the second lands, those strands keep the gap and the app says which ones. Settle at least:

- **Partial failure.** The new key is seated and the old one not yet removed, or the remover stops mid-way. What finishes the rotation, and which machine does it after a restart, or another owner machine?
- **Ordering.** Removing the old `Member` row before every remaining machine has bound under the new key denies the party's own machines. What says they have bound, given machines that are offline for days? A machine that was offline through the rotation must come back under the new key without an owner present.
- **Strands not running.** The remover may have a strand hibernating, or may hold only a joined strand's records. Is the rotation run per strand when it next wakes, and what is the user told in the meantime?
- **Removal made alone.** The remover has no control connection, or a `removeMachine` is refused or deferred. Compare `controlWriteCouldFork` and the rules in `docs/architecture.md` → Writes made while alone.
- **Concurrent removals and rotations.** Two owners removing two machines at once must not leave two live new keys for one party. Rows that hold the old key (`Strand.Member`, `Strand.Manager`) include a party's manager identity, which has to move with it.
- **Schema.** Whether `StrandPartyKey` and `Strand.Member` allow this unchanged. A control-schema change follows `docs/architecture.md` → Control schema versions and migrations.
- **What an app is told.** `MachineRemovalPlan` and `MachineRemovalResult` should report per strand: rotated, pending, or not possible without another party. The reference-app wording then changes from "stops it syncing with this cadre's machines".

## Acceptance

A real-network scenario, alongside `strand-removal-cuts-network.integration.ts`: a party of three machines on a closed strand with another party, one machine removed. The removed machine is denied by the other machines and cannot read new writes or push its own, while the two remaining machines and the other party keep working, and a remaining machine that was offline during the removal rejoins by itself.
