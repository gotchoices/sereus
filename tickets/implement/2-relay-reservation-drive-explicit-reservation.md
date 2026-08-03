----
description: A browser tab pointed at a relay server never becomes reachable through it, because the tab waits for the relay to introduce itself in a dialect the relay does not speak. Stop waiting for the introduction and ask the relay for a slot directly, and report a real reason when that fails.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/reference-app-web/src/lib/cadre-web.ts, docs/architecture.md
difficulty: medium
repro: verified
----

# Reserve on the relay explicitly instead of waiting for libp2p relay discovery

## The one thing that must change

`driveRelayReservation` (`packages/cadre-core/src/relay-reservation.ts`) dials
the relay and then *waits* for `@libp2p/circuit-relay-v2`'s relay-discovery
machinery to notice the relay and reserve on it. That machinery can never
notice this relay. Replace the wait with an explicit reservation request.

## Why discovery can never fire

libp2p's `RelayDiscovery` nominates a peer only when it can see the relay-hop
protocol id (`/libp2p/circuit/relay/0.2.0/hop`) in that peer's **peer-store
protocol list**, and that list is filled in exclusively by the **identify**
handshake. There are two nomination paths and both are identify-gated:

- a registrar *topology* on the hop protocol
  (`node_modules/@libp2p/circuit-relay-v2/dist/src/transport/discovery.js:37`).
  Its `onConnect` is invoked from one place only — the registrar's
  `peer:identify` handler
  (`node_modules/libp2p/dist/src/registrar.js` → `_onPeerIdentify`). The
  sibling `_onPeerUpdate` handles protocol *removals* only, so writing the hop
  protocol into the peer store by hand does **not** fire the topology.
- a one-shot peer-store scan inside `startDiscovery()`
  (same file, line 77). It runs once per start/stop cycle of discovery, and on
  a node listening on the bare `/p2p-circuit` address it has already run — with
  an empty peer store — before the drive dials anything.

And identify never completes against this relay: `@optimystic/db-p2p` gives
every cadre node a network-namespaced identify protocol id,
`/optimystic/control-<partyId>/id/1.0.0`
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts`, the `identify(...)`
service), while `ops/docker/libp2p-infra` runs stock identify
(`/ipfs/id/1.0.0`). Neither side can open the other's identify protocol, so
neither learns anything about the other. The TCP/WebSocket connection itself is
fine and stays open, which is why the symptom reads as a timeout.

Reproduced directly: a client with `identify({ protocolPrefix:
'optimystic/control-scratch' })` listening on bare `/p2p-circuit`, dialing a
loopback relay running stock `identify()` plus `circuitRelayServer()`. The
connection reports `status: 'open'`; five seconds later the relay's peer-store
entry lists `protocols: []` and the client's `/p2p-circuit` address set is
still empty.

## Why the fix does not need identify at all

Identify is incidental to relaying. Everything on the reservation and
relayed-dial path uses **stock, un-namespaced** protocol ids that the deployed
relay already serves: `/libp2p/circuit/relay/0.2.0/hop` for the reservation and
for a third peer's CONNECT, and `/libp2p/circuit/relay/0.2.0/stop` on the
reserving node. Discovery is the only identify-dependent step, and its whole
job is to *guess* which connected peer is a relay — a guess the caller of
`reserveRelays` does not need, because the caller was handed the relay's
address explicitly.

Verified end to end against a stock-identify relay, with the reservation
requested explicitly: the client publishes
`/ip4/.../p2p/<relay>/p2p-circuit/p2p/<client>`, a third peer dials that
address, the connection opens, and a stream on a namespaced protocol
(`/optimystic/control-scratch/echo/1.0.0`) negotiates through it.

## How to ask for the reservation

The circuit-relay transport instance owns a `reservationStore` whose
`addRelay(peerId, type)` performs the reservation. Reach it from the running
node:

```ts
// Structural, not `any`: declare the minimum shape this module depends on.
interface RelayReservationStoreLike {
  addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
  hasReservation(peerId: PeerId): boolean;
}
interface CircuitRelayTransportLike { reservationStore: RelayReservationStoreLike }

