description: A node waiting to be claimed by QR code builds and keeps a full control database for a placeholder cadre that it throws away the moment it is claimed; it only needs to receive one claim, so it could skip that database and its schema setup.
architecture: docs/architecture.md#seed-delivery-protocol
files: packages/cadre-core/src/cadre-node.ts (`start()` ~1360–1560, `isAwaitingClaim` ~1906, `refreshMembershipGate` on `seed-applied`, the claim admission paragraphs ~2641/~2717/~2846), packages/cadre-core/src/seed-bootstrap.ts (`initialize(controlNode, controlDatabase)`, `queryPeers`), packages/cadre-cli/src/commands/start.ts (`restartIntoClaimedParty`), packages/cadre-cli/src/commands/start-node.ts (`buildClaimedNode` doc: the placeholder's files are left behind)
tradeoffs: The placeholder database costs one schema apply and some disk at the node's first boot, not time on the claim itself (the claimed party's own schema apply after the restart is unavoidable), and skipping it means a second start-up shape in `CadreNode.start()` that every later change to start-up must keep working.
----
# An unclaimed node builds a control database it never uses

Found while planning `claimed-node-rejoins-without-waiting` (static, read from code; not measured).

## What happens

A node started with a claim secret (`CadreNodeConfig.claim`, `cadre start` with `CADRE_CLAIM_SECRET`) runs `CadreNode.start()` as any node does: it builds the control libp2p node, a `ControlDatabase` under the placeholder party (`unclaimed` by convention), applies the control schema cold, starts the strand watcher, and keeps polling. While `isAwaitingClaim()` its control-database streams and relay reservations are refused, so no sibling ever writes to that database. The only legitimate interaction is the claim seed on `/sereus/seed/1.0.0`, whose verification and merge (`SeedBootstrapService.verifyAndMergeSeed`) need the trust anchor and the libp2p node, not the database. On the claim, `cadre start` stops the node and builds a new one under the claimed party; the placeholder database's storage is left on disk and never opened again.

## What would change

A node that is awaiting a claim brings up the control libp2p node, the claim policy and the seed listener, and skips the control database, the strand watcher and the services that read the database, until it is claimed (and in `cadre start`, restarted).

## Questions the planner must settle

- What reads `controlDatabase` on an unclaimed node: the seed service's `initialize` signature, the membership gate refresh on `seed-applied`, the connection gater's admission decisions, `/status`, the admin channel. Each needs a "no database yet" answer.
- Whether a cadre-core embedder that does not restart on `claim:accepted` (none today; cadre-cli is the only one) must then bring the database up in place after the claim, or whether restarting becomes part of the claim contract.
- Whether the placeholder's leftover storage should also be removed after the claim (today `buildClaimedNode` leaves it, by design).
