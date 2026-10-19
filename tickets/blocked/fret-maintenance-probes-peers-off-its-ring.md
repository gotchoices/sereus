description: FRET's maintenance probes connected peers that are not on its ring (the relay, another party's control node), every probe fails protocol negotiation, and while such a peer is selected FRET's back-off stays near its fastest interval, so an idle phone sends about 20 failed or redundant FRET pings a minute through the relay; needs FRET to stop probing peers that do not speak its protocol, and Optimystic to expose FRET's maximum idle interval.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: ../Fret/packages/fret/src/service/fret-service.ts (stabilization ~2828-2867, phase 2 re-probe ~3426/~3510, the NOTE on off-ring peers ~3079-3085, read only), ../Fret/packages/fret/src/service/idle-backoff.ts (read only), ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (FRET options ~1183-1197, dcutr ~1042, read only)
repro: verified
----
# FRET keeps probing peers that are not on its ring

**Blocked on a dependency outside this repo.** Unblocks when FRET stops re-probing peers it has labelled foreign, or stops letting those re-probes restart its idle back-off: gotchoices/Fret#3 (filed 2026-10-19) covers item 1. Items 2 and 3 (Optimystic: FRET idle-cap passthrough, `dcutr` off) are not filed, because `dcutr` costs only at join time and the idle cap matters only once Fret#3 lets the back-off reach it; file them if `message-cost-accounting` still shows the cost after Fret#3 lands. Read at FRET 1.1.0 (`48cb6b5`), Optimystic main (`f22a8cb7`). The FRET checkout was being edited during the read; line numbers may drift.

## What happens

- FRET's stabilization backs off from 1.5 s to a 60 s cap when quiet, but any pass that selects an off-ring, dead or foreign peer for re-probing holds it at the base. FRET's own NOTE says such a ring "settles at about five passes per window (~9 s apart)".
- On Sereus every node is connected to its relay (which runs no FRET), and after a formation the two parties' control nodes stay connected to each other (different networks, so a different FRET namespace). Each is a probe target whose `…/fret/ping` fails negotiation every time.
- Separately, libp2p's `dcutr` hole punching is attempted between relay-only peers where it cannot succeed (9 attempts in the measured join). That is Optimystic's node configuration (`libp2p-node-base.ts` ~1042), not FRET; included here because it is the same kind of idle waste on the same link.

## Measured

`message-cost-accounting` baseline (2026-10-19), two-party strand, idle 60 s: 20 `fret/ping` between the strand nodes, failed `fret/ping` from every control node and strand node to the relay (2 each) and between the two control nodes (2 each way), on top of `/ipfs/ping` every 35 s per connection. Settle window: 6 `dcutr` streams A→B.

## Proposed upstream change

1. FRET: do not select for probing a peer whose identify does not list this namespace's FRET protocol, or stop after the first failed negotiation until its protocols change.
2. Optimystic: pass `maxPassiveIntervalMs` (FRET's idle cap) through `createLibp2pNode` so an embedder can choose it.
3. Optimystic: let an embedder turn off `dcutr` (or turn it off when the node has no listen addresses).

## Sereus's side meanwhile

`formation-connection-closed-after-formation` removes the cross-party control connection, which is one of the two off-ring peers. The relay connection stays.

## If nothing is done

A few dozen small relayed messages a minute per idle phone; each wakes the radio.
