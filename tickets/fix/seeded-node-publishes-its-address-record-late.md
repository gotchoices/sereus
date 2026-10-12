description: A node added to a cadre by a seed (a rented provider node, or a machine added with `cadre enroll add`) can take up to about seven and a half minutes to publish its own address record, so other members of the cadre cannot look up its address in that window.
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-cli/src/commands/start-node.ts, packages/integration-tests/src/scenarios/provider-drone-phone-requester.integration.ts, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts
repro: verified
----
# A seeded node publishes its address record on the heartbeat, not when its row arrives

## What happens

Every member keeps a signed address record of its own in its `CadrePeer` row, and the other members find its addresses from that record (`CadreNode.resolvePeerAddrs`). A node that cannot write its own row (it has no owner key, which is every provider node and every `cadre enroll add` machine) can only update a row an owner wrote for it. That row is written on the owner (`addDrone`) and reaches the new node by replication once the two connect, which is after the node booted.

`CadreNode` tries to publish at three moments, and on this path all three usually miss:

- once, about 1 s after `start()` (`scheduleSelfRegistration`), before anyone has seeded or dialed the node;
- once, when the control cohort first grows (the re-replication drain), at the moment of the first connection, before the row has replicated in;
- on the heartbeat, every 7.5 minutes (`DEFAULT_PEER_RECORD_HEARTBEAT_MS`), or on an address change (`self:peer:update`), which a provider node does not have.

The reconcile pass has a fourth try, `publishSelfRecordOnceClaimed`, which retries on every pass until the first publish lands, but only for a node started with a claim secret (`config.claim`).

## Observed

`provider-drone-phone-requester.integration.ts`, step 5, with the node's `sereus:cadre:node` debug log captured (2026-10-11):

- Run 1: the requester dialed in, the node admitted it and listed it as an authorized member, and `requester.resolvePeerAddrs(nodePeerId)` stayed empty for the full 90 s wait.
- Run 2: the seed arrived 0.74 s after the node's `CadreNode started successfully`. The drain's `registerSelf` skipped (`no readable CadrePeer row for self`) at +0.92 s, and the 1 s one-shot published (`refreshed own CadrePeer record`) at +1.37 s, after the row had replicated in. The record resolved on the requester within 1.5 s.

So the outcome depends on whether the seed and the first connection beat a 1-second timer. In production a phone delivers the seed seconds to minutes after the provider started the container, so the slow case is the normal one. The phone that rented the node is not affected, because it dials from the addresses `addDrone` retained. Any other member that needs the node's address (a second device, a strand address lookup) waits up to 7.5 minutes.

## Where it changes

`CadreNode.publishSelfRecordOnceClaimed` in `packages/cadre-core/src/cadre-node.ts` and the condition it checks. The NOTE in `startRecordRefresh` already names this case: "If late enrollment becomes the normal path for other nodes too … drop that method's claim condition rather than lengthening this list of triggers." A seeded node is late enrollment by construction. The NOTE on `claimConfigFor` in `packages/cadre-cli/src/commands/start-node.ts` suggests keying the method on the trusted-owner anchor's source instead of the config, and should be settled by the same change.

## What the fix has to weigh

The reconcile pass trying `registerSelf` until the first publish lands costs, for a node that has no row yet, one `CadrePeer` read and one address collection per pass (15 s). The bigger cost is that the first publish is a background `CadrePeer` UPDATE:

- **Dropping the claim condition outright** makes every non-owner member publish within one pass of its row arriving. That covers the `B` nodes of `bootPair` and every seeded member of `control-trio.ts` and `topology.ts`, which today often never publish during a test. `blocked/forked-control-collection-sync-livelocks` already suspects a background self-registration write of racing a foreground `CadrePeer` write on a lone node, so the integration suite should be run in full, under load, before and after.
- **Narrowing it to nodes that accepted a seed this session** (both seed paths end in `recordSeedBootstrapPeers`) still reaches the `control-trio.ts` and `topology.ts` members, but not `bootPair`. It misses a seeded node restarted before its row replicated in. Measure what that costs before deciding.

## Done when

- The NOTE in `provider-drone-phone-requester.integration.ts` step 5 is replaced by the assertion it describes: `requester.resolvePeerAddrs(nodePeerId)` resolves, with a `/ws` address, within one node reconcile pass. The step delivers the seed later than the node's 1 s one-shot publish (for example, once the node's `/status` uptime has passed a few seconds), so the assertion cannot pass by the timing of run 2.
- `node-claim-by-phone`'s header paragraph about `publishSelfRecordOnceClaimed`, and the NOTEs in `startRecordRefresh` and `claimConfigFor`, describe the new rule.
