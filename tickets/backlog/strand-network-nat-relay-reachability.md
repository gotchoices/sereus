description: Make a node's per-strand network reachable when the node is behind NAT, and let nodes from different parties (not just your own) find each other on a shared strand.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, schemas/strand.qsql, docs/strands.md, docs/architecture.md
----

## Why this exists

The strand-seed fix (`strand-addr-control-protocol` + `strand-seed-from-strand-addr-rpc`)
resolves strand-network addresses on demand over the **control** network. Two
limits of that approach are deliberately deferred and collected here:

### 1. Per-strand NAT reachability

Each strand runs its own libp2p node on a random port. A node behind NAT needs
that **strand** node to be dialable — i.e. its own circuit-relay reservation and
a `/p2p-circuit` address, separately from the control node's reservation.

**Identity half resolved** (`strand-transport-identity`, closes issue #1): each
strand node now derives its own transport peerId from the cadre identity key
(`strand-transport-key.ts`), so a strand node's reservation no longer collides
with the control node's at a shared relay — the relay keys reservations by
peerId, and they used to be the same. Verified on a loopback relay
(`packages/cadre-core/test/strand-transport-relay.spec.ts`).

**Still open:** the strand node receives the `enableRelay` flag, but we have not
verified that a NAT'd strand node actually obtains a usable reservation, that
`getMultiaddrs()` returns a dialable signaling/circuit address for it, and that
a peer can dial that circuit address on the strand network
(`runOnLimitedConnection` semantics on the optimystic strand dial path). Worst
case, every strand a NAT'd node joins needs its own relay slot — a real cost to
validate and possibly optimize (shared relay, multiplexed reservation, etc.).

### 1b. A strand node's addresses are the control node's, verbatim

Added while reviewing `announce-addrs-passthrough`, which made this concrete. A strand
node is built from the *same* `network` block as the control node, so it inherits that
block's address settings unchanged — both the addresses it binds and (now) the addresses
it tells peers to use. Neither is right for a second node on the same machine:

- **Binding.** Give the machine a fixed port (`listenAddrs: ["/ip4/0.0.0.0/tcp/4001"]`,
  which is what `cadre-cli`'s own example config ships) and the control node takes it
  first; every strand node then tries to bind the port already in use and fails. Already
  noted in a comment at the site, marked unverified — nobody has run it.
- **Advertising.** Give the machine a public address with a port
  (`announceAddrs`/`appendAnnounceAddrs`, e.g. `/dns4/mynode.example.com/tcp/4001`) and
  every strand node advertises the *control* node's address. A peer that dials it reaches
  the control node, finds a different node than the one it asked for, and gives up. With
  `announceAddrs` — which replaces the whole advertised set rather than adding to it —
  that bad address is the only one the strand node publishes, so it becomes undialable.

Not reachable today: the fixed public port implies a fixed bind port, and the binding
failure above stops the strand node before it advertises anything. That makes the second
half latent rather than live — but it is latent behind exactly the fix the first half
needs, so whatever gives strand nodes their own listen port must give them their own
announce addresses in the same pass. Both live in the `createLibp2pNode` call in
`buildStrandRuntime` (`packages/cadre-core/src/strand-instance-manager.ts`), and there is
a `NOTE:` at each.

Open question for whoever picks this up: is a strand node meant to be separately dialable
at a *published* address at all, or is its reachability entirely the relay/circuit story
above? If the latter, the answer may be to stop inheriting these two fields rather than to
derive per-node values for them.

### 2. Cross-party strand discovery

The control network is single-party, so control-mesh address resolution only
bootstraps **your own** cadre nodes onto a strand. Nodes belonging to **other
parties** in the same strand cohort must discover each other some other way:
the strand's own membership/peer tables (`MemberPeer` in `schemas/strand.qsql`),
the strand-formation/invite flow, and/or the future strand-overlay DHT noted in
`docs/strands.md:83-84` ("does that DHT serve as the canonical place to publish
addresses for existing strand members?"). This is the cross-party leg of the same
discovery story the originating plan ticket called out (alongside `registerSelf`
authorization and the optimystic DHT absence).

## What a future pass should decide / specify

- Whether strand nodes publish their own strand-network addresses into the strand
  membership tables (`MemberPeer`) and how that is signed/gated.
- How a joining node from another party obtains an initial dialable strand address
  (formation handshake carrying addrs? relay rendezvous? strand DHT once it lands?).
- Per-strand relay reservation strategy for NAT'd nodes and its cost.
- How this composes with the deferred Kademlia/DHT work in optimystic `db-p2p`.

This is a future concern, not active work — promote to `plan/` when the
single-party strand seeding lands and cross-party / NAT strand connectivity
becomes the next priority.
