description: When an owner adds a machine with a seed while it has no connection, the owner's first connection makes it re-sign the new machine's membership row, and the new machine then rewrites the same row with its own address record a moment later; when that connection is to the new machine itself, the first rewrite is wasted.
architecture: docs/architecture.md#enrollment-flow-server-adds-drone
files: packages/cadre-core/src/cadre-node.ts (`runDrainControlReplication` step 4 `drainPendingPeerWrites` ~5011, `reconstructAuthoredMembership` ~4960, `handleControlConnectionChange` ~5072, `addDrone` ~9639), packages/cadre-core/src/seed-bootstrap.ts (`addDrone` ~1442, `authorizePeer` ~423, `reauthorizePeer`)
tradeoffs: The re-sign is what spreads a membership write the owner made with no connection, so skipping it for the new machine relies on that machine publishing its own record soon, and the saving is one row commit per seeded join, which is rare compared with invitation joins.
----
# A seeded machine's row is re-signed right before it publishes its own

## What happens (traced from code during `plan/new-machine-self-record-written-once`; not measured)

1. Owner A adds machine B with `addDrone` (or `addPhoneWithRelay`). `SeedBootstrapService.authorizePeer` inserts B's `CadrePeer` row with a null `Sig`. A phone owner usually has no control connection then, so the insert commits only on A and `noteControlWrite` queues it for re-sending.
2. The seed reaches B, usually out of band (QR code, paste, provider), so A gets no acknowledgement it could read a record from.
3. A's first connection of any kind, whether a relay, a bootstrap node or B, starts the write-while-alone drain (`handleControlConnectionChange` → `drainPendingControlReplication`). Step 4 (`drainPendingPeerWrites`) re-signs B's row (`reauthorizePeer`, an owner re-vouch that bumps `UpdatedAt`) because its `Sig` is still null. That is one commit to the row's cohort.
4. When B holds the row (after the peer-join block push), its first connected reconcile pass publishes its signed record, a second commit to the same row.

When the connection in step 3 is to B, step 3's commit reaches only A and B, and step 4 follows within one reconcile pass. When the connection is to another member, step 3 is the only way that member learns B's row before B connects, and it is needed.

## What would change

Skip the step-3 re-sign for a queued row whose machine is the peer whose connection started the drain, and leave the row queued until that machine's own publish lands (its `Sig` becomes set and the existing skip at ~5038 drops it). The re-sign still runs on a later growth edge if the machine never publishes.

## Questions the planner must settle

- Whether the drain's growth edge can be attributed to one peer at all: `handleControlConnectionChange` reacts to `getConnections().length > 0`, which counts relays and bootstrap nodes (see `backlog/control-rereplication-broadcast-confirmation` and `backlog/bug-seed-connection-counted-as-a-control-connection`).
- Whether leaving the entry queued is safe while the drain only fires on the 0 → ≥1 edge (an entry left behind is not looked at again until a full disconnect and reconnect).
- The claim path (`claimNode` → `vouchPeer`) has the same shape and is owned by `plan/claimed-node-rejoins-without-waiting`. Settle the two together if both are picked up.
