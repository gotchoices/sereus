----
description: Strand instances start with an empty, never-populated bootstrap list and no DHT, so they have no peer-discovery seed of their own; control-discovered strands also miss mode selection.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts
----

## Problem

A strand instance has no peer-discovery seed of its own. The discovery story breaks in two places — one upstream (optimystic db-p2p) and one in Sereus (`cadre-core`) — and the Sereus half is what this ticket scopes.

### Upstream: no Kademlia DHT (context, tracked separately)

optimystic's `db-p2p` builds its libp2p node with `peerDiscovery` limited to the static `bootstrap()` list plus FRET gossip. There is no Kademlia DHT — no `kadDHT`, `peerRouting`, or `contentRouting` service is configured (`../optimystic` `db-p2p/src/libp2p-node-base.ts:301-305`). Without a DHT, a node can only discover peers it was explicitly seeded with (bootstrap) or that FRET gossips to it from an already-connected peer set. The lack of a DHT is an upstream concern and can be tracked in its own ticket; Sereus must at minimum wire the seed it controls.

### Sereus: the bootstrap list is never populated

`StrandInstanceManager.startStrand` creates an isolated libp2p node per strand with a hardcoded empty seed:

- `packages/cadre-core/src/strand-instance-manager.ts:199` — `bootstrapNodes: []` with the comment `// Will be populated from strand cohort`. That promise is never fulfilled. `startStrand` forwards `config.network.transports` and `config.network.listenAddrs` (lines 213-214) but never derives strand bootstrap peers from the control network's `CadrePeer` rows or any cohort source.

Consequence: the strand boots with an empty discovery seed and depends entirely on FRET gossip from a peer set that itself starts empty. Combined with `registerSelf` being a no-op (no cohort/membership rows are written for a strand), there is no cohort data to read back even if the wiring existed. This is the admitted "bootstrap-only DHT discovery not working" gap: the bootstrap seed is empty and the DHT that would otherwise compensate is absent.

### Sereus: control-discovered strands miss mode selection

There are two entry points into `startStrand`, and they disagree on whether `mode` is threaded:

- `CadreNode.addStrand` (`packages/cadre-core/src/cadre-node.ts:515-524`) destructures `mode` from its config and forwards it to `startStrand`.
- `CadreNode.handleStrandAdded` — the control-network-discovery path (`packages/cadre-core/src/cadre-node.ts:382-391`) — builds the `startStrand` call without `mode`, so it defaults to `'networked'` (see the default in `strand-instance-manager.ts:513` log and `StartStrandConfig.mode` in `packages/cadre-core/src/types.ts:263-276`).

Consequence: a solo / cold-start node that discovers a strand through the control network (rather than via an explicit `addStrand`) is forced into `networked` mode. It then receives the network transactor and can stall on schema apply / first DML because there is no cohort to serve those reads/writes — exactly the situation `bootstrap` mode exists to handle. This is inconsistent with the explicit `addStrand` path, which lets the caller choose `bootstrap` for a cold start.

## Expected behavior

- `startStrand` derives the strand's `bootstrapNodes` seed from the control network's `CadrePeer` / cohort rows (the peers known to participate in this strand's cohort), instead of passing `[]`. A strand should boot with a real discovery seed drawn from the cohort it belongs to.
- The control-network-discovery path (`handleStrandAdded`) chooses `bootstrap` vs `networked` mode correctly for solo / cold-start nodes, consistent with `addStrand`. A node that is the only/first participant must be able to come up in `bootstrap` mode rather than stalling against an absent network.
- The upstream absence of a Kademlia DHT is acknowledged as a separate concern (optimystic `db-p2p`); this ticket's requirement is that Sereus wires cohort-derived bootstrap peers and correct mode selection so strands have a working discovery seed regardless of DHT availability.

## Use cases

- Cold start / solo node: a node configures the first strand in a new control network, comes up in `bootstrap` mode, applies its schema, and accepts DML locally — without waiting on a non-existent cohort.
- Join existing cohort: a node discovers a strand via the control network, reads the cohort's `CadrePeer` rows, seeds its strand libp2p node with those peers, and converges via dialing + FRET gossip rather than relying on luck.
- Mixed path parity: discovery via `handleStrandAdded` and explicit `addStrand` yield the same mode and seeding behavior for equivalent inputs.

## References

- `packages/cadre-core/src/strand-instance-manager.ts:197-215` (empty `bootstrapNodes`, network forwarding)
- `packages/cadre-core/src/cadre-node.ts:382-391` (`handleStrandAdded`, no `mode`) vs `515-524` (`addStrand`, threads `mode`)
- `packages/cadre-core/src/types.ts:263-276` (`StartStrandConfig`, `mode`)
- `../optimystic` `db-p2p/src/libp2p-node-base.ts:301-305` (peerDiscovery: bootstrap + FRET only, no kadDHT)
- Related: `tickets/backlog/4-relay-bootstrap-infrastructure.md` (ops-level relay/bootstrap deployment — distinct from in-code cohort seeding) and `tickets/complete/1-wire-strand-storage-into-bootstrap-transactor.md` (bootstrap-mode persistent storage wiring).
- Docs: `docs/architecture.md` ("Strand Lifecycle" / "Strand Mode: Bootstrap vs Networked"), `docs/cadre-consistency.md`.
