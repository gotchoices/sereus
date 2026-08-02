----
description: The browser reference app hand-writes its own logic for connecting through a relay server, duplicating what the shared node library will do once its relay setting works. Consider folding one into the other.
prereq: cadre-relay-addrs-wiring
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts
difficulty: medium
----

# The web reference app reserves its relay slot by hand

## Background

Once `cadre-relay-addrs-wiring` lands, there are two ways in this repo to make a node reachable
through a circuit relay:

1. **Configured.** Set `network.relayAddrs`; cadre-core turns each entry into a circuit listen
   address, libp2p dials the relay and holds the reservation, and the relay automatically becomes a
   delegate-announce target for the node's strand nodes.
2. **By hand.** `packages/reference-app-web/src/lib/cadre-web.ts` sets
   `listenAddrs: ['/p2p-circuit', '/webrtc']`, then after `node.start()` dials each relay itself
   (`reserveRelay`, line 414) and polls `control.getMultiaddrs()` until a `/p2p-circuit` address
   appears (`waitForCircuitReservation`, line 451).

Route 2 predates route 1 and works. It is kept for now rather than migrated, because it is not pure
duplication — it also drives the app's `relayState` diagnostics (`dialing` / `reserved` / `error`
plus the resulting circuit addresses, surfaced in the app UI and asserted by the solo e2e
diagnostics spec), and it is deliberately fail-soft: an unreachable relay leaves the tab in a solo
posture instead of failing startup.

## What to decide

Whether cadre-core should own relay reservation for both, and what the browser app would lose or
gain.

Points in favour of consolidating:

- One mechanism, one place a relay bug gets fixed. Today a change to reservation behaviour has to be
  made twice.
- The hand-rolled path bypasses `circuitRelayTargets()`, so a relay dialled this way is not a
  delegate-announce target. That is invisible in the web app's current solo/Phase-1 posture and
  would start to matter if a browser tab ran strand nodes behind that relay.
- The bare `/p2p-circuit` listen address the app uses names no relay, so
  `extractCircuitRelayTargets` skips it by design (`delegate-admission.ts:255`) — the app's relay is
  structurally invisible to the rest of cadre-core.

Points against, or at least prerequisites:

- cadre-core would need to expose reservation state (status, resulting circuit addresses, last
  error) for the app's diagnostics to survive the move.
- cadre-core would need an explicit fail-soft contract for reservation: a node whose relay is
  unreachable must still start. The configured path currently lets libp2p's listener behaviour
  decide, which is not the same guarantee.

Neither is large, but together they are a design decision about cadre-core's public surface rather
than a mechanical refactor — hence backlog rather than a queued fix.
