description: Nothing tests the case the node-lending feature exists for: a phone, which can only make outgoing connections, asking a self-hosted machine for a node and then staying connected to it. Add an automated end-to-end test with a phone-like requester, a real lent node, a node restart and a requester restart.
prereq: donated-node-reachable-by-phone, owner-keeps-dialing-node-it-added
files: packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts (new), packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts (reference shape), packages/integration-tests/src/harness/node-fixtures.ts (controlNodeConfig, wsTransports, owner-genesis helper), packages/integration-tests/src/harness/control-trio.ts (makeOwnOwner usage, listen-less node), packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts (restart with preserved storage), docs/testing.md
----
# End-to-end: a phone-shaped requester borrows a cadre-host node

Split from `phone-adds-cadre-host-node-to-its-cadre`. This is the headless proof that the phone path works, so it runs in CI instead of only on a device.

## Terms

- **Lent node**: a node cadre-host spawns into someone else's cadre (`DonationService`, `docs/cadre-host.md` → Node donation).
- **Phone-shaped requester**: an in-process `CadreNode` with `listenAddrs: []`, WebSocket and circuit-relay transports only (`wsTransports()`), `profile: 'transaction'`, a persistent identity key, and owner genesis run on itself. The same shape as the React Native app (`reference-app-rn/src/phone-node-config.ts`) minus WebRTC, which Node tests do not load.

## What exists

`cadre-host-node-donation.integration.ts` drives `DonationService` in-process against a real `HostProcessOrchestrator` and a real cadre-cli child. Its requester is a second cadre-cli child that listens on TCP, and the lent node dials it. None of that exercises a requester that cannot be dialed.

## The scenario

Model it on the existing donation scenario: in-process `GrantService` + `DonationService` + `HostProcessOrchestrator` spawning real cadre-cli children. Steps run in order, each a separate `it` so a failure names its step:

1. **Requester up.** Start the phone-shaped `CadreNode`, make it its own owner (the owner-genesis helper in `harness/node-fixtures.ts` that `control-trio.ts` calls as `makeOwnOwner`). Assert `getMultiaddrs()` is empty. Give it a short `reconcileMs` (via `controlNodeConfig`) so reconnects land inside the test budget.
2. **Provision with no bootstrap nodes.** `provision({ grantToken, partyId, ownerKeys: [requester owner key], profile: 'storage' })` with `bootstrapNodes: []`. Assert `awaiting_seed` and that the record's `bootstrapNodes` is `[]`.
3. **Peer info carries a WebSocket address.** Poll `getPeer` until it answers; assert at least one multiaddr contains `/ws`.
4. **Authorize and seed.** `requester.addDrone({ dronePeerId, droneMultiaddrs })`, then poll `applySeed` until `seeded` (the existing scenario's pattern: the seed route can lag the node's `/status`).
5. **Requester dials in.** Call `requester.reconcileControlCohort()`, then wait for a requester-side connection to the lent node's peer id with `direction === 'outbound'` on the control node. Also poll the lent node's `/status` until `node.partyId` is the requester's party and `connectionPaths.total >= 1`.
6. **Both directions replicated.** Wait until `requester.resolvePeerAddrs(dronePeerId)` returns a non-empty list containing a `/ws` address. That can only happen if the requester's rows reached the lent node (so it found its own vouched row and self-published) and its signed row came back.
7. **Lent node respawn keeps its address.** Stop the child through the orchestrator, call `donationService.respawn(donationId)`, and assert `getPeer`'s `/ws` port equals the one from step 3. Wait for the requester to hold a new outbound connection to the same peer id without any further donation call.
8. **Requester restart reconnects without a new request.** Stop the requester and start a new `CadreNode` with the same identity key, the same storage provider instance (see `control-offline-read-after-restart.integration.ts` for keeping control storage across a restart) and the same bootstrap-peer store instance. Assert an outbound connection to the lent node returns, with no `provision`, `getPeer` or `applySeed` call in between.
9. **Terminate.** `terminate` and assert the node handle is gone, as the existing scenario does.

Use a port band no other scenario uses: `grep -rn "portRange: { start" packages/integration-tests/src`.

## Out of scope

Strand replication to the lent node. A cadre-cli node launches a strand only when an app has registered that strand's sApp config (`CadreNode.handleStrandAdded`), and nothing registers one on a lent node. Whether it should is `blocked/always-on-nodes-host-strands-of-apps-they-do-not-run`. Do not assert any strand behaviour here.

## Edge cases & interactions

- **The requester never becomes dialable.** Re-assert `getMultiaddrs()` is empty after step 5, so a regression that silently adds a listener cannot make the test pass for the wrong reason.
- **Dial direction.** The connection in steps 5, 7 and 8 must be outbound from the requester. A lent node dialing out would have nowhere to dial, but assert it anyway.
- **Mixed address list.** `getPeer` returns TCP and `/ws` addresses on loopback and LAN interfaces. The requester has no TCP transport, and the dial must still succeed over `/ws`. If it fails with "no valid addresses", that is a defect in `owner-keeps-dialing-node-it-added`, not something to work around by filtering in the test.
- **Gate ordering.** Step 5 relies on the lent node admitting a connection while its control database is empty. If the connection is admitted and then dropped, log both nodes' gate decisions (`DEBUG=sereus:*`) rather than adding sleeps.
- **Step 6 timing.** The lent node's self-publish follows the first replicated rows and its heartbeat. Poll with a generous budget, like the existing scenario's `STARTUP_MS`.
- **Step 7 with a long-lived requester connection.** The requester may still hold the dead connection `open` until its connection monitor notices (measured at ~9 s in `control-cohort-cold-start-retry.integration.ts`). Wait for a connection whose id differs from the pre-respawn one, not merely "a connection exists".
- **Step 8 exercises the signed-record path**, since the lent node's row is fresh. The retained-hint fallback for a stale row is covered by the unit specs in `owner-keeps-dialing-node-it-added`; do not try to age a record inside this scenario.
- **Windows workdir release** after terminate: reuse the existing scenario's `afterAll` cleanup tolerance.
- **Runtime.** Two cadre-cli spawns (provision and respawn) plus an in-process node. Keep under the runner's 10-minute idle window by streaming vitest output (`--reporter=verbose` is the package default).

## TODO

- Write `cadre-host-donation-phone-requester.integration.ts` with steps 1-9.
- Choose an unused port band.
- Build cadre-core, cadre-cli and cadre-host, then run the scenario alone from `packages/integration-tests`: `yarn workspace @serfab/integration-tests test src/scenarios/cadre-host-donation-phone-requester.integration.ts`. Run it three times in isolation and record the pass count in the review handoff.
- Add a line for the new scenario wherever `docs/testing.md` lists the cadre-host scenarios, and update the "proven end-to-end" sentence in `docs/cadre-host.md` → Status of the donation surface.
