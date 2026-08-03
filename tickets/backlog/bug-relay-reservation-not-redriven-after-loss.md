description: When a relay restarts or its connection blips, a browser tab that was reachable through it goes permanently unreachable and never recovers on its own — only reloading the page brings it back.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts
difficulty: medium
repro: static
----

## What happens

A node that cannot accept incoming connections (a browser tab, a machine behind
NAT) becomes reachable by holding a *reservation* on a relay: the relay agrees to
forward traffic to it, and the node then advertises a `/p2p-circuit` address that
other peers can dial.

`CadreNode.reserveRelays()` obtains that reservation once, during startup. If it
is later lost — the relay process restarts, the network drops, a laptop sleeps —
nothing obtains a new one. The node's relay status flips to `error` and stays
there for as long as the process lives. In the reference web app that means the
tab silently stops being dialable and *Create invitation* keeps failing until the
user reloads the page.

## Why it does not recover by itself

libp2p has its own machinery for filling an empty relay slot: when a reservation
is dropped it re-opens the slot and starts **relay discovery**, which looks for
connected peers that are known to be relays.

Discovery cannot help a cadre node. It learns which peers are relays from the
libp2p *identify* handshake, and cadre nodes speak a per-party identify protocol
(`/optimystic/control-<partyId>/id/1.0.0`, from `@optimystic/db-p2p`) while the
relay this repo deploys (`ops/docker/libp2p-infra`) speaks the stock one. The two
never identify each other, so the relay is never recognised as a relay. This is
the same mismatch that made the initial reservation fail before
`relay-reservation.ts` was changed to ask the relay for a slot explicitly —
that change fixed the *first* reservation and left the *replacement* one on the
discovery path that still cannot work.

Evidence, all in `node_modules/@libp2p/circuit-relay-v2/dist/src/transport/`:
`reservation-store.js` returns the freed slot to `pendingReservations` and emits
`relay:not-enough-relays` on connection close; `index.js` turns that event into
`discovery.startDiscovery()`; `discovery.js` selects candidates purely from the
peer store's identify-written protocol list and a registrar topology on the same
protocol id. There is no other path back to a reservation.

## Expected behaviour

A node that was asked to reserve through a relay should keep trying to hold a
reservation for as long as it is running and the relay list is non-empty —
re-dialling and re-requesting after a loss, with backoff, without the caller
having to poll or restart. `getRelayReservationState()` should distinguish
"trying again" from "given up", so the UI can show a reconnecting state rather
than a bare error.

Out of scope for this ticket: deciding whether the cadre identify prefix should
stop being namespaced. That would make discovery work but has cross-party
isolation consequences well beyond relays — if it is ever on the table it belongs
in its own ticket.

## Hazard the implementation will hit immediately

libp2p keeps a per-process blocklist of peers whose reservation request failed
with a dial error or an unsupported-protocol error (`relayFilter` in
`reservation-store.js`), and the failure path does not clear it — only a
successful-then-removed reservation does. So a naive retry loop against a relay
whose first attempt failed reports `ListenError: The relay was previously
invalid` forever, regardless of whether the relay recovered. Any re-drive design
has to reckon with that filter. There is a `NOTE:` marking this at
`describeReservationFailure` in `packages/cadre-core/src/relay-reservation.ts`.

## How to confirm the defect

Read-only inference so far — no test drives it. What would confirm it: extend
`packages/cadre-core/test/relay-reservation.spec.ts` with a relay started from a
FIXED private key on a FIXED loopback port, so it can be stopped and started
again at the same address and peer id. Reserve through it, stop it, wait for the
client's `/p2p-circuit` address to drain, start it again, and assert that the
client never regains a circuit address. That spec becomes the regression test for
the fix.
