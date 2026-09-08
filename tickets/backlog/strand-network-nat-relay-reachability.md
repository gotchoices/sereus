description: Make a node's per-strand network reachable when the node is behind NAT, and let nodes from different parties (not just your own) find each other on a shared strand.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-transport-relay.spec.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, schemas/strand.qsql, docs/strands.md, docs/architecture.md
difficulty: hard
tradeoffs: It is real product work rather than a test gap, the per-strand relay-slot cost may turn out to need an optimization pass of its own, and a maintainer targeting desktop or hosted deployments first could reasonably defer the whole NAT story.
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

## Measured 2026-09-07 — the gap is wider than "unverified", and it blocks the headline mobile case

Audited every relay-touching test in the repo while assessing whether the integration suite covers
the scenarios a phone-first product needs. Three findings sharpen section 1 above.

**Every product-level relay test relays the CONTROL network, and the relay is always a machine of
the same party.** `relay-only-control-addr.integration.ts:100-170` (sibling control node A relays
for C), `:172-242`, `:244-290`, `:292-362`, `:364-424`; `push-wake-e2e.integration.ts:281-414`
(party member L relays). Dedicated standalone relays appear only in bare-libp2p unit specs
(`cadre-core/test/relay-reservation.spec.ts:224`, `strand-transport-relay.spec.ts:45`).
Cross-party relaying appears only as denial and budget-cap cases
(`relay-only-control-addr.integration.ts:318`, `:403-411`) — never as successful data flow.

**No strand has ever been carried over a circuit.** Every strand mesh in the suite forms over
direct loopback WebSocket addresses: `strand-formation-e2e.integration.ts:130` with hand-dialled
strand addrs at `:507-510`, `:607-608`, `:727-728`, `:747`;
`strand-membership-closed-strand-e2e.integration.ts:202`;
`strand-addr-seed-convergence.integration.ts:146-147`. Several strand scenarios switch the relay
*server* on and never use it (`websocket-chat.integration.ts:77-78`,
`convergence-stress.integration.ts:164-165`, `strand-formation-e2e.integration.ts:455`).

**`strand-transport-relay.spec.ts` proves less than its name suggests.** It does dial a
`/p2p-circuit` address and complete protocol negotiation (`:106-115`, `:153-154`), and it does
prove the identity fix — a per-strand derived key yields two distinct dialable circuit addresses
at one relay (`:139-155`). But both endpoints are bare `createLibp2p` nodes (`:65-73`) speaking
fabricated protocols (`/sereus-test/strand/1.0.0`, `:26`) whose handler closes the stream without
reading or writing (`:75-77`). No `StrandInstanceManager`, no `StrandDatabase`, no
`/optimystic/strand-<id>/…` prefix, and **not one byte of strand data crosses the circuit**.
Nothing exercises `strand-addr-protocol`/`collectStrandAddrs` over a circuit either, so nothing
proves a peer could ever *learn* a strand node's relayed address.

**And nothing reserves a slot for a strand node in the first place.** The comment at
`strand-instance-manager.ts:379-386` says it directly: nothing drives an explicit reservation for
a strand node. The flag is threaded; the reservation is not made.

### Why this now ranks above the other coverage gaps

The product's headline case is two people with only phones. Neither is directly dialable, so the
strand between them exists only if a strand node can hold a relay reservation and be dialled
through it. That path is not merely untested — its first step is unimplemented. Of the six network
shapes reviewed on 2026-09-07 (late-joining machine, phone-to-phone via relay, two multi-machine
cadres, medium private, small public, medium public), this is the only one blocked on missing
product code rather than on missing test scaffolding.

Also worth knowing: at the `CadreNode` level, exactly one endpoint is ever relay-only and its peer
always listens directly (`push-wake-e2e.integration.ts:358-359, :370`;
`relay-only-control-addr.integration.ts:132` with B listening at `:116`). The only
both-ends-unreachable case anywhere is the synthetic loopback in
`strand-transport-relay.spec.ts:85-94, :153-154`. So "both parties behind NAT" is unproven even on
the control network.

### The acceptance scenario this ticket owes

When section 1 lands, the proof is one integration scenario and it should be written as part of
that work rather than filed separately: two parties, neither with a listen address, both holding
reservations on a **third, dedicated** relay (not a party machine), forming a strand and
exchanging rows over the circuit — with an assertion that the connection actually used is a
circuit one (`connection-path.ts` distinguishes them) so a direct fallback cannot pass for a
relayed success. Recording the per-strand reservation cost during that run answers the open
question above about whether every strand a NAT'd node joins needs its own relay slot.
