# How a strand's nodes find each other

Each strand is its own libp2p network, and every machine that serves it runs a separate libp2p node for it (a **strand node**) beside the node for its party's control network (the **control node**). This document explains how a strand node learns where the strand's other nodes are, how it keeps those addresses usable while it runs, and how it finds its peers again after a restart. Read it when a strand's nodes fail to connect or when you change the address code in `@serfab/cadre-core`.

Related: [Relays](relay.md) · [Deadlines and the link budget](deadlines.md) · [Inviting and joining](../strands/formation.md) · [Strand hibernation and wake](../strands/hibernation.md)

## Where addresses come from

Sereus publishes strand addresses to no shared directory. Before a strand exists there is no DHT to look anything up in: the parties exchange explicit addresses in the invitation and in the formation handshake. Once the strand runs, its nodes pass each other's signed address records along inside the strand. Addresses are held per machine and are never written to the strand database.

A **sibling** is another node of the same party. The **address book** is a libp2p node's own store of peer addresses (its peerStore). Optimystic and FRET dial a strand peer by peer id alone, so they depend on the address book holding a current address for it.

A strand node has four sources of addresses. Each covers a case the others cannot.

| Source | Whose addresses | When it is used | Kept across a process restart |
| --- | --- | --- | --- |
| Sibling address RPC | the party's own other machines | at launch, at wake from hibernation, and periodically | no; siblings are asked again |
| Formation result | the other party's nodes that answered the formation | the first launch after forming | no; held in memory |
| FRET address records | any strand peer, including one this node never connected to | continuously while the node runs | yes, inside the saved network state |
| Saved network state | the peers the node knew when it last ran | when the strand node is built | yes |

## Strand-address resolution

### The sibling address RPC

The control database stores a sibling's control-network address in its `CadrePeer` row. That address reaches the sibling's control node, which is a different libp2p node with a different peer id from its strand node. A strand node's address is also not fixed: it listens on a port the operating system assigns, or holds a relay reservation that can move ([A strand node is not separately dialable at a published fixed address](relay.md#a-strand-node-is-not-separately-dialable-at-a-published-fixed-address)). So strand addresses are asked for when needed, over the control network.

The protocol is `/sereus/strand-addr/1.0.0` (`strand-addr-protocol.ts`): one length-prefixed JSON request and one response per stream. The asker sends a strand id. The sibling answers with the live addresses of its own node for that strand, each ending in that strand node's peer id, with relay addresses ordered first. It answers an empty list when it has no live node for the strand, which is the case while the strand is hibernating there or was never started there.

Only an authorized member of the cadre gets an answer. The control node's [per-stream protocol guard](../cadre/control-security.md#per-stream-protocol-guard) checks membership before the handler runs and resets a non-member's stream without a reply, so an outsider cannot collect a party's live strand addresses. The request carries no further signature. The handler still limits how long it waits for a request and how many streams it serves at once, because a member machine can be faulty.

The response has a required status, so that the asker can tell two cases apart:

- `ok` with an empty list means "I have nothing". That can be permanent: a phone has no listening strand address and a hibernating sibling has no strand node.
- `unavailable` means "I could not answer": the handler was over its stream limit, could not read the request, or failed its own lookup.

A sibling that does not yet count the asker as a member sends nothing, which the asker records as `unreachable`. A peer that does not serve the protocol at all is recorded as `unsupported`.

### What the asker does with the answers

`CadreNode.resolveCohortSeed` runs when a strand launches and when it wakes from hibernation. It asks every sibling the control node currently holds a connection to, all at once, and takes the union of their answers. A sibling that fails, times out or answers empty contributes nothing and never fails the launch. A sibling reachable only through a relay is asked over its relayed control connection.

The union is used twice:

- **As the strand node's bootstrap list**, which is what the node dials first.
- **Merged into the strand node's address book.** The bootstrap list by itself leaves nothing in the address book that outlasts the first connection attempts, and every later dial is by peer id.

