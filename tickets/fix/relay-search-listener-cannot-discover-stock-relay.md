----
description: A browser tab that is pointed at a relay server never actually becomes reachable through it — the tab and the relay speak different dialects of the introduction handshake, so the tab never learns the relay can carry traffic for it. The tab's relay status sits on "error" forever and it can never create an invitation.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/relay-reservation.spec.ts, ops/docker/libp2p-infra/src/main.ts, packages/reference-app-web/src/lib/cadre-web.ts, docs/architecture.md
difficulty: hard
repro: verified
----

# Relay discovery never fires: cadre nodes and the deployed relay speak different identify protocols

## What is broken

A browser tab (and any node taking the same route) becomes reachable by holding a
**circuit-relay reservation**. There are two ways to get one:

- the **configured** route — `network.relayAddrs`, which builds a
  `<relay>/p2p-circuit` listen address naming one exact relay. Works, but is
  fatal at startup when that relay is down, so a browser tab must not use it.
- the **search** route — a bare `/p2p-circuit` listen address, where libp2p
  watches its open connections for a peer that advertises the relay-hop
  capability and reserves on it. This is what the tab uses, driven by
  `CadreNode.reserveRelays()`.

The search route cannot work against the relay this repo actually deploys.
libp2p learns which capabilities a connected peer has from the **identify**
handshake. `@optimystic/db-p2p` gives every cadre node a *network-namespaced*
identify protocol id — `/optimystic/control-<partyId>/id/1.0.0` — while the relay
in `ops/docker/libp2p-infra` runs stock identify (`/ipfs/id/1.0.0`). The two never
complete an identify exchange, so the tab never learns the relay is a relay, so no
reservation is ever attempted. The dial succeeds and the connection stays open,
which is why this looks like a timeout rather than a rejection.

Two extra wrinkles make this worse than a one-line mismatch:

- The prefix is **per party** (`control-<partyId>`), so "just make the relay use
  the same prefix" does not work for a relay serving more than one party.
- Nothing surfaces the cause. The tab reports
  `no circuit reservation within 10000ms`, which reads like an unreachable relay.

## Evidence (reproduced)

`packages/cadre-core/test/relay-reservation.spec.ts` →
`CadreNode relay reservation against a live relay`. Started a `CadreNode` with
`network.listenAddrs: ['/p2p-circuit']` (the browser tab's exact posture) against
a loopback `circuitRelayServer`:

- relay with **stock** `identify()`: dial connects, connection stays open,
  `getMultiaddrs()` stays empty, status `error` after the full 15 s wait.
- same test, relay with `identify({ protocolPrefix: 'optimystic/control-<partyId>' })`:
  status `reserved` in roughly half a second.

The spec currently uses the second (matched-prefix) relay so it tests the
reservation driver rather than this defect, and says so at the site.

## Expected behaviour

A node listening on the bare `/p2p-circuit` search address, pointed at the relay
this repo deploys, reaches `reserved` and advertises a `/p2p-circuit` address —
without the relay needing to know anything about the party it is relaying for, and
without giving the node a listener that is fatal when the relay is down.

Whatever the route, the failure mode must also be legible: a node that cannot
discover a relay it is connected to should say so, not report a generic timeout.

## Scope notes

- The cleanest-looking fix (have cadre nodes register stock identify **alongside**
  the namespaced one, so infrastructure peers can be identified) lives in the
  sibling `../optimystic` repo (`packages/db-p2p/src/libp2p-node-base.ts`), not
  here. Confirm whether the namespacing is load-bearing before changing it — it
  exists so nodes of different networks do not mistake each other for peers.
- In-repo alternatives exist and should be weighed rather than assumed away: teach
  the `ops/` relay to serve additional identify protocol ids; or give the tab a
  reservation path that does not depend on discovery at all.
- Out of scope: the strand-node reachability work in
  `backlog/strand-network-nat-relay-reachability` — that goes through the
  configured route, which is unaffected.
