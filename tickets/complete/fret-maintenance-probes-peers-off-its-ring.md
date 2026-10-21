description: FRET's maintenance probes connected peers that are not on its ring (the relay, another party's control node), every probe fails protocol negotiation, and while such a peer is selected FRET's back-off stays near its fastest interval, so an idle phone sends about 20 failed or redundant FRET pings a minute through the relay; needs FRET to stop probing peers that do not speak its protocol, and Optimystic to expose FRET's maximum idle interval.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: ../Fret/packages/fret/src/service/fret-service.ts (stabilization ~2828-2867, phase 2 re-probe ~3426/~3510, the NOTE on off-ring peers ~3079-3085, read only), ../Fret/packages/fret/src/service/idle-backoff.ts (read only), ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (FRET options ~1183-1197, dcutr ~1042, read only)
repro: verified
----
# FRET keeps probing peers that are not on its ring

**Resolved by p2p-fret 1.2.1** (`foreign-peers-not-reprobed-by-the-idle-loop`, gotchoices/Fret#3: item 1 below), which Optimystic 1.17.0 requires; adopted by `adopt-optimystic-1-17-0`. Measured with `message-cost-accounting`, strand case, idle 60 s: FRET pings went from 32 (12 of them failing) in the 2026-10-19 23:28 run to 6 (none failing) in the 2026-10-20 runs at 00:46 and 22:46, and upkeep streams from 56 to 30. The settle window still has 16 failed FRET pings: the run of refused probes FRET needs against each foreign peer before it leaves it alone.

Items 2 and 3, which this ticket said to file if the cost remained:

- **Item 2 (FRET's idle cap passed through Optimystic): not filed.** The idle loop now backs off: 3 FRET pings each way between the strand nodes in the idle minute after settle, against 10 before. At FRET's 60 s cap that becomes one a minute each way, less than libp2p's own ping every 35 s.
- **Item 3 (`dcutr`): filed as `blocked/optimystic-dcutr-between-relay-only-peers`.** It still opens 9 streams per join (1 in B addStrand, 2 in B's first insert, 6 in settle).

**Blocked on a dependency outside this repo.** Unblocks when FRET stops re-probing peers it has labelled foreign, or stops letting those re-probes restart its idle back-off: gotchoices/Fret#3 (filed 2026-10-19), upstream ticket `../Fret/tickets/plan/foreign-peers-not-reprobed-by-the-idle-loop`, covers item 1. Items 2 and 3 (Optimystic: FRET idle-cap passthrough, `dcutr` off) are not filed, because `dcutr` costs only at join time and the idle cap matters only once Fret#3 lets the back-off reach it; file them if `message-cost-accounting` still shows the cost after Fret#3 lands. Read at FRET 1.1.0 (`48cb6b5`), Optimystic main (`f22a8cb7`). The FRET checkout was being edited during the read; line numbers may drift.

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

`formation-connection-closed-after-formation` closes the cross-party control connection the joiner's formation dial opened, but FRET redials it (measured below), so both off-ring peers remain until item 1 lands. The relay connection stays. Dropping the inviter's control node from the joiner's peer store would stop the redial, but it works around FRET by editing libp2p state that other services read, and was not done.

Measured after that change (2026-10-20, strand case, FRET from `../Fret` at 1.2.1 `439b85e`): the joiner's formation connection closes about 100 ms after the contact (both control nodes log `peer:disconnect`), and about 4.2 s later one control node's FRET reconnects to the other (`peer:connect`, then `negotiate strike` 1, 2, 3 at 12 ms, 1.5 s and 4.5 s). The settle window then shows a new relayed dial (`B.ctl->relay hop`, `relay->A.ctl stop`) and 3 failed `control-<party>/fret/ping` each way, and the idle minute shows 0 failed FRET pings between the control nodes but 2 `/ipfs/ping` each way, so the re-opened connection stays up. This matches FRET's `probeMembership`, which redials a peer that is not connected (`redialWithin`) before pinging it; the redial was not traced to that call. Before the change, in a run earlier the same day: settle 2 failed FRET pings A→B and 3 B→A, idle 2 `/ipfs/ping` each way. So closing the formation connection alone does not remove this off-ring peer; FRET has to stop redialing it.

## If nothing is done

A few dozen small relayed messages a minute per idle phone; each wakes the radio.
