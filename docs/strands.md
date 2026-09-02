# Strand Management and Negotiation

## History
An initial attempt at a strand negotiation (“strand initialization”) protocol was built as a standalone package; it has since been superseded by the native `cadre-core` formation transport (`strand-formation-protocol.ts`) described above.

## Terminology
- **party**: a person or entity that transacts data with other parties.
- **node**: a device/process that runs libp2p, identified by a **Peer ID**.
- **cadre**: one or more nodes representing a single party within a strand.
- **strand**: a logical network over which participating parties transact data and share a database.
- **cohort**: the set of nodes participating in a strand (union of all cadres). Optimystic uses
  the same word for a narrower thing — the nodes a single *block* is replicated to, sized by
  `DEFAULT_STRAND_CLUSTER_SIZE`. Code comments and [`architecture.md` → Replication cluster
  size](architecture.md#replication-cluster-size) mean Optimystic's sense unless they say otherwise.

Networking terms:
- **Peer ID**: a cryptographic identity for a libp2p node, derived from a private key.
- **multiaddr**: a self-describing network address (e.g. `/ip4/…/tcp/…/p2p/<peerId>`).
- **bootstrap node**: a stable libp2p peer you dial first to join a particular overlay (not a “global DHT”).
- **relay**: a Circuit Relay v2 server that can forward connections to NAT’d nodes via `/p2p-circuit`.
- **dnsaddr**: a mechanism to publish multiaddrs via DNS TXT records (so operators can avoid hard-coding IPs/Peer IDs in configs).

Reachability information:
- **addr**: “how to reach this party (or its cadre)”, which can be expressed as either:
  - **explicit multiaddrs** (direct or relay-routed), or
  - **discovery parameters** (e.g. `bootstrap nodes` + a network identifier) that allow resolving a current dial address.

Design note:
- Sereus is intended to be **invitation-only** (out-of-band). There is no assumption of a single, world-wide DHT where “everyone registers”.
- This raises an open question: **which DHT(s)** exist (and when), especially *before* strand initialization.

## Primary Objective
This document seeks to explore how best to manage the nodes in a strand.
From a UX perspective, this involves:
- How does one establish a cadre?
- How does one add/delete/update nodes in it?
- How does one create a strand?
- How does one invite others to the strand?
- How does one manage the strand?
- What is the lifecycle of a strand?

## Cadre Types
A cadre could conceptually take on one of the following shapes (showing only the interesting cases rather than all permutations):
- SN: Single NAT node: phone, laptop behind a firewall
- SP: Single public: cloud or physical server with public IP
- MN: Multiple NAT nodes: a phone and several computers, all behind a firewall
- MM: Multiple mixed nodes: several devices with at least one having a public IP
- LM: Large-scale mixed: More nodes than the DHT replication factor, at least one with a public IP

## Use cases

### SN–SN (both parties are single NAT nodes)
A user with only a phone wants to connect to another such user.

- The parties will need a **relay** somewhere neither can accept inbound connections directly.
- At a minimum, one party must reserve a slot on the relay and disclose a full relay-routed multiaddr.
- The other party can reach the first via the relay if it has that relay-routed multiaddr.
- If the first party intends to roam (connect via more than one relay), it will need a discovery mechanism:
  - join a DHT overlay (via one or more bootstrap peers)
  - publish reachability (Peer ID + dialable addresses, ideally including `/p2p-circuit`)
- This allows the second party to discover a current dial address using only the Peer ID plus bootstrap information.
- If a party loses its phone, it should be able to rejoin the cadre with a new phone only if its identity key material can be recovered/rotated safely.

Open question: what is “the DHT” here?
- Is a **cadre** its own DHT overlay?
- Is there a **pre-strand rendezvous DHT** used only for discovery/initial contact?
- Or is peer discovery always explicit (full dial addrs exchanged out-of-band), with no pre-strand DHT at all?

### SN–MM (a single NAT node connects to a multi-node cadre)
A single phone party connects to a more robust party with multiple nodes.
- The SN party is limited to two options:
  - Listening for a connection:
    - requires a relay
    - requires disclosing a relay-routed dial address (or publishing one via a DHT overlay)
  - Initiating a connection:
    - requires the MM party’s reachability info (explicit multiaddrs and/or bootstrap/discovery info)

## Some Questions

**Relay willingness — resolved (implemented).** A **dedicated** relay/bootstrap node (the
`ops/` infrastructure stacks) has no membership gate and relays for anyone. A **party
control node** that also runs the relay server (the default for every storage-profile node)
is party-private infrastructure: it relays for its own party's nodes — including the extra
transport identities its members' strand nodes run as. The mechanism for the latter is a
**member-announced delegate grant**: before a member's control node starts a strand node,
it announces the derived transport peerId that strand node will run as, over the
already-authenticated `/sereus/strand-addr/1.0.0` RPC, and the relay holds a short-lived,
in-memory admission grant for exactly that peerId
(`packages/cadre-core/src/delegate-admission.ts`). The grant admits the *connection* and
the *reservation* only — control-DB streams stay member-gated. The connection gate is no
longer the sole relay admission control: the relay question proper is decided at the
circuit-relay server's reservation hook (`membership-connection-gater.ts` → "The
relay-reservation seam"), where members and delegates are admitted outright and a peer the
relay cannot (yet) place — typically a genuine member whose `CadrePeer` row has not
replicated to the relay — is admitted within a small bounded budget
(`network.unauthorizedRelayReservationCap`, default 8); an admitted-for-relay connection
that never reserves is dropped after a few seconds. So a single-node NAT'd (SN) party
finds a willing relay in its own party's storage nodes, or in the ungated dedicated
relays, and is never locked out of its first address by replication ordering.
  - Grants live only in the relay's memory, so a relay **restart** drops them all and the
    announcing member is not told. A strand node whose reservation re-dials in that window
    is denied until the announcer's next refresh pass re-announces (at most half the grant
    lifetime, currently 15 min). Acceptable while a relay restart is rare and the strand
    recovers on its own; if relay restarts become routine — or that outage window starts
    mattering — the durable attestation below is the fix, not a shorter refresh interval.
  - Deferred: a **durable** attestation — a replicated, signed `MemberPeer(MemberKey,
    PeerId)` row binding a member to its strand transport peerIds — would add revocation
    and audit on top of the in-memory grant. It is the same binding strand-*mesh*
    admission control will need, so it waits for that work rather than being built twice.