The union is a flat list, so before the merge each address is filed under the peer named by its last `/p2p/` component (`groupAddrsByPeerId` in `peer-addr-book.ts`). In a relayed address that is the destination, not the relay named first. An address that names no destination is dropped.

### Asked again while the strand runs

Resolution is repeated. `CadreNode.refreshStrandPeerAddrs` runs as a step of the control-cohort reconcile pass (see [Cohort auto-connect](../cadre/control-convergence.md#cohort-auto-connect)), which runs on every change to the cohort and at least every two minutes. For each running strand it asks the siblings that are due and merges their answers into the strand node's address book.

Two things make the repetition necessary. A sibling that restarts its strand node or moves its relay reservation has new addresses, and without a new ask it would stay unreachable until this node restarted the strand. And libp2p's address book hides an address one hour after it was first observed, so even unchanged addresses have to be written again.

Each (sibling, strand) pair has its own schedule, set by `nextStrandAddrAsk` from how the last ask ended:

| Last ask ended | Next ask |
| --- | --- |
| Addresses returned | after the refresh interval: 10 minutes, or `network.controlCohort.strandAddrRefreshMs` |
| `ok` with no address | after 1 s, doubling with each ask that yields no address, up to the refresh interval |
| No usable reply (`unreachable`, `unavailable`, `unsupported`) | the same doubling, up to one minute |

A sibling with no schedule yet is asked on the pass that follows its connection, so a phone that connects after the party's always-on machines does not wait for their schedules. The schedule is forgotten when the strand stops or the sibling disconnects.

The waits climb for these reasons:

- **A starting sibling passes through all three outcomes within seconds.** A machine that was just claimed restarts into the party, so the first asks fail. It then answers empty until its strand row arrives and the strand launches, and after that it answers with addresses. It cannot say "not yet", because it does not know the strand exists until the row arrives. A fixed long wait after an empty answer would leave the asker unconnected for the whole interval.
- **An empty answer may also be permanent**, so its wait climbs all the way to the refresh interval.
- **A failure stops at one minute** because its cause can end at any time and only the next ask finds out. A phone whose `CadrePeer` row has not yet replicated to the sibling is refused, and its [delegate grant](#delegate-grants) goes unrecorded until it asks again.

### The first node up

The first machine of a party to run a strand finds no sibling running it, so its sibling list is empty and it runs the strand alone. It answers the RPC for that strand from then on. A sibling that launches later asks it, receives its address and dials in. If no connected sibling runs the strand yet, the launch proceeds with an empty list and the periodic refresh fills it in later.

### Another party's nodes: addresses carried by formation

The sibling RPC answers members of one cadre, so it can never give the address of another party's strand node. The one moment at which two parties are authenticated to each other and agree on a strand id is the formation handshake ([The formation protocol](../strands/formation.md#the-formation-protocol)), so the first cross-party address travels there.

An approving formation result carries `strandAddrs`: the responder's live strand addresses for the strand it just provisioned, at most 16. The responder discloses them only when it also discloses its party id and control addresses, so a rejected redemption learns nothing. The field is absent when the responder has no live node for the strand, and an absent or empty list is not an error.

The joining node keeps the list in memory by strand id (`formationStrandAddrs` in `cadre-node.ts`) and uses it as follows.

- **At launch and at wake**, `resolveCohortSeed` appends the list after the sibling answers. Sibling answers come first because they were obtained just now, while the carried addresses are as old as the formation.
- **On every refresh pass**, the list is merged into the address book again for each peer whose signed record FRET does not hold yet. Without this, a responder that stays unreachable for more than an hour could not be dialed when it returns. Once FRET holds the peer's own record, that record replaces the carried addresses.
- **When a formation is repeated** for a strand that is already running, the new list replaces the old one and is merged into the address book at once. Repeating the formation is how a joiner recovers from a dead address.

The list survives `stopStrand` and a `stop()` followed by `start()` of the same `CadreNode`. `unpublishStrand`, `forgetJoinedStrand` and the node's own revocation from the strand drop it.

### Kept dialable while the node runs: FRET's address records

FRET keeps each peer's signed libp2p address record on that peer's routing-table entry, and forwards the records it holds in the neighbour snapshots that strand nodes exchange. A strand node therefore learns a member it never connected to, or a member's new address, from any neighbour the two have in common. In a strand of three or more parties, a late joiner learns the members it never met from the party that invited it. Sereus runs no protocol of its own for this.

What cadre-core adds is a re-merge. FRET hands a record to the address book only when the record arrives or is imported, and the address book hides it an hour later. Every refresh pass therefore reads the running strand node's FRET table (`strand-fret-addrs.ts`), verifies that each record is signed by and describes the peer it is filed under, and merges its addresses into the address book again. Without the re-merge, a connection to another party's strand node that dropped more than an hour after the peer was first seen could not be re-established by either side, because nothing else supplies another party's addresses.

Two properties of a record matter to a reader of this code:

- **It lasts while FRET holds the peer's entry, and at most 14 days after it was last confirmed.** A peer connected at that moment counts as confirmed. That is also how long a wrong address a peer published about itself can keep causing failed dials.
- **It proves where the peer says it is, not that the peer is a member.** Membership is judged at the connection: see [Removing members](../strands/membership.md#removing-members) for what a closed strand refuses.

## Delegate grants

A strand node's peer id is derived from the machine's private identity key and the strand id ([One reservation per node, per network](relay.md#one-reservation-per-node-per-network)). No other machine can compute it, including a sibling. When a sibling's control node runs a relay server, a strand node that asks it for a reservation is, to that relay, a peer id it has never seen.

A **delegate grant** closes that gap. The strand-address request has an optional field, `delegatePeerId`: the peer id the asker's own node for that strand runs as. A receiver that gets it records a grant for that peer id, in memory. The request is already restricted to authorized members, so the grant is a member vouching for one more peer id.

### What a grant admits

A grant admits two things at the receiver's control node: the peer's connection, with no provisional deadline, and the peer's relay reservation, without drawing on the budget for unknown peers ([How a party-run relay admits a reservation](relay.md#how-a-party-run-relay-admits-a-reservation)). It admits nothing else. The per-stream protocol guard never consults grants, so a strand node holding one is still refused every members-only protocol on the control network, the strand-address RPC included.

A grant lasts 30 minutes. A new announcement from the same member for the same strand replaces the earlier grant, so a restarted strand does not accumulate grants. A receiver holds at most 32 live grants per announcing member and 256 in total, evicting the one closest to expiry first (`delegate-admission.ts`). Grants are dropped when the receiving node stops.

### When a node announces

- **Before a strand node starts.** The launch and wake pass that asks siblings for addresses also sends the request to every relay the strand node will reserve on: the configured relays and any relay named in the control node's live circuit addresses. The grant is then in place before the strand node asks for its reservation.
- **Periodically, to relays.** The reconcile pass announces each running strand to each relay again once half the grant lifetime (15 minutes) has passed since the last announcement, so a grant does not lapse while the reservation it admitted is still held.
- **Before every reservation retry.** Grants live in the relay's memory, so a relay restart drops them and the announcing member is not told. The strand node's reservation supervisor announces to the relay it is about to dial, unthrottled, before each retry (`CadreNode.announceDelegateToRelay`). Otherwise the relay would treat the first retries after its restart as an unknown peer's.
- **With every periodic address ask to a sibling.** Those asks carry the field too, so a sibling that also runs a relay has its grant renewed on the address schedule.

The periodic relay announcement and the periodic address ask keep separate schedules on purpose. One follows the lifetime of an admission grant and the other the address book's expiry, and the two periods are unrelated.

### Dedicated relays

A dedicated relay (`ops/docker/libp2p-infra`) has no membership check, needs no grant, and does not serve the protocol. Its refusal at protocol negotiation is remembered per relay for the life of the process, and that relay is left out of the launch, wake and periodic announcements. The announcement before a reservation retry still asks it, and any reply clears the memory. This is deliberate: a party-run relay also refuses the protocol for a moment while it starts, before it registers the handler, and if it stayed skipped it would treat every later reservation from this node's strands as an unknown peer's.

## Saved network state and redial

### What happens after a restart

A restarted strand node starts with an empty address book. It reaches its peers again through these steps.

1. The node is built with the same peer id as before, because the id is derived from the identity key and the strand id. Addresses other nodes hold for it still name the right peer.
2. Optimystic reads back the network state the node saved when it last ran and re-imports the FRET routing table in it. FRET verifies each peer's signed address record and hands it to the address book.
3. The node's relay supervisors obtain its reservations, so its own circuit address is live again ([Relays](relay.md#strand-nodes-inherit-the-relay-configuration)).
4. `resolveCohortSeed` asks connected siblings for their current strand addresses.
5. FRET's maintenance redials the imported peers, and while no member is connected the [member redial](#redialed-by-cadre-core-while-no-member-is-connected) dials every member the node knows.

The saved network state is the only one of these that can name another party's strand node. Formation-carried addresses do not survive a process restart, and the sibling RPC covers the node's own party only.

### The saved network state

Every strand node is built with Optimystic's `persistence` option (wired in `StrandInstanceManager.buildStrandRuntime`). Optimystic saves the node's network state and reads it back once when the node is next built. The state holds the FRET routing table, in which each peer entry carries that peer's signed address record, a high-water mark of the network's size, and which peers the node had seen serving the strand.

Cadre-core owns only the storage (`strand-network-state.ts`): one node-local record per party, keyed by strand id, never replicated. It checks that an entry is an object with a numeric `version` and nothing more. Optimystic discards a state of a version it does not write, and FRET refuses a structurally corrupt table and drops a record older than 14 days. Nothing in the state grants authority: every record is verified at import and the dialed peer authenticates by peer id.

The store is injected as `CadreNodeConfig.strandNetworkState.store`. The default keeps the state in memory, so a node using the default restarts with an empty routing table. `PersistentStrandNetworkStateStore` keeps it in any `DurableSlot`, and `FileStrandNetworkStateStore` (subpath `@serfab/cadre-core/strand-network-state-file`) keeps it in a file on Node.js. cadre-cli and the edge-node platforms inject a durable store. [Node-local state](../cadre/node.md#node-local-state) lists where each platform keeps it.

When the state is saved and when it is forgotten:

- **Saved** on every opened connection and whenever a peer's serving status changes. It is not saved on stop, and not when a peer's addresses change. FRET learns a peer's record shortly after the connection opens, so the save at connection open does not contain it; the save that follows the peer's first serving verdict does.
- **Kept** across `stopStrand`, hibernation, and a `stop()` followed by `start()` of the same `CadreNode`. A wake from hibernation rebuilds the strand node and re-imports what the stopped node last saved.
- **Forgotten** by `unpublishStrand`, `forgetJoinedStrand` and the node's own revocation from the strand. A save that arrives from the old node after that is dropped, so teardown cannot restore the entry.

### One side remembering is enough

A strand node that stops sends FRET's leave notice before libp2p closes its connections. A peer that receives the notice marks the leaver as gone but keeps its entry and address record, and saves both. After a graceful stop, both sides' saved tables normally still name each other.

When one side's table has lost the other, because the record aged out or the entry was evicted, the side that kept a record dials once both are running. The pair stays apart only when neither holds a usable record: one side lost its record and the other side's record is stale because the first changed its address. Repeating the formation recovers from that.

### Restarting while every other member is offline

The saved state also restores which peers the node had seen serving the strand, and Optimystic counts those peers in the cluster until FRET finds them unreachable. A node rebuilt while every other member is offline therefore fails its first writes with `Failed to get super-majority`, and then writes alone. The window is the same one a running node sees when a member drops, a few seconds on a fast link. An app that sends immediately after relaunching alone should retry the write.

### Redialed by cadre-core while no member is connected

Every running strand node runs a member redial (`strand-peer-redial.ts`), started and stopped with the strand's runtime, so a hibernating strand dials nobody. While the node holds a connection to no other member, it dials every member it knows at once. Each address gets the budget the machine's declared link gives a relayed dial, 21.5 s at the default ([Dial budgets are counted in round trips, not milliseconds](deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds)). After a round that reaches nobody it waits that same budget, doubling up to 5 minutes. A disconnect triggers a new look at once.

FRET's maintenance also reopens connections, but only to peers in its routing table, each under the node's whole-dial limit ([Opening and keeping a connection](deadlines.md#opening-and-keeping-a-connection)). The member redial adds the members FRET has no entry for, and it starts as soon as the last member disconnects. Without it, a sibling this node never connected to is never dialed: its address reaches the address book through the sibling RPC, and nothing else dials a peer that is only in the address book.

Whom it dials, and who counts as connected:

- **Dialed:** peers whose verified signed record the FRET table holds; the peers in the launch bootstrap list; and the party's other machines known to hold the strand (from their `StrandPeer` rows in the control database), at whatever addresses the address book holds for them. The last group covers a sibling this node never connected to, for example one whose port was blocked at launch and opened later.
- **Counted as connected:** a peer FRET labels `member` (it has been seen speaking the strand's protocols), a peer from the bootstrap list, or one of the party's machines.
- **Never either:** a relay the node reserves on, a peer FRET labels `foreign`, and a peer the strand refuses as revoked. The relay matters most. The strand node is connected to its relay throughout, and FRET keeps a record for it like any peer, so counting it would leave the redial idle exactly when it is needed.

A node whose own party was removed from the strand dials nobody. The strand keeps running there for the session, but a removed party must not keep dialing the strand's members.

## Limits and accepted tradeoffs

- **Addresses are not stored in the strand database.** A member whose address changed while it was connected to nobody stays unreachable until it dials someone. In a two-party strand there is no common neighbour to forward a record, so the party that moved has to dial. A registry in the strand (`Strand.MemberPeer` rows carrying addresses) would let offline members be found; it was declined because nothing needs it, and is worth revisiting only if a case needs addresses to reach members that are offline.
- **Formation-carried addresses are held in memory only.** A process that restarts between `formStrand` and the strand's first launch comes back with no address for the other party and must repeat the formation. Persisting them on the joined-strand record was declined: it mixes address state into that record and needs a rule to stop dead addresses being dialed on every launch. Revisit if an embedder forms and launches in separate sessions.
- **A record that arrives after the last save is not saved.** A peer whose address changes during a long connection is saved with its old record until the next save, which matters only to a restart in between. The fix belongs in Optimystic: saving when FRET's table changes.
- **Nothing ages a strand's saved network state out.** A strand this machine stopped serving because another machine of its party removed it keeps its entry, because that removal is not proof that the strand is gone. Revisit if snapshots grow on machines that host many short-lived strands.
- **The first writes after restarting alone fail.** How long that window lasts on a slow relayed link is not known.
- **The member redial and FRET's maintenance both dial routing-table peers.** A peer that is gone is dialed by both, each on its own schedule. The overlap is kept because the member redial is the only thing that keeps dialing the bootstrap list and the party's machines that FRET holds no entry for.
- **The redial reads the bootstrap list once, when the runtime is built.** Addresses from a repeated formation reach the address book at once but reach the redial only after the strand's runtime is rebuilt.
- **A member can answer the sibling RPC with any addresses under any peer ids.** The cost is failed dials: an address grants no authority, the dialed peer authenticates by peer id, and the entry expires after an hour. A responder's formation-carried addresses are re-merged for longer, until the peer is met or the strand is forgotten.
- **A delegate grant is not verified.** The receiver cannot check that the announced peer id is the member's strand node, so an authorized member can give any peer id connection-level access and a relay slot for 30 minutes. The per-member and total caps bound this.
- **An announcement can fail to land.** Announcement times are recorded whether or not the relay answered, so that an unreachable relay is not asked on every pass. Until the next announcement, the relay treats that strand node as an unknown peer.
