---
description: A machine that forwards traffic for its party now lets unknown peers ask for forwarding. Answering each request means re-reading the membership list and re-checking every signature in it, and an unknown peer can ask over and over as fast as the machine can answer, so a peer with no standing can keep the machine busy for free.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts
severity: edge-case
likelihood: contrived
tradeoffs: Nothing is wrong today — a real party's relay answers a handful of reservation requests an hour, and the obvious cheap fix (decide from the already-materialized member snapshot) reintroduces exactly the failure the relay-reservation seam was built to remove, so a maintainer may reasonably wait until a relay is actually exposed to untrusted traffic.
---

# The relay-reservation decision is expensive and an unplaced peer can repeat it at will

## What changed, and why this is newly reachable

Before the relay-reservation seam landed (`control-sibling-relay-reservation-denied`), a
relay-running control node refused an unrecognized peer's connection outright, so such a
peer never reached the circuit-relay `hop` protocol at all. It now gets an
`'admit-for-relay'` connection, and every RESERVE request on it runs
`CadreNode.admitControlRelayReservation`.

That decision is not cheap. Its member check calls `listAuthorizedMembers()`, which runs
two Quereus queries over the control database (`CadreControl.Revocation` and
`CadreControl.CadrePeer`) and then verifies one Ed25519 voucher signature per member row.
On a cold block cache those queries can fan out to the control cohort over the network.

Nothing rate-limits how often a peer may send RESERVE. libp2p caps *concurrent* inbound
hop streams (the circuit-relay server leaves `maxInboundHopStreams` at the registrar
default), not the request rate, so one connection can drive reservation decisions back to
back for as long as it is open:

- a peer that never gets a reservation still has ~5 s before the not-reserving deadline
  aborts it — but it may re-dial and repeat;
- a peer that DID take a budget slot keeps its connection indefinitely and can repeat
  without limit.

The cost is bounded only by how fast the relay can answer, which is the shape of a
work-amplification vector: a cheap request buys expensive server work from a peer with no
membership standing.

## Why the existing note does not cover it

`admitInboundControlConnection` carries an accepted-tradeoff note saying the live read is
safe because "connections are rare and cadres small". That premise held when the read only
ever ran per inbound connection — each of which costs the dialer a full noise handshake.
It does not hold at the reservation hook, where the same read runs per RESERVE request and
the requester pays almost nothing.

## Not measured

No benchmark was run. The claim here is structural (unbounded repetition of a query +
per-row signature verification), not a measured slowdown factor. Whoever picks this up
should measure the per-decision cost on a realistic party size before choosing a shape.

## Expected behavior

An unplaced peer should not be able to make the relay redo the full membership
determination arbitrarily often. Shapes worth weighing (none chosen here):

- memoize the reservation decision per peer for a short window — reservation refreshes are
  minutes apart, so a few seconds of memoization costs correctness nothing;
- bound RESERVE requests per connection or per peer at the seam, refusing the excess;
- narrow the decision itself so the expensive half only runs when the cheap halves are
  inconclusive.

**Do NOT simply switch the decision to the materialized `authorizedControlPeers`
snapshot.** That snapshot is deliberately bounded-stale (refreshed on the ~15 s reconcile
pass and on local membership writes), so a member whose row arrived by replication can be
missing from it for a window — and if the unauthorized budget is full at that moment, the
member is refused its reservation and left with no address at all. That is precisely the
failure `control-sibling-relay-reservation-denied` was opened to fix, which is why the
reservation hook reads live.
