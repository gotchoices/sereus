# Strand Management and Negotiation

## History
An initial attempt at a strand negotiation (“strand initialization”) protocol lives in `sereus/packages/strand-proto/` and is discussed in `sereus/docs/strand-proto.md`.

## Terminology
- **party**: a person or entity that transacts data with other parties.
- **node**: a device/process that runs libp2p, identified by a **Peer ID**.
- **cadre**: one or more nodes representing a single party within a strand.
- **strand**: a logical network over which participating parties transact data and share a database.
- **cohort**: the set of nodes participating in a strand (union of all cadres).

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
- Can any sereus relay node serve as a relay for anyone?
- Can a relay refuse service to unknown nodes?
- Where is a SN party likely to find a willing relay?
- If relays are not universally willing, what mechanisms make a relay “willing”?
  - incentives (payment/credit), reputation, allowlists, invitation tokens, rate limits, etc.
- Before strand initialization, where (if anywhere) do peers publish reachability?
  - If the answer is “a DHT”, which one, and how is it invitation-only?
- After strand initialization, the **strand** likely has its own DHT overlay for Optimystic/Quereus routing; does that DHT also serve as the canonical place to publish addresses for existing strand members?

**Within-party answer (implemented).** For a node's **own co-cadre siblings** there is no DHT lookup at all: the control network already gives every party node a connection to its siblings, but a `CadrePeer` row stores only a sibling's **control**-network address — dialing that reaches the sibling's control instance, not its strand instance (a strand is a separate libp2p node on its own port). So a strand's bootstrap addresses are resolved **on demand over the control mesh**: a node asks each connected sibling "what are your live strand-`X` multiaddrs?" via the `/sereus/strand-addr/1.0.0` RPC and seeds from the union (see [architecture.md → Strand-Address Resolution](architecture.md#strand-address-resolution)). This is single-party only — it bootstraps this party's own nodes onto a strand. **Cross-party** strand discovery (finding *another* party's strand members) remains the open question above: it is future work, expected to use a strand-overlay DHT and/or the strand's own `MemberPeer` records rather than the control network.

## Strand Creation

_(TODO: not yet documented here. See the strand-formation and seed-bootstrap coverage in [`docs/architecture.md`](architecture.md) ("Enrollment and Bootstrap") and the [`@serfab/cadre-core` README](../packages/cadre-core/README.md).)_

## Inviting Parties

_(TODO: not yet documented here. See the invitation/enrollment flow in [`docs/architecture.md`](architecture.md) ("Enrollment and Bootstrap") and the [`@serfab/cadre-core` README](../packages/cadre-core/README.md).)_

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
  remove anyone.
- **The last manager can never be removed.** A strand with no managers can never admit
  another member or appoint another manager, so it would be frozen permanently. Any
  removal that would empty the table is rejected.
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

Being a manager does not require being a member: a key with no `Member` row can still be
promoted. Whether it should be is tracked separately as `debt-strand-manager-must-be-member`.

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
  manager admission or a newly issued invitation. It does *not*, however, neutralize an
  invitation the removed party holds but has never spent (see known gaps below).
- **A manager must resign before losing membership.** Deleting the member row of a key
  that still holds a `Manager` row is rejected, so a removal can never leave an orphaned
  manager seat.
- **The last member can never be removed.** A member-count floor mirrors the last-manager
  floor above, with the same local-count caveat (see known gaps below).
- **Revocation is forward-looking only.** A revoked member keeps whatever strand data its
  nodes already replicated, and it still holds the strand's member private key. Cutting
  off its *future* reads means rotating the read gate, which currently means re-forming
  the strand — see [Closed-Strand Member Key Handling](#closed-strand-member-key-handling).

Known gaps remain, all out of scope of the rules above:

- **Concurrent removals on different nodes can still empty a table.** The last-manager
  and last-member floors each count the rows one node can see, so two nodes each removing
  a different manager (or member) can both believe a survivor remains. A cross-node guard
  is not attempted; tracked in the schema's own notes next to the checks.
- **An authorization signature carries no nonce, so it can be replayed.** A manager
  appointment now signs the new key *together with its generation* while removals sign
  the action-tagged key, so an approval for one action can no longer double as another —
  but a captured removal approval can still be replayed as a later removal (of a manager
  or of a re-admitted member), and a captured appointment can be re-used if the same
  generation becomes seatable again. Tracked as `bug-strand-manager-authority-antireplay`.
- **An invitation cannot be cancelled, so removal is not a re-entry gate.** Invitations are
  bearer credentials with no deactivation path — only an optional expiry. A removed party
  holding an unspent, unexpired invitation re-admits itself with no further manager action,
  and a manager can mint spare invitations before being removed. Tracked as
  `bug-strand-invite-no-revocation`.
