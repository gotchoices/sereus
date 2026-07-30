description: When a node adds itself as a member at the same moment it is publishing its own address record, the published record can be left without the node's signature until the next refresh, so other nodes reject it in the meantime.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts
difficulty: medium
----
A node's membership row (`CadreControl.CadrePeer`) can be created two ways:

- an owner "authorize" of some peer id — including the node's own — which writes the
  row with no self-signature (`Sig` null), because an owner cannot produce another
  peer's signature; and
- the node publishing its own address record, which writes the row WITH its own
  signature so the row is immediately usable by other nodes.

These two can happen at the same moment. The self-publish path
(`CadreNode.publishSelfRecord`) reads "does my row exist yet?" and then decides
insert-vs-update from that read. If an authorize seats the row in between, the
self-publish insert now quietly no-ops (the insert became idempotent — see the
concurrency work in `strand-addr-seed-convergence-validation-2`), and the row keeps
the authorize's empty signature.

## Consequence

The node's own address record sits unresolvable — any other node that looks it up
gets a row whose signature check fails, so the address is unusable. It self-heals: the
next periodic self-registration takes the update path and writes a proper signature.
But the window is one heartbeat interval, and during it the node is effectively
unreachable-by-lookup to the rest of the cadre.

## Reachability

Reachable today — the strand-addr seed convergence integration scenario authorizes the
founder's own peer id. Never actually observed in a run: startup self-registration
fires about a second in, well before any authorize in practice.

## Why it isn't a one-line fix

The obvious repair is to have the insert report whether it actually inserted, and fall
through to the self-record UPDATE path when it lost the race. That is not enough on its
own: the record's freshness stamp was computed from the pre-race read, and the
self-update rule requires a strictly increasing stamp, so the record has to be re-signed
against a fresh read of the row that actually landed. That plus test coverage for both
race orders is real work, not a review-pass tweak.

## Expected behavior

After a node has both authorized itself and published its own address record — in
either order, concurrently — its membership row carries a valid self-signature by the
time both operations have resolved. No heartbeat wait.
