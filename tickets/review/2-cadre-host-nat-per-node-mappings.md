description: Rebuild cadre-host's router port mapping so it covers every node the host runs (both the TCP port and the WebSocket port a phone dials), lets the user enter ports they forwarded by hand, and reports per node whether it can be reached from outside the home network. Implemented; this is the review handoff.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/port-mapper.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-host/src/nat/nat-store.ts, packages/cadre-host/src/nat/reachability.ts, packages/cadre-host/src/nat/types.ts, packages/cadre-host/src/nat/index.ts, packages/cadre-host/src/nat/__tests__/, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/routes/nat.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-host/src/server/routes/settings.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/server/events/types.ts, packages/cadre-host/src/server/__tests__/, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/owner/owner-node-client.ts, packages/cadre-host/src/index.ts, packages/cadre-host/ui/src/components/ConnectivityBadge.svelte, packages/cadre-host/ui/src/lib/overall-status.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/lib/router.ts, packages/cadre-host/ui/src/App.svelte, packages/cadre-host/ui/src/routes/Connectivity.svelte, packages/cadre-host/ui/src/routes/Home.svelte, packages/integration-tests/src/harness/test-cadre-host.ts, packages/integration-tests/src/scenarios/cadre-host-bootstrap.integration.ts, packages/integration-tests/src/scenarios/cadre-host-sse-events.integration.ts, packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, packages/cadre-host/README.md, docs/cadre-host.md, docs/architecture.md, docs/reference-app-rn.md
difficulty: hard
----

# NAT mappings per hosted node — review handoff

First of three tickets (`cadre-host-nat-per-node-mappings` → `cadre-host-nodes-announce-public-addresses` → `cadre-host-node-reachability`). This one rebuilt the router side and the status model. Treat it as a starting point: the UPnP adapter was written against the library's typings and source, not against a router.

## What was built

- **Router adapter** (`nat/port-mapper.ts`): `UpnpPortMapper` over `@achingbrain/nat-port-mapper` v4 (`upnpNat()` → `findGateways` → `gateway.map/unmap/externalIp`), statically imported. Discovery takes the first IPv4 gateway within 10 s; the LAN address is the local IPv4 interface whose subnet contains the router (`pickLanAddress`, via `net.BlockList`). Every router call has a 10 s bound built from `AbortController` plus a timer, because the repo lint bans `AbortSignal.timeout`. `stop()` forgets the gateway and deliberately does not call the library's `gateway.stop()`, which would delete every mapping.
- **Mapping table** (`nat/nat-service.ts`): one `NodeEntry` per node id with a `PortRoute` for `tcp` (`NodePorts.p2p`) and `ws` (`NodePorts.ws`, null for an older handle). Reconcile passes against the orchestrator's `listNodes()` run at start, on every `onStateChange` event, and on a 1-minute timer; renewal passes run every 30 minutes; the external IP is re-detected every 5 minutes. All passes are serialized on one promise tail. Manual wins over UPnP; each mapping fails alone; a node stopped past `NAT_UNMAP_GRACE_MS` (3 min) is unmapped; a node gone from the list is unmapped at once and its forward deleted; `stop()` unmaps nothing; UPnP off releases UPnP routes only.
- **Manual forwards**: `nat.json` gains `forwards` and loses `externalPort`/`internalPort` (an old file still loads; the next save drops them). `NatStore.setForward`/`deleteForward`; `NatService.putForward`; `PUT /nat/nodes/:nodeId/forward` with `404 unknown_node` and `400 invalid_config`.
- **Public addresses** (`nat/address-resolver.ts`): `buildPublicAddresses` plus `isPublicIpv4`; `NatService.publicAddressesFor(nodeId, ports)` predicts the identity mapping for an unmapped port when UPnP is on and a gateway was found, and never for a port whose attempt failed.
- **Status model** (`nat/types.ts`, `nat/reachability.ts`): the new `NatStatusSnapshot` with `gateway`, `nodes: NodeReachability[]`, per-node verdict and plain-language reason, and the host roll-up. `PortForwardMode` and the host-level port fields are gone.
- **Every role**: `NatService` takes `rootDir` and `nodeSource` (the orchestrator), is constructed in `bin/host.ts` right after `orchestrator.init()` and started before the owner node spawn and before `DonationSupervisor.start()`. `createLocalUiServer` takes `nat` as a required option; `FounderServices` is `{ strands }`; `/nat/*` always mounts; `nat.onChange` publishes `connectivity-changed` (payload: `directReachability` only). The invite-address push (`getInviteAddresses`, `onAddressesChanged`, `pushInviteAddresses`, `CadreNodeLike`, the `node_unavailable` NAT code) is deleted; `OwnerNodeClient` keeps its identity reads.
- **UI**: Connectivity page and Home tile in every role; badge driven by `directReachability`; the external-port field is gone; a read-only per-node list (id, verdict, both routes, public addresses, reason) stands in until the third ticket's table and form.
- **CLI**: `nat settings` has only `--upnp`/`--no-upnp`; `printNatStatus` prints the host lines and one block per node.
- **Docs**: `docs/cadre-host.md` NAT section rewritten (Port mapping, UPnP gateway, Reachability verdict, Public addresses per node, Process integration); donor-role statements that `/nat/*` is unmounted removed in the doc and the README; the orchestrator's child-env `NOTE:` updated; stale references to the pruned `feat-cadre-host-wan-grant-reachability` ticket replaced in `docs/architecture.md` and `docs/reference-app-rn.md`.

