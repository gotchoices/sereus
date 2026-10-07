description: Rebuilt cadre-host's router port mapping so it covers every node the host runs (both the TCP port and the WebSocket port a phone dials), lets the user enter ports they forwarded by hand, and reports per node whether it can be reached from outside the home network. Implemented and reviewed.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/port-mapper.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-host/src/nat/nat-store.ts, packages/cadre-host/src/nat/reachability.ts, packages/cadre-host/src/nat/types.ts, packages/cadre-host/src/nat/index.ts, packages/cadre-host/src/nat/__tests__/, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/routes/nat.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-host/src/server/routes/settings.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/server/events/types.ts, packages/cadre-host/src/server/__tests__/, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/owner/owner-node-client.ts, packages/cadre-host/src/index.ts, packages/cadre-host/ui/src/components/ConnectivityBadge.svelte, packages/cadre-host/ui/src/lib/overall-status.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/lib/router.ts, packages/cadre-host/ui/src/App.svelte, packages/cadre-host/ui/src/routes/Connectivity.svelte, packages/cadre-host/ui/src/routes/Home.svelte, packages/integration-tests/src/harness/test-cadre-host.ts, packages/integration-tests/src/scenarios/cadre-host-bootstrap.integration.ts, packages/integration-tests/src/scenarios/cadre-host-sse-events.integration.ts, packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, packages/cadre-host/README.md, docs/cadre-host.md, docs/architecture.md, docs/reference-app-rn.md
difficulty: hard
----

# NAT mappings per hosted node — complete

First of three tickets (`cadre-host-nat-per-node-mappings` → `cadre-host-nodes-announce-public-addresses` → `cadre-host-node-reachability`). This one rebuilt the router side and the status model. Implemented in `ticket(implement): cadre-host-nat-per-node-mappings`; the review pass is recorded below.

## What landed

- **Router adapter** (`nat/port-mapper.ts`): `UpnpPortMapper` over `@achingbrain/nat-port-mapper` v4 (`upnpNat()` → `findGateways` → `gateway.map/unmap/externalIp`). Discovery takes the first IPv4 gateway within 10 s; the LAN address is the local IPv4 interface whose subnet contains the router (`pickLanAddress`, via `net.BlockList`). Every router call has a 10 s bound from `AbortController` plus a timer (the repo lint bans `AbortSignal.timeout`). `stop()` forgets the gateway and deliberately does not call the library's `gateway.stop()`, which would delete every mapping.
- **Mapping table** (`nat/nat-service.ts`): one entry per node id with a `PortRoute` for `tcp` (`NodePorts.p2p`) and `ws` (`NodePorts.ws`, null for an older handle). Reconcile passes against the orchestrator's `listNodes()` run at start, on every `onStateChange` event and on a 1-minute timer; renewal passes every 30 minutes; a 5-minute probe pass re-detects the external IP and, while UPnP is on and no router has answered, searches for one again. All passes are serialized on one promise tail. Manual wins over UPnP; each mapping fails alone; a node stopped past `NAT_UNMAP_GRACE_MS` (3 min) is unmapped; a node gone from the list is unmapped at once and its forward deleted; `stop()` unmaps nothing; UPnP off releases UPnP routes only.
- **Manual forwards**: `nat.json` gains `forwards` and loses `externalPort`/`internalPort` (an old file still loads; the next save drops them). `NatStore.setForward`/`deleteForward`; `NatService.putForward`; `PUT /nat/nodes/:nodeId/forward` with `404 unknown_node` and `400 invalid_config`.
- **Public addresses** (`nat/address-resolver.ts`): `buildPublicAddresses` plus `isPublicIpv4`; `NatService.publicAddressesFor(nodeId, ports)` predicts the identity mapping for an unmapped port when UPnP is on and a gateway was found, never for a port whose attempt failed.
- **Status model** (`nat/types.ts`, `nat/reachability.ts`): `NatStatusSnapshot` with `gateway`, `nodes: NodeReachability[]` (per-node verdict, plain-language reason, `running`), and the host roll-up `directReachability`. `PortForwardMode` and the host-level port fields are gone.
- **Every role**: `NatService` takes `rootDir` and `nodeSource` (the orchestrator), is constructed in `bin/host.ts` right after `orchestrator.init()` and started before the owner node spawn and before `DonationSupervisor.start()`. `createLocalUiServer` takes `nat` as a required option; `FounderServices` is `{ strands }`; `/nat/*` always mounts; `nat.onChange` publishes `connectivity-changed` (payload: `directReachability` only). The invite-address push and the owner-node dependency of the NAT service are deleted.
- **Orchestrator**: `removeContainer` emits one more `stopped` state change after deleting the handle, so a terminated node is unmapped at once. Listeners see a `stopped` for a node no longer in `listNodes()`; the donation supervisor's pass finds the record terminal and skips.
- **UI, CLI, docs**: Connectivity page and Home tile in every role; a read-only per-node list until the third ticket's table and form; `nat settings` keeps only `--upnp`/`--no-upnp`; `printNatStatus` prints one block per node. `docs/cadre-host.md` NAT section rewritten; donor-role statements that `/nat/*` is unmounted removed from the doc, the README and `docs/architecture.md`.

