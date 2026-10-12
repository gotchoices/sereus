description: Decide what removing a machine from a cadre should do to that machine's access to the cadre's shared workspaces (strands), because today a removed phone keeps syncing them: it still holds the cadre's strand keys, and nothing on the strand side refuses it.
files: docs/strands.md (Removing Members, What removal does to the network), docs/architecture.md (Removing a machine, added by cadre-node-removes-a-machine), schemas/strand.qsql, schemas/control.qsql (StrandPartyKey), packages/cadre-core/src/strand-revocation-enforcer.ts, packages/cadre-core/src/strand-membership-reconciler.ts
----

**Blocked: architecture decision.** Unblocked by a maintainer choosing one of the options below (or editing the recommended one). Until then, `cadre-node-removes-a-machine` documents the gap and the reference apps word removal as "stops it syncing with this cadre's machines" only.

## The gap

Removing a machine from a cadre (`CadreNode.removeMachine`, planned in `cadre-node-removes-a-machine`) is a control-plane act: the machine's `CadrePeer` row and owner key go, the cadre's other machines refuse its control streams, and the remover closes its control connections. The cadre's strands are separate networks with their own membership, and removal touches none of it:

- **It keeps the keys.** Every machine of a party holds the party's strand member identity for each closed strand (`StrandPartyKey`, replicated in the control database to every party machine) and the strand's read secret (`MemberPrivateKey`). A removed machine keeps what it already synced.
- **The strand gate does not refuse it.** The closed-strand gate (`strand-revocation-enforcer.ts`) is a deny set: it refuses machines whose `Strand.MemberPeer` binding points at a party that is no longer a `Strand.Member` (docs/strands.md → "What removal does to the network"). A removed machine is bound to its party, which is still a member, so every machine of every party in the strand, the cadre's own included, keeps serving it.
- **It can re-bind itself.** Clearing its `MemberPeer` binding would not help: an unbound machine is not denied, and the machine holds the party member key it would need to bind again.

So a stolen phone, removed from the cadre, keeps reading and writing the user's shared workspaces with every other participant until the party leaves or re-forms each strand. For the "stolen phone" use case that removal exists for, this is the larger half of the harm.

## Options

**A. Rotate the party's member key in each strand on machine removal (recommended).** After `removeMachine` commits, the remover, for each closed strand the party is a member of: mints a fresh party member key (a new `StrandPartyKey` row, replacing the old one through the guarded delete and tombstone), seats a `Strand.Member` row for it, lets each remaining machine's membership reconciler bind itself under the new key (it already writes its own `MemberPeer` binding on a short retry ladder), then removes the old `Member` row. The existing gate then denies every machine still bound to the old key, the removed one included, with no new gate logic. The removed machine never receives the new key, because the control database no longer syncs to it.
- Seating the new `Member` row needs a strand manager's signature. Where the party is a manager (strands it founded, by default), the remover signs. Where it is not, the party needs another party's manager to admit the new key, which is a cross-party request with no flow today; until one exists, those strands keep the gap and the app says which ones.
- It does not rotate the read secret: blocks the removed machine already holds stay readable to it, and so does anything it can fetch from a machine that has not yet processed the removal. Rotating the read secret is re-forming the strand (docs/strands.md → "Revocation is forward-looking only"), out of scope here too.
- Cost: a new multi-step, multi-machine flow per strand, with partial-failure handling (new key seated, old one not yet removed). Hard; probably two tickets (rotation in strands the party manages, then the cross-party request).

**B. A party-signed "this machine is no longer ours" record in the strand.** The party files a `Strand.Revocation` for the removed machine's `MemberPeer` binding, and the gate also denies a machine whose binding its own member revoked. Rejected as the main answer: the removed machine holds the party member key and can bind itself again under a fresh stamp, so it stops only a machine that cooperates, which an honest removed machine (uninstalled app, dead server) does not need and a stolen one will not do.

**C. Document only.** Removal is control-plane only; strand access ends when the party leaves or re-forms a strand. Cheapest and reversible; leaves the stolen-phone case open with no path.

## If we do nothing

The docs and the reference apps say plainly that removal does not reach strands (as `cadre-node-removes-a-machine` and the reference-app tickets already require), and a user who removes a stolen phone must re-form each sensitive strand by hand to cut it off. Nothing breaks; the feature promises less than its name suggests.

## Reversibility

A is additive (new flow, no schema change beyond what `StrandPartyKey` and `Strand.Member` already allow, to be confirmed by the plan); it can be dropped later without migration. B adds gate logic that would have to be removed. C commits to nothing.