## Decisions a reviewer should weigh

- **`removeContainer` now emits a state change.** The ticket wants a terminated node unmapped "at once", but the orchestrator fired nothing on removal, and the `stopped` event from the stop inside `removeContainer` fires before the handle is deleted, so a pass triggered by it still saw the node. `HostProcessOrchestrator.removeContainer` now emits one more `stopped` event after deleting the handle (`host-process-orchestrator.ts`, with a comment). Listeners see a `stopped` for a node no longer in `listNodes()`; the donation supervisor's pass finds the record terminal and skips, and the SSE bus publishes a second `node-state-changed: stopped`, which the UI tolerates.
- **`NodeReachability.running` was added** beyond the ticket's interface so a stopped node inside the grace (still listed, routes kept) is not read as "unreachable while running". The CLI prints `[stopped]`, the UI shows a badge, and the roll-up ignores stopped nodes.
- **`onChange` fires on any snapshot change**, not only the four the ticket lists: it compares the snapshot minus timestamps and lease expiry, so a UPnP toggle or a gateway loss also fires. Consequence: a `PUT /api/settings { upnpEnabled }` now reaches SSE clients through this listener; the SSE integration scenario that asserted the opposite was rewritten to assert the new behaviour.
- **A failed renewal keeps the route until the lease runs out** (error recorded, route still advertised), because the router still holds the mapping; an expired UPnP route then reads as no route and the next reconcile pass re-requests it. A first attempt that fails is not retried until the next renewal pass or `testReachability`, which is what "a port whose mapping attempt has failed is not predicted" relies on.
- **The integration harness uses an offline NAT service** (`startOfflineNatService`: a mapper that finds no gateway, a detector whose fetch throws) so no test waits out a 10 s SSDP search or calls ipify. The phone-requester scenario builds its donor-mode server with one too, since `nat` is now required.
- **The README "Reachability" section moved out of the founder section** and now tells the user the forward route is the management API until the third ticket's CLI and form land.

## Tests added (each beside what it pins)