## Review findings

Reviewed from the implement commit's diff first, then the handoff. Checked by reading: the adapter against the installed library's source (`dist/src/upnp/*.js`, `@achingbrain/ssdp`), the mapping table's state machine on every trigger (start, spawn, stop inside and past the grace, removal, respawn with the same ports, respawn with other ports, manual set and cleared, UPnP toggled both ways, lease expiry, failed renewal), the serialization of passes, the interaction of the new `removeContainer` event with the donation supervisor and the SSE bus, the status assembly and change signature, the routes and their error mapping, the UI state and pages, the CLI printer, the integration harness, and every doc the change touched or should have touched. Checked by running: the cadre-host unit suite, the build (server + UI) with the Svelte check, lint, both typechecks, and the three cadre-host integration scenarios that build a server.

### Defects found and fixed in this pass (minor)

- **A node spawned during an event-triggered pass waited for the 1-minute timer.** `queueEventPass` kept its "queued" flag set until the pass finished, so a state change arriving while a pass was running was dropped. The flag is now cleared when the pass starts, so an event during a running pass queues exactly one more pass (bursts still coalesce). Pinned by a new test that spawns a second node from inside the fake router's `map`; it fails against the previous code (verified) and passes now.
- **No gateway rediscovery after a failed start.** Discovery ran only at start, on a UPnP toggle and on `nat test`, so a host whose service starts before its network (the normal boot order for a service) never mapped anything until a restart. The 5-minute probe pass (`NatService.redetect`, which also re-detects the IP) now searches again while UPnP is on and no router has answered, and maps the running nodes as soon as one does. The `NOTE:` that parked this is gone; pinned by a test.
- **A router-only IP probe flipped the CGNAT flag.** `detectIp` kept the previous result only when both probes found nothing; a result with the router's answer and no public echo replaced a previous CGNAT verdict, so a transient failure of the public probe read a carrier address as the host's and marked every node "public address unknown". A detection that lost the public echo now keeps the previous result too; the existing keep-previous test was extended to cover it.
- **`PUT /nat/nodes/:nodeId/forward` with a non-object JSON body threw a `TypeError` (500).** The route applied `in` to whatever the body parsed to. It now hands the body to the service, whose validation refuses a non-object (arrays included) with `400 invalid_config`; the route's key-copying was redundant since the store reads only `tcp` and `ws`.
- **Stale docs and comments.** `docs/architecture.md` still said the founder role includes NAT, the `nat` CLI is founder-only, `OwnerNodeClient` backs a NAT shape and pushes invite addresses, and the NAT layer does NAT-PMP; all four bullets rewritten. `packages/cadre-host/README.md`, `server/routes/grants.ts` and `cadre-host-node-donation.integration.ts` still cited the pruned ticket `feat-cadre-host-wan-grant-reachability` (it is in neither the board nor `tickets/.pruned-tickets.jsonl`); replaced with plain statements that the `/grants` request surface stays loopback-only while the lent nodes' ports are mapped. `docs/cadre-host.md` still named a "UPnP/NAT-PMP gateway" in the IP-detection section; its UPnP-gateway and IP-detection paragraphs now also state the rediscovery cadence and the keep-previous rule above.

