----
description: A user's device runs two separate network connections that both identify themselves with the same name, so when both register with the same relay server, traffic meant for one gets delivered to the other and group networking fails. Reported from outside with a runnable reproduction.
prereq:
files: packages/cadre-core/src/cadre-node.ts (launchStrand → startStrand hands `network: this.config.network` at ~L2434; peerId≡owner-key enforcement at L1019, L1188, L1862), packages/cadre-core/src/strand-instance-manager.ts (~L247-268 — relay mode + `privateKey: config.privateKey`), packages/cadre-core/src/types.ts (CadreNodeConfig — no per-strand network knob), packages/cadre-core/src/strand-addr-protocol.ts (L1-11 doc comment stating the shared peerId), packages/cadre-core/src/control-cohort.ts (L85), packages/cadre-core/src/seed-bootstrap.ts (ed25519PublicKeyB64FromPeerId, L84), schemas/strand.qsql (MemberPeer, L119-132), node_modules/@libp2p/circuit-relay-v2/dist/src/server/{index.js,reservation-store.js}
difficulty: hard
----

# A cadre's control node and its strand nodes collide at a shared circuit relay

Reported externally: **https://github.com/gotchoices/sereus/issues/1** (author `risavian`,
2026-07-28), against `@serfab/cadre-core` 0.8.1 and 0.9.0. The issue carries a self-contained
runnable reproduction (three files, `npm install` + two `node` commands) — start there rather
than building one.

## What was independently verified against this repo's source

Every load-bearing claim was checked against `src/` here (the issue was written against the
published `dist/`), and all of them hold:

- **One identity key feeds both node types.** `CadreNode.launchStrand` passes
  `network: this.config.network` to `startStrand` (`cadre-node.ts` ~L2434), and
  `strand-instance-manager.ts` ~L268 forwards `config.privateKey` verbatim to
  `createLibp2pNode`. So the control node (`control-<partyId>`) and every strand node
  (`strand-<strandId>`) are independent libp2p instances with the **same peerId** and the
  **same** `listenAddrs`/`transports`.
- **We document this ourselves.** `strand-addr-protocol.ts` L1-11: "*A strand runs as its own
  libp2p node … separate from the control node … even though both share the same peerId.*"
- **No escape hatch exists.** There is no `strandNetwork`, per-strand identity, or per-strand
  relay-target field anywhere in `packages/cadre-core/src`.
- **The relay genuinely cannot disambiguate.** In the installed `@libp2p/circuit-relay-v2`
  (4.1.3 here; the issue cites 4.2.5 / 4.2.10 with the same shape): the reservation store is
  keyed by peer (`server/reservation-store.js` — a second reserve for the same peer *refreshes*
  rather than registers), and hop-connect delivery does
  `connectionManager.getConnections(dstPeer)` then takes `connections[0]`
  (`server/index.js:230,236`). With two connections from one peerId, the relay picks arbitrarily.
- **peerId ≡ owner key is enforced on the control side**, so the naive "give the strand its own
  random key" is genuinely unsafe there: `ed25519PublicKeyB64FromPeerId` gates at
  `cadre-node.ts` L1019, L1188, L1862 and `control-cohort.ts` L85.

Symptom the reporter observes: a sibling dialing a strand node's advertised circuit address and
requesting the strand's FRET protocol gets its stream delivered to the *control* connection,
whose registrar knows nothing of that protocol — `UnsupportedProtocolError: … could not
negotiate /optimystic/strand-<id>/fret/1.0.0/*`, then `NoValidAddressesError`, then
`strandPeers=0`. Dormant for solo/loopback nodes, which is why the reference apps never hit it.

## Where the issue's own analysis needs a second look

The issue rules out per-strand identities on the grounds that doing it *correctly* would need
"a signed binding … plus a verification path — a real protocol addition." On the strand side
that binding **already exists**: `schemas/strand.qsql` L119-132 defines
`MemberPeer (MemberKey, PeerId)` whose `Authorized` constraint verifies a signature by the
member key over `digest(MemberKey || '|' || PeerId)`. A strand-specific transport peerId bound
to the member key is exactly the row that table already stores. What is genuinely missing is the
*mapping* a sibling needs — control-peerId → that member's strand peerId — and
`strand-addr-protocol.ts` is the natural carrier, since it already answers "what are your live
strand-`X` multiaddrs?" over the control mesh.

Meanwhile the issue's proposed fix (an additive `strandNetwork` override on `CadreNodeConfig`)
is a **mitigation, not a cure**: it only helps a consumer who has a *second relay* to point at,
and the collision returns the moment both nodes reserve through the same one. It is cheap and
back-compatible, so it may still be worth landing as an immediate unblock — but do not file it
as "fixed" if that is all that ships.

So the design question this ticket must settle is real and has at least three candidate answers:
(a) the additive `strandNetwork` knob alone; (b) per-strand transport identity bound via
`MemberPeer` + a strand-peerId mapping in the strand-addr RPC, keeping the cadre's authority
identity on the control node only; (c) stop running a separate libp2p node per strand and
multiplex strand protocols onto one node. Weigh them, pick one, document the tradeoff — and
note that (b) and (c) both have blast radius well beyond a config field.

## Scope notes for whoever picks this up

- **Reproduce first, with the issue's own scripts.** Confirm both the duplicate-peerId property
  and the routing consequence (the latter is Node/loopback reproducible with no NAT: two nodes
  sharing one key, both reserving at one relay).
- **Do not treat the red integration suite as yours.** Every real-network scenario currently
  fails for an unrelated reason tracked in `blocked/control-db-convergence-optimystic-p2p` and
  registered in `tickets/.pre-existing-known.md`. That also means a relay-path fix **cannot be
  validated end-to-end by those scenarios tonight** — plan the verification around unit-level
  and/or purpose-built loopback relay tests, and say plainly in the handoff what could not be
  proven.
- **Rebuild before believing an integration result.** `packages/integration-tests` imports
  `@serfab/cadre-core` through `dist/`, not `src/`.
- Related parked work: `backlog/strand-network-nat-relay-reachability` covers per-strand NAT
  reachability generally; this is its concrete, reported instance. Reconcile with it rather
  than duplicating it — and if the fix lands the relay half, say so in that ticket.
- Whatever ships, `docs/architecture.md` and `docs/strands.md` both describe the per-strand node
  model and will need updating; the `strand-addr-protocol.ts` doc comment states the shared
  peerId as settled design and must not be left contradicting the code.

## TODO

- Reproduce with the issue's scripts; record which of the three repros fire and their output.
- Confirm the misrouting end-to-end on loopback (two nodes, one key, one relay, two protocols).
- Decide between options (a)/(b)/(c) above; document the tradeoff and the rejected options.
- Output implement ticket(s) — split if the chosen option spans transport + protocol + schema.
- If any part needs a human product call rather than an engineering one, route that part to
  `blocked/` and keep the rest moving.