- `nat/__tests__/nat-service.test.ts` (rewritten, 17 tests): both ports of every running node are mapped and `stop()` unmaps nothing; a router that caps its mappings fails per port and the other node's routes survive a renewal (the ticket's cap test); the assigned external port lands in the route and the addresses; a handle without `ws` maps TCP only; a terminated node is unmapped at once and its forward deleted; the stop grace (inside: mapping kept; past: released; respawn: re-mapped) with the injected clock; manual wins and is re-requested when cleared; `unknown_node` / `invalid_config`; UPnP off releases UPnP routes and keeps manual ones; identity-mapping prediction before a mapping exists and not after a failure; no prediction without a gateway, manual regardless; DDNS hostname as host part; CGNAT (UPnP routes yield nothing, roll-up `cgnat`, manual still counts); a failed re-detection keeps the last IP; `onChange` fires on change and not on an idle pass; unknown DDNS provider; handlers delegate.
- `nat/__tests__/address-resolver.test.ts`: table-driven `buildPublicAddresses` (DDNS vs public IP vs private IP vs IPv6 vs none; assigned port; missing route; missing `ws`; CGNAT with UPnP and with manual) plus `isPublicIpv4` ranges.
- `nat/__tests__/reachability.test.ts`: per-node verdict rules and reason wording (refused, UPnP off with two ports, no gateway with no LAN address, pending, CGNAT) and the host roll-up table.
- `nat/__tests__/nat-store.test.ts`: defaults, an old file with the single-port fields loads and the next save drops them, `setForward`/`deleteForward`, port validation.
- `nat/__tests__/port-mapper.test.ts`: `pickLanAddress` picks the interface on the router's subnet past loopback, Docker and VPN interfaces, and null when none matches. (Replaces the removed `PortMapperService` tests.)
- `server/__tests__/publishers.test.ts`: `NatService.onChange` → `connectivity-changed`.
- `server/__tests__/server.smoke.test.ts`: `/nat/status` serves in the donor role; `/api/strands` still 404s there.
- Updated to the new shapes: `status-route`, `strands-route`, `sse-route`, `fakes.ts`, `cli-nat.smoke`, `owner-node-client` (push test removed), UI `overall-status` and `api` tests.

## Validation run

| Command | Result |
|---|---|
| `yarn workspace @serfab/cadre-host typecheck` | clean |
| `yarn workspace @serfab/cadre-host build` (server + UI) | clean |
| `yarn workspace @serfab/cadre-host check:svelte` | 0 errors |
| `yarn workspace @serfab/cadre-host test` | 63 files, 619 passed, 4 skipped (pre-existing skips) |
| `yarn lint` | clean |
| `yarn workspace @serfab/integration-tests typecheck` | clean |
| `vitest run cadre-host-bootstrap cadre-host-sse-events` | 7 passed |
| `vitest run cadre-host-donation-phone-requester` | 8 passed |

Logs: `tickets/.logs/2-cadre-host-nat-per-node-mappings.{unit,integration,phone-requester}.log`.

## Known gaps

- **Not run against a router.** `UpnpPortMapper` is by inspection of `node_modules/@achingbrain/nat-port-mapper/dist/src/upnp/*.js`: `findGateways` yields `InternetGatewayService4`/`6`, `map()` returns `NewReservedPort` from `AddAnyPortMapping`, `ttl` is milliseconds floored at 3600 s, `unmap` deletes only this process's mappings and passes the internal port as the external one. A hand test on a real UPnP router (`cadre-host start` with a node, then `cadre-host nat status`) is the obvious next check.
- **`cadre-host-owner-node.integration.ts`** had its `pushInviteAddresses` test removed but was not re-run (a founder scenario with a real `cadre-cli` child); it type-checks. `cadre-host-node-donation.integration.ts` was not run either; it does not build a server.
- **Discovery is not retried on the timer** — only at start, on a UPnP toggle and on `nat test`. Parked as a `NOTE:` in `NatService.start()`.
- **A router that stops answering** costs each attempt its 10 s bound, so a pass over N ports can take 10 s × N; passes queue rather than overlap. Parked as a `NOTE:` on `mapRoute`.
- **Library unmap limits** (previous process's mappings and reassigned external ports expire rather than being deleted): a `NOTE:` on `UpnpPortMapper.unmap` and a sentence in the doc's "UPnP gateway" subsection.
- The third ticket owns the per-node table, the manual-forward form and `cadre-host nat forward`; until then a forward is entered with `PUT /nat/nodes/:nodeId/forward`, which the README says.
