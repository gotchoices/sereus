# Strand Management and Negotiation

## History
An initial attempt at a strand negotiation (“strand initialization”) protocol lives in `sereus/packages/strand-proto/` and is discussed in `sereus/docs/strand-proto.md`.

## Terminology
- **party**: a person or entity that transacts data with other parties.
- **node**: a device/process that runs libp2p, identified by a **Peer ID**.
- **cadre**: one or more nodes representing a single party within a strand.
- **strand**: a logical network over which participating parties transact data and share a database.
- **cohort**: the set of parties participating in a strand (and, by extension, their cadres/nodes).

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

## Strand Creation

## Inviting Parties
