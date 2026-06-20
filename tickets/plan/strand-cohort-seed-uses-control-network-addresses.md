description: The cohort-derived strand `bootstrapNodes` seed is built from `CadrePeer.Multiaddr` rows, but those rows store each peer's CONTROL-network listen address (written by `registerSelf`), while the seed is fed into the per-strand libp2p node (`strand-<id>`, a separate instance on a different random port). Even though control and strand nodes share a peerId (same `config.privateKey`), dialing a control address reaches the remote's control libp2p instance, not its strand instance — so the seed does not actually join the strand network. Decide how strand-network addresses are published/discovered.
files: packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, docs/architecture.md
difficulty: hard
----

## Problem

`deriveCohortSeed(peers, selfPeerId)` (`strand-cohort.ts`) derives a strand's libp2p
`bootstrapNodes` list from `ControlDatabase.queryCadrePeers()` — i.e. from the
`CadreControl.CadrePeer` table. Those rows are populated by `registerSelf`
(`cadre-node.ts:360-388`, currently an authorization-gated no-op) from
`this.controlNode.getMultiaddrs()` — the **control** node's listen addresses.

But the seed is passed to `StrandInstanceManager.startStrand` →
`createLibp2pNode({ networkName: 'strand-<id>', bootstrapNodes, ... })`
(`strand-instance-manager.ts:200-218`) — a **separate** libp2p node bound to a
random port, distinct from the control node.

Control and strand nodes are created with the same `config.privateKey`
(`cadre-node.ts:318` and `:550`), so they share a peerId. A bootstrap multiaddr
like `/ip4/H/tcp/<controlPort>/p2p/<peerId>` therefore resolves to a matching
peerId but at the **control** node's address — dialing it connects to the
remote's control libp2p instance, not its strand instance. The strand mesh is
not actually seeded.

This is **latent today**: `registerSelf` writes no rows, so `deriveCohortSeed`
returns an empty seed and the bug cannot manifest. It becomes real the moment
self-registration starts writing `CadrePeer` rows (and `selectStrandMode` will
then also flip strands to `networked` on the discovery path).

## Why this wasn't fixed in the originating ticket

`bootstrap-dht-discovery-and-strand-cohort-wiring` (now complete) was scoped to
"feed the right `mode` and `bootstrapNodes` in" from whatever `CadrePeer` rows
exist, and explicitly scoped OUT both `registerSelf` row-writing and the
upstream Kademlia DHT absence in optimystic `db-p2p`. The mode-selection and
seed-derivation logic it added are correct; this ticket is about *which
addresses* feed the strand mesh, which is a deeper design question.

## What to decide / specify

- How does a node make its **strand-network** address discoverable to cohort
  peers? Options to weigh: publish per-strand multiaddrs (separate column /
  table), run a single multiplexed libp2p node per process so the control
  address genuinely reaches strand protocols, rely on relay/circuit addresses,
  or lean entirely on FRET gossip + a future DHT for strand-peer discovery.
- Whatever is chosen, `registerSelf` (when implemented) and `deriveCohortSeed`
  must agree on the address namespace so a non-empty seed actually joins the
  strand mesh.
- Coordinate with the deferred `registerSelf` authorization work and the
  DHT-absence concern; this is the third leg of the same discovery story.
