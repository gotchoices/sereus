description: Each time a phone joins a strand, the networking layer under Sereus tries to turn the relayed connection between the two machines into a direct one, which cannot work when neither machine accepts incoming connections; the attempts are relayed messages for nothing. Needs Optimystic to let Sereus switch that attempt off for such machines.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`dcutr: dcutr()` ~1061 and the comment above it, read only), packages/cadre-core/src/cadre-node.ts and packages/cadre-core/src/strand-instance-manager.ts (the two node builders that would pass the option), packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (the measurement)
----
# Optimystic: let an embedder leave out hole punching on a node that cannot be dialled

**Blocked on a dependency outside this repo.** Unblocks when Optimystic lets the node's builder leave out libp2p's `dcutr` service (or leaves it out itself on a node with no listen addresses), in a release Sereus can adopt. Split from `complete/fret-maintenance-probes-peers-off-its-ring` (its item 3), which said to file it if `message-cost-accounting` still showed the cost once FRET stopped probing foreign peers. It does. Upstream ticket: `../optimystic/tickets/backlog/feat-a-node-without-listen-addresses-leaves-out-hole-punching` (filed 2026-10-21, backlog because of its tradeoff); no GitHub issue.

## What happens

`@optimystic/db-p2p` builds every node with `dcutr: dcutr()`, libp2p's direct-connection upgrade: when two peers are connected only through a relay, each side tries to open a direct connection to the other's observed address. Its comment says it is inert where the transport cannot hole-punch. On a Sereus strand between two relay-only machines (phones, which have no listen addresses and speak WebSockets through the relay) it is not inert: the upgrade is negotiated over the relayed circuit, and it cannot succeed, because neither side accepts a connection.

## Measured

`message-cost-accounting`, strand case (two single-machine parties, both relay-only through one loopback relay), 2026-10-20 on Optimystic 1.17.0: 9 `/libp2p/dcutr` streams from A's strand node to B's per join (1 in B's `addStrand`, 2 in its first insert, 6 in the 15 s settle window), the same as on 2026-10-19. None in the idle minute. On a phone each is an exchange through the relay that wakes the radio.

## Proposed change in Optimystic (the recommended default)

A `NodeOptions` flag that leaves the `dcutr` service out, which cadre-core would set on nodes built with no listen addresses. Alternatively, Optimystic leaves `dcutr` out by itself when the node has no listen addresses, which needs no Sereus change.

## Why a maintainer might decline

Hole punching can succeed between two machines that do accept connections but sit behind NAT, such as two cadre-host machines; that case is not measured here, and a blanket switch would lose it. That is why the proposal keys on listen addresses rather than turning it off everywhere. The saving is 9 relayed streams per join, not a recurring cost.

## If nothing is done

Each strand join pays about 9 extra relayed exchanges per relay-only pair. Nothing breaks.

## Reversibility

An option whose absence is today's behaviour. Fully reversible.

## Resolution (2026-10-21)

Optimystic took the alternative: a node whose advertised addresses include none another machine can dial directly is built without `dcutr` on its own (`NodeOptions.holePunching` forces it either way). No Sereus change; it arrives with the Optimystic release after 1.17.0.
