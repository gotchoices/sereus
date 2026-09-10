description: Two people's shared workspace stays connected only while both apps keep running; after one restarts, or its relay address changes, there is no way to re-find the other person's workspace address. Build a durable, refreshable address directory between parties.
prereq: formation-carries-strand-addrs
files: schemas/strand.qsql, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/cadre-node.ts, docs/strands.md
difficulty: hard
tradeoffs: The formation-time one-shot seed already covers the release demo path, and a durable registry touches the heavily-audited strand membership schema — it may be better designed together with strand-mesh admission control (feat-strand-party-identity) than before it.
----

## Problem

`formation-carries-strand-addrs` seeds a cross-party strand mesh **once**, at
invitation time, from addresses held in memory. That leaves three durable gaps:

- **Restart**: an initiator that restarts has an empty cross-party seed (own-party
  sibling resolution — the strand-addr RPC — is membership-gated to its own cadre) and
  cannot re-find the other party until a fresh invitation is exchanged.
- **Rotation**: a party whose relay reservation or address changes strands every peer
  that only held the old address.
- **Third parties**: a strand with three or more parties has no way for late joiners to
  learn the addresses of parties they never exchanged an invitation with.

## Candidate mechanisms (design work of this ticket)

1. **In-strand signed address registry (recommended primary).** Per-strand analogue of
   the control network's `CadrePeer` record: each member publishes its strand transport
   peerIds *and current multiaddrs* with a freshness stamp and self-signature into the
   strand database — either by extending `Strand.MemberPeer` (`schemas/strand.qsql:298`)
   or a sibling table beside it. Because the strand DB replicates to every member, a
   restarted node reads the other parties' last-published addresses **from its own
   local replica with zero network** — which is exactly what the restart case needs.
   Groundwork exists: `registerMemberPeer` / `listMemberPeers` / `removeMemberPeer`
   (`strand-membership-writer.ts:936-1039`) are built, signed, replay-guarded — and
   have **zero production call sites** today. This is also the durable delegate
   attestation `docs/strands.md` defers ("a replicated, signed MemberPeer(MemberKey,
   PeerId) row … waits for strand-mesh admission control rather than being built
   twice") — coordinate the two rather than building either twice.
2. **Cross-party strand-addr RPC with membership proof.** Extend
   `/sereus/strand-addr/1.0.0` so a requester from another party is authorized by a
   signature with the strand's member key (closed strands: both parties hold the
   shared `MemberPrivateKey`-derived keypair) over `(strandId, requesterPeerId,
   timestamp)` with a short freshness window. Gives on-demand refresh over any control
   connection, but needs a durable record of the *other party's control contact* to
   dial — so it complements (1) rather than replacing it. Note today's inbound control
   gate refuses stranger connections outside the formation window; this option needs
   its own admission story.
3. **Strand-overlay DHT** (`docs/strands.md` open question): deferred with the
   upstream `db-p2p` Kademlia work; do not block on it.

## Also in scope to decide here

- Open strands: no shared member key exists, so both the publication trust model and
  any RPC proof need a different gate (relates to `feat-open-strand-witness-policy`).
- Publication cadence and re-publish triggers (relay reservation change, address
  change, TTL heartbeat — mirror `CadreNode.registerSelf`'s triggers).
- Consumer wiring: `resolveCohortSeed` and `refreshStrandPeerAddrs` read the registry;
  what happens when local rows are stale and the peer is gone.
- Relay-restart grant loss (in-memory delegate admission grants die with the relay,
  `docs/strands.md` bullet) — the durable attestation arm of the same design.