// `components` is a real field on libp2p's node class, not on the `Libp2p`
// interface; `transportManager` is the documented `@libp2p/interface-internal`
// component. Duck-type the transport rather than matching a toStringTag.
function findCircuitRelayTransport(node: Libp2p): CircuitRelayTransportLike | null
```

Three details that are easy to get wrong:

- **Pass `'discovered'`, not `'configured'`.** The circuit listener ignores a
  `configured` reservation in its `relay:created-reservation` handler
  (`transport/listener.js` → `_onAddRelayPeer` returns early), so the
  `/p2p-circuit` listen address is never published and `getMultiaddrs()` stays
  empty even though the reservation succeeded. `'discovered'` consumes the
  pending-reservation id that the bare `/p2p-circuit` listener created, which is
  exactly what that handler matches on.
- **One pending reservation per bare `/p2p-circuit` listen address.** With two
  relays configured, the second `addRelay` rejects with `HadEnoughRelaysError`.
  Reserve sequentially in list order and stop at the first success; a
  `HadEnoughRelaysError` *after* a success is success, not failure.
- **Running discovery is not a conflict.** `addRelay` dedupes through its own
  `PeerQueue` (`reserveQueue.find(peerId)` joins an existing job), so a relay
  that genuinely is discoverable — a cadre-hosted relay whose identify prefix
  happens to match — still reserves exactly once.

## Legible failures

The current `no circuit reservation within 10000ms` describes the clock, not
the cause. With an explicit request the real reason is available:

- `addRelay` rejecting with `HadEnoughRelaysError` and no prior success means
  there is **no pending reservation**, i.e. the node is not listening on the
  bare `/p2p-circuit` search address. Measured: a node with `listen: []` gets
  exactly this rejection, whose own message ("we do not need any more relays")
  says the opposite of what happened — so map it, do not pass it through.
- no circuit-relay transport in the node's transport list means the caller did
  not configure `circuitRelayTransport()`; say that.
- an `UnsupportedProtocolError` from `addRelay` means the peer at that address
  is not a relay; say that, naming the address.
- a dial failure keeps today's behaviour — report the dial error.

## Scope

- Keep `driveRelayReservation` node-agnostic (it takes a bare `Libp2p`). Strand
  nodes take the same bare `/p2p-circuit` posture and nothing drives a
  reservation for them; that is `backlog/strand-network-nat-relay-reachability`,
  not this ticket, but do not make the function harder to reuse there.
- Keep the module fail-soft: nothing here may throw, a browser tab awaits it on
  its startup path.
- Do **not** switch the tab to the configured `network.relayAddrs` route. That
  listener is fatal at startup when the relay is down (libp2p's transport
  manager defaults to `FATAL_ALL`), which is the reason the search posture was
  chosen; the reasoning is already recorded at the top of
  `relay-reservation.ts` and in `cadre-web.ts`.
- Making the *relayed connection* actually carry traffic is a separate site and
  a separate ticket —
  `implement/1-relay-server-limits-cap-relayed-traffic`. Neither blocks the
  other in code, but until that one lands an end-to-end check through the
  deployed relay will still fail, so do not treat it as a regression in this
  work.
- Reaching `node.components.transportManager` couples this module to libp2p's
  internal layout. That is deliberate and bounded — there is no public API for
  "reserve on this specific relay" — but it must fail soft and be pinned by a
  test that breaks loudly on a libp2p bump (see TODO).

## TODO

### Fix

- Split the dial phase in `relay-reservation.ts` so it yields the connected
  relays (peer id per address), not just the first dial error — the reservation
  step needs the peer ids.
- Add `findCircuitRelayTransport(node)` with the structural types above,
  returning `null` when the node has no circuit-relay transport.
- Add a reservation step that walks the connected relays in list order, awaits
  `addRelay(peerId, 'discovered')`, and stops at the first success.
- Map the failure cases listed under "Legible failures" onto specific error
  strings; keep the existing "reservation seen" success path (a reservation
  that lands still wins over any dial error).
- Keep `timeoutMs` bounding the WHOLE drive — dials, reservation requests, and
  the wait share one deadline.

### Tests (`packages/cadre-core/test/relay-reservation.spec.ts`)

- Delete `startNamespacedRelay` and its explanatory comment; point the
  `CadreNode relay reservation against a live relay` spec at a relay running
  **stock** `identify()`. That spec passing against a stock relay is this
  ticket's acceptance criterion.
- Add a spec pinning the libp2p shape this fix depends on: build a plain libp2p
  node with `circuitRelayTransport()` and assert `findCircuitRelayTransport`
  returns an object whose `reservationStore.addRelay` is a function. This is
  the tripwire for a libp2p upgrade silently removing the seam.
- Add a spec for the missing-search-listener error: a node with no
  `/p2p-circuit` listen address must report that plainly, not a timeout and not
  libp2p's "we do not need any more relays".
- Add a spec for the no-circuit-transport error.
- Keep the existing deadline, fail-soft, dead-relay-among-live-relays, and
  reservation-lost specs passing unchanged.

### Docs

- Rewrite the ⚠️ block at the top of `relay-reservation.ts`: it currently states
  that search mode cannot work against the deployed relay, and after this change
  that is wrong. Replace it with why the module reserves explicitly — the
  namespaced-identify mismatch, and the fact that reservation and relayed dial
  need no identify.
- Update the `listenAddrs` comment in
  `packages/reference-app-web/src/lib/cadre-web.ts` if it still implies the tab
  depends on libp2p discovery.
- Add the mechanism to the relay section of `docs/architecture.md`: cadre nodes
  namespace identify per party, so relay discovery cannot see an
  infrastructure relay, and reservations are therefore driven explicitly from
  the relay addresses the node was configured with.