- Before strand initialization, where (if anywhere) do peers publish reachability?
  - If the answer is “a DHT”, which one, and how is it invitation-only?
- After strand initialization, the **strand** likely has its own DHT overlay for Optimystic/Quereus routing; does that DHT also serve as the canonical place to publish addresses for existing strand members?

**Within-party answer (implemented).** For a node's **own co-cadre siblings** there is no DHT lookup at all: the control network already gives every party node a connection to its siblings, but a `CadrePeer` row stores only a sibling's **control**-network address — dialing that reaches the sibling's control instance, not its strand instance (a strand is a separate libp2p node on its own port, with its own transport peerId derived from the cadre identity key — cadre authority stays on the control node, and the distinct peerId is what lets both nodes share one circuit relay). So a strand's bootstrap addresses are resolved **on demand over the control mesh**: a node asks each connected sibling "what are your live strand-`X` multiaddrs?" via the `/sereus/strand-addr/1.0.0` RPC and seeds from the union (see [architecture.md → Strand-Address Resolution](architecture.md#strand-address-resolution)). This is single-party only — it bootstraps this party's own nodes onto a strand. **Cross-party** strand discovery (finding *another* party's strand members) remains the open question above: it is future work, expected to use a strand-overlay DHT and/or the strand's own `MemberPeer` records rather than the control network. Until it lands, every discovered strand cohort is one party's machines (a cross-party mesh can still be built by hand — see the cross-party note in [architecture.md → Replication cluster size](architecture.md#replication-cluster-size)) — see [architecture.md → Strand Networks](architecture.md#strand-networks) — so a strand's replication breadth (`DEFAULT_STRAND_CLUSTER_SIZE`, [architecture.md → Replication cluster size](architecture.md#replication-cluster-size)) buys machine redundancy within that party and no party redundancy at all.

That resolution is not one-shot. The launch/resume seed is also merged straight into the
new strand node's libp2p **address book** (its peerStore), and every running strand
re-resolves its siblings' strand addresses over the control mesh on a ~10-minute cadence,
re-merging each answer under the sibling's *strand* transport peerId
(`CadreNode.refreshStrandPeerAddrs`, riding the control-cohort reconcile pass). Both matter
because everything below cadre-core dials a strand peer by **bare peer id** — Optimystic's
cluster and repo clients, FRET ping/announce — and a bootstrap address list alone does not
put anything in the address book that outlives the initial discovery. Without the refresh, a
sibling that restarts its strand node or rotates its relay reservation stays unreachable
until this node restarts or resumes the strand, and even the original seed addresses expire
out of the peerStore after an hour. Only own-cadre siblings are covered — the strand-addr RPC
is control-network, hence single-party — so cross-party strand members remain the open
question above.

## Strand Creation

_(TODO: not yet documented here. See the strand-formation and seed-bootstrap coverage in [`docs/architecture.md`](architecture.md) ("Enrollment and Bootstrap") and the [`@serfab/cadre-core` README](../packages/cadre-core/README.md).)_

## Inviting Parties

_(TODO: not yet documented here. See the invitation/enrollment flow in [`docs/architecture.md`](architecture.md) ("Enrollment and Bootstrap") and the [`@serfab/cadre-core` README](../packages/cadre-core/README.md).)_

Attaching a human-readable legal agreement to a strand — reviewed before joining, executed
as a separate in-strand signing act — is a design-stage plan: see
[`strand-contracts.md`](strand-contracts.md).

## Closed-Strand Member Key Handling

A closed strand's read-gating secret is the control-layer `Strand.MemberPrivateKey`
(an Ed25519 key minted by `generateStrandMemberKey`; the founding `Member`/`Manager`
keys derive from it). It is held **unencrypted** in the party's control database,
which Optimystic replicates to **every node the party owns**.

**That replication is the point.** It is what makes a party's cadre nodes
*fungible* for closed strands: any node has the member key, so any node can serve
or participate in the strand — including a node added to the cadre long after the
strand was formed, and a node that comes up headless (push-woken, background
runner) with no user present to unlock anything. Formation likewise puts the raw
key on the wire (`FormationProvisionResult.memberPrivateKey`, disclosed only after
token + disclosure validation) and the initiator records it into its own control DB.

**Accepted residual risk (decided 2026-07).** A compromised device — stolen phone,
rooted OS, app-storage extraction — leaks the member private key of every closed
strand that party belongs to, giving the attacker that member's read access. The
team explicitly accepts this for now rather than hardening, because:

- the key sits behind the same app-storage boundary (mobile LevelDB) as the rest of
  the control DB's strand data, so encrypting only this column is partial hardening;
- the keys that are hard to rotate and single-point-of-compromise — the node's
  libp2p peer identity and the owner key derived from it — are **already** in the
  platform enclave via the `KeyStore` seam;
- member keys are per-strand, intentionally replicated, and rotatable by re-forming
  the strand;
- every fungibility-preserving fix (envelope-encrypting the column under a
  per-cadre key in each node's enclave) requires **cadre-wide secret distribution**
  — one shared key provisioned into every node's enclave, late joiners included —
  which does not exist and currently has no second consumer to justify building it.

Options that bind a strand's key to a single device's enclave (or to a chosen
quorum of nodes) were considered and rejected: they trade away node fungibility and
re-open the "how does a late-joining node serve this strand" question that
plaintext replication answers for free.

**Revisit when** a second consumer for cadre-wide secrets appears (making the
distribution build worth its cost), or the deployment threat model changes such
that app-storage compromise must be survived. At that point the open questions are:
late-joiner provisioning, envelope-key rotation across the replicated DB,
fail-closed behavior when a node's enclave slot is wiped (biometric invalidation /
Android reinstall), mixed-platform cadres (Node `FileKeyStore` + RN secure store),
and migrating existing plaintext rows.

Cross-reference: [`docs/architecture.md` → Node Key Material & the KeyStore Seam](architecture.md#node-key-material--the-keystore-seam).

## Who May Administer a Closed Strand

A closed strand's administrators are its **managers** — the rows of the `Strand.Manager`
table (see [`schemas/strand.qsql`](../schemas/strand.qsql)). Managers are the only parties
that can admit anyone: issuing an invitation, adding a member directly, and promoting
another manager all require the writer to prove it already holds a manager row. So the
contents of that table are the strand's entire access-control story, and the schema
enforces these invariants:

- **Every appointment comes from someone strictly closer to the founder.** Each manager
  row records a *generation* — how many appointment steps separate it from the founder,
  who sits at generation 0 — and every manager is seated strictly further from the founder
  than the manager who appointed it. A promotion is only valid when signed by an existing
  manager whose generation is strictly smaller than the new manager's. So two strangers
  cannot appoint each other, in one transaction or otherwise: among any batch of
  appointments, the one closest to the founder still needs a sponsor closer than itself,
  and that can only be someone who was already a manager before the batch. A key cannot
  promote itself for the same reason. Generation is a lineage marker, **not** a privilege
  level — a generation-5 manager has exactly the same powers as a generation-1 manager,
  including removing it.
- **A manager can be removed by another manager, or resign itself.** Either way the
  removal carries a signature from the party authorizing it; an unrelated key cannot
  remove anyone. The two cases sign *different* approvals, so a resignation someone
  collected cannot be turned into a removal, or the reverse.
- **Every approval is good for one action, on one row, once.** Each membership row —
  member, manager, or device record — carries a one-off random marker minted when the row
  is created, and every signed approval covers that marker along with the table name, the
  action, and the row's key. Deleting a row retires its marker permanently: the deletion
  has to file a tombstone in the same step, and no row may ever be created carrying a
  retired marker again. A captured approval therefore names a row incarnation that no
  longer exists and can never exist again, so it cannot be replayed to re-remove,
  re-admit, or re-appoint anyone. Re-adding the same key mints a fresh marker, which the
  old approval does not cover.
- **The last manager can only step down by *sealing* the strand.** An ordinary
  resignation is rejected when it would leave no manager behind; emptying the table is a
  separate, deliberate act carrying its own distinct signature, so it can never happen by
  accident and a resignation someone collected can never be turned into one. Sealing
  permanently freezes who belongs to the strand: with no managers, nobody can be invited,
  admitted, or promoted ever again — and that is the point of it. A strand that can never
  grow is a privacy guarantee to everyone already in it, because no key is left holding
  the power to let in a party who would then be able to read everything the strand has
  ever held. It is irreversible: a lone remaining member cannot re-found the strand later
  and start admitting again. What remains possible is everything that does not grow the
  membership — members can still leave, and can still register or clear their own device
  records. One piece of housekeeping does go away with the managers: a device record left
  behind by a member who was already removed can only be cleared by a manager, so after
  the seal it stays forever. Any invitation still outstanding when the strand is sealed
  dies with it: it can never be redeemed, which matters because after the seal there is
  nobody left who could even cancel it.
- **The founding manager is the only unsigned seat**, and only in the founding state: at
  most one member exists, the founder's member row is already present, and no manager
  exists yet. Every later manager needs a signature. (This is why a strand is bootstrapped
  in `Header` → `Member` → `Manager` order — seating the manager first is rejected.)
- **A manager row can be added or deleted, never edited.** Editing would let a
  resignation — which only proves the *outgoing* key consented — be reused to point the
  row at a key of the attacker's choosing.
- **Handing off sole control is add-then-resign, in that order.** A single transaction
  that removes the only manager and inserts a replacement is rejected; the successor must
  be appointed while the outgoing manager still holds authority.

A manager must also be a member: promoting a key that holds no `Member` row is rejected
outright, so every manager can do everything a manager needs to — admit members, issue
invitations, promote other managers, revoke a member, clear a device record, and resign its
own seat. Admitting a brand-new key as a member and promoting it to manager in the same
step is supported, so a key can go straight from stranger to manager without ever passing
through a member-but-not-yet-manager gap. Like the sealing rule above, this one is
checked against what one node can see (see known gaps below).

### Removing Members

Membership removal is governed by the same signed-approval discipline as admission
(the `Strand.Member` table's constraints in [`schemas/strand.qsql`](../schemas/strand.qsql)):

- **Any manager can remove any member.** The removal carries an existing manager's
  signature over the *removal of that specific key*. Every membership approval is tagged
  with its action, so a captured admission approval cannot be replayed as an eviction,
  nor an eviction as an admission.
- **A member can leave on its own.** A removal self-signed by the departing key deletes
  that member's own row — no manager involved. Because the signature is checked against
  the key being removed, one member's signature can never remove a *different* member.
- **A removed member cannot walk back in on the invitation it already used.** That
  invitation was spent at join time; the leftover record of its consumption does not
  re-admit anyone on its own. Re-admission takes a fresh manager action — a direct
  manager admission or a newly issued invitation.
- **An unspent invitation is cancelled explicitly, and cancellation is permanent.** A
  manager can list the strand's still-redeemable invitations and cancel any of them; a
  cancelled invitation can never be redeemed again, and there is no un-cancelling — letting
  a party back in means issuing a fresh invitation. Cancelling is what makes removal a
  re-entry gate, but it is a *separate step*: removal does **not** cancel anything
  automatically, because an invitation names no invitee, so the strand cannot tell which
  invitations were meant for the departing member — or whether it holds any (see known gaps
  below).
- **A manager must resign before losing membership.** Deleting the member row of a key
  that still holds a `Manager` row is rejected, so a removal can never leave an orphaned
  manager seat. This is the removal-side half of the manager-is-also-a-member rule stated
  above; the other half refuses to promote a key that is not a member in the first place.
- **Clearing the removed member's device records is a separate step, not a cascade.**
  Removing a member leaves behind the records binding its devices to the strand; a manager
  lists the departed member's devices and clears each one with its own signed removal.
  Anything reading those device records must check membership separately rather than
  treating a device record as proof of it.
- **A device record can only be added or deleted, never edited.** Every field of the record
  is part of its identity, so re-binding is a delete plus a fresh add. Allowing an edit
  would let any member re-point someone else's device record at its own key — clearing a
  record it has no authority to delete — since an edit is only ever checked against the
  values being written, not the ones being replaced.
- **The last member can never be removed.** A strand always keeps at least one member
  holding its data, so any removal — or self-departure — that would empty the membership
  is rejected. This holds on a sealed strand too: the last member cannot leave even
  though no manager remains to stop them. Like the rules above, the count is taken from
  what one node can see (see known gaps below).
- **Revocation is forward-looking only.** A revoked member keeps whatever strand data its
  nodes already replicated, and it still holds the strand's member private key. Cutting
  off its *future* reads means rotating the read gate, which currently means re-forming
  the strand — see [Closed-Strand Member Key Handling](#closed-strand-member-key-handling).

Known gaps remain, all out of scope of the rules above:

- **Membership rules are checked against the rows one node can see.** The last-member
  floor counts locally, so two nodes each removing a different member can both believe a
  survivor remains. The manager-must-also-be-a-member rule has the same shape: one node
  promoting a key while another node removes that key's membership can each pass locally
  and merge into a manager seat with no membership behind it. A cross-node guard is not
  attempted; tracked in the schema's own notes next to the checks.
- **A seal only binds a node once it gets there.** Sealing is a deletion like any other,
  and it has to reach a node before that node stops recognising the manager. Until it
  does, that one ex-manager's own key could still admit someone there. Nobody else gains
  anything — no other key was ever a manager on that node either — and the same
  cross-node guard is not attempted here.
- **An invitation names no invitee, so cancelling one is a manual operator step.** An
  invitation is a bearer credential: whoever holds it can redeem it once, and the strand
  keeps no record of who it was meant for. Managers can now cancel invitations, but nothing
  can cancel them *on a member's behalf* at removal time — a manager has to review the
  outstanding invitations and decide. So a removed party holding an unspent, unexpired,
  uncancelled invitation still re-admits itself. Binding an invitation to a specific invitee
  is tracked as `feat-strand-invitee-bound-invites`.
