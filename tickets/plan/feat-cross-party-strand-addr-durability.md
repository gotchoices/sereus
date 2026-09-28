description: Two people's shared workspace stays connected only while both apps keep running; after one restarts, or its relay address changes, there is no way to re-find the other person's workspace address. Build a durable, refreshable address directory between parties.
prereq: formation-carries-strand-addrs
files: schemas/strand.qsql, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/cadre-node.ts, docs/strands.md
difficulty: hard
tradeoffs: The formation-time one-shot seed already covers the release demo path, and a durable registry touches the heavily-audited strand membership schema — it may be better designed together with strand-mesh admission control (feat-strand-member-allowlist-admission) than before it.
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

## Maintainer decision (2026-09-27): local address book, swapped on connect

Driven by gotchoices/sereus#18 (kjeib, pure-Node repro). Two relay-only parties form a closed strand and replicate. Both `CadreNode`s are rebuilt over the same storage; both re-attach and report `active`, but writes never cross again (3 of 3 runs, with a control write before the restart that crossed in about 2.5 s). The repro script is inlined in the issue.

**Scope for this ticket. Do NOT build the in-strand registry (candidate 1) or the cross-party RPC (candidate 2).**
1. **A local address book per machine, per strand,** in that machine's own storage (beside its strand storage, not in the strand database): the strand peers it has connected to, and their last-known multiaddrs with a last-seen time. On attach, including after a restart, dial those before anything else, so the FRET ring and the cohort find the other party again. Age entries out: a failed relayed dial now costs up to 14 s at the declared link.
2. **Swap address books when two strand members connect,** over the strand's own network. Entries are signed and time-stamped, so a machine learns other parties' current addresses and parties it never exchanged an invitation with. Verify signatures, merge by freshness, and never let a received entry replace a fresher local one. Pick the signing key deliberately: the strand member key proves "a member"; a peer's own key proves "this peer's own claim". Write down why.
3. **cadre-core remembers the strands it joined,** including cross-party joins made through `formStrand` / `addStrand`, with the `MemberPrivateKey` the formation result hands over. Keep them in the node's own storage and re-attach them on start, the same way own-party strands come back through `strand:discovered`. Apps should no longer need their own remembered-joins list, as the #18 harness does. Document the contract. Treat the stored key as a secret, the same way the identity key is.
4. **Stop peer-join catch-up from targeting peers that don't speak the strand's block-transfer protocol,** such as the relay. Today its "failed 3 times in a row" warning names the relay, which misled the #18 reporter.
5. **Scenario:** port the #18 repro into `packages/integration-tests`. Two relay-only parties on a loopback relay, form, a control write, both nodes rebuilt over the same persisted storage, then a post-restart write that must cross. It must fail before the fix. Also run it once as two OS processes (the reporter's own caveat is that a one-process restart keeps module state), even if only as an opt-in script.
6. **Docs:** `docs/strands.md` (how a restarted machine re-finds its strand's peers; what cadre-core remembers about joined strands) and the architecture relay section. Release note.

Split into implement tickets that each fit one runner pass. Items 3 and 4 are independent of 1 and 2 and can go first. The in-strand registry stays a possible later step, only if a case needs addresses to reach members that are offline.