### Tests

- Cut the `createNatHandlers` "every handler delegates" test: pure glue over a six-line wrapper.
- Added the two tests named above (event-pass coalescing, late router) and extended the keep-previous IP test to the CGNAT case. Everything else the implementer wrote pins real branching (per-port failure isolation, assigned external port, grace, manual-over-UPnP, CGNAT, reason wording, store migration, LAN-address pick) and stays.

### Tripwires recorded as `NOTE:` at the site

- `port-mapper.ts` `findIpv4Gateway`: the library searches for `InternetGatewayDevice:2` only, and a version-1-only router does not answer a version-2 search, so it reads as "not found"; there is no library option for it. Also stated in the doc's "UPnP gateway" subsection, since it is what a user would see.
- `port-mapper.ts` `unmap`: the library appends one tracked entry per successful `map` of a port, so after N renewals an unmap sends N deletes under the one 10 s bound (the first delete is the one that counts).
- `nat-service.ts` class doc: the file holds the settings/DDNS glue, the mapping table and the status assembly together (about 850 lines, measured with `wc -l`); the next capability added here should move the mapping table into its own module. Not filed: the package's orchestrator and donation service are larger, and the next two tickets in the chain edit this file next.
- Kept from the implement pass: `mapRoute` (a router that stops answering costs 10 s per attempt, passes queue rather than overlap) and `stop()` (unmaps nothing by design).

### Accepted as is (considered, not changed)

- `removeContainer` emitting a second `stopped` event: the supervisor's handler re-reads the record, which every terminal path writes before reclaiming, and the only other `removeContainer` caller is that same reclaim; the SSE bus publishes a second `node-state-changed: stopped`, which the SPA already tolerates (it was publishing one for the stop inside the removal before).
- `onChange` firing on any snapshot change rather than the four the ticket listed: the extra cases (UPnP toggle, gateway loss) are changes the UI should follow; the SSE scenario asserts the new behaviour.
- `evaluateHostReachability` answering `cgnat` with no running nodes: matches the order of the ticket's roll-up table.
- `forgetMissingNodes` deleting a manual forward for a node that vanished while the host was down: the node is gone with it.

### Not verified

- **No real router.** The adapter was checked against the library's source only: `map()` returns `NewReservedPort`, `ttl` is milliseconds floored at 3600 s, `unmap` deletes this process's mappings by internal port, `map()` for a private LAN address makes one extra `GetExternalIPAddress` call under the same bound. A hand test on a UPnP router (`cadre-host start` with a node, then `cadre-host nat status`) is the obvious next check and is still outstanding.
- `cadre-host-owner-node.integration.ts` (a founder scenario with a real `cadre-cli` child) type-checks but was not run; its only change is the removed push test.

## Validation (review pass)

| Command | Result |
|---|---|
| `yarn workspace @serfab/cadre-host typecheck` | clean |
| `yarn workspace @serfab/integration-tests typecheck` | clean |
| `yarn lint` | clean |
| `yarn workspace @serfab/cadre-host test` | 64 files, 622 passed, 4 skipped (pre-existing skips) |
| `yarn workspace @serfab/cadre-host build` + `check:svelte` | clean, 0 errors |
| `vitest run cadre-host-bootstrap cadre-host-sse-events cadre-host-donation-phone-requester` (integration-tests) | 3 files, 15 passed |

Logs: `tickets/.logs/2-cadre-host-nat-per-node-mappings.review.{unit,integration}.log`.

## Next

- `cadre-host-nodes-announce-public-addresses` (implement/): each node announces `publicAddressesFor` at spawn and restarts when it changes.
- `cadre-host-node-reachability` (implement/): the per-node table, the manual-forward form and `cadre-host nat forward`. Until it lands a forward is entered with `PUT /nat/nodes/:nodeId/forward`, which the README says.
