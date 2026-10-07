description: Rebuild cadre-host's router port mapping so it covers every node the host runs (both the TCP port and the WebSocket port a phone dials), lets the user enter ports they forwarded by hand, and reports per node whether it can be reached from outside the home network. Today it maps one port for the host's own node only, and its router code does not work with the library version installed.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/port-mapper.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-host/src/nat/nat-store.ts, packages/cadre-host/src/nat/reachability.ts, packages/cadre-host/src/nat/types.ts, packages/cadre-host/src/nat/index.ts, packages/cadre-host/src/nat/__tests__/, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/routes/nat.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-host/src/server/routes/settings.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/server/events/bus.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/index.ts, packages/cadre-host/ui/src/components/ConnectivityBadge.svelte, packages/cadre-host/ui/src/lib/overall-status.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/routes/Connectivity.svelte, packages/cadre-host/ui/src/routes/Home.svelte, packages/integration-tests/src/harness/test-cadre-host.ts, packages/integration-tests/src/scenarios/cadre-host-bootstrap.integration.ts, packages/integration-tests/src/scenarios/cadre-host-sse-events.integration.ts, packages/cadre-host/README.md, docs/cadre-host.md
difficulty: hard
----

# NAT mappings per hosted node

First of three tickets that make every node cadre-host runs reachable from outside the home network (`cadre-host-nat-per-node-mappings` → `cadre-host-nodes-announce-public-addresses` → `cadre-host-node-reachability`). This one owns the router side and the status model. The next one makes each node advertise the resulting public addresses; the last one adds the CLI and UI for manual forwards and per-node status.

## Current state (what is wrong)

- `NatService` maps exactly one TCP port (`nat.json` → `externalPort`/`internalPort`, seeded from `libp2pPort` by the installer's `seedNatSettings`), for the founder's owner node only. It is constructed only when `ownCadre.enabled`; in the donor role `/nat/*` is unmounted. No WebSocket port is mapped for any node, and a phone has no TCP transport, so a phone off the LAN reaches no node the host runs.
- **The UPnP adapter does not match the installed library.** `package.json` pins `@achingbrain/nat-port-mapper ^4.0.0` (4.0.5 installed). In v4, `upnpNat()` is synchronous and returns `{ findGateways, getGateway }`; mapping, unmapping and `externalIp()` live on a `Gateway` (`gateway.map(internalPort, internalHost, options)` → `PortMapping`). `NatPortMapperAdapter` in `port-mapper.ts` awaits `upnpNat()` and calls `client.map({ localPort, … })` / `client.externalIp()`, which do not exist on that object, so every mapping fails with a `TypeError` that is caught and reported as `mapping_failed`. Confirmed from `node_modules/@achingbrain/nat-port-mapper/dist/src/index.d.ts`; not run against a router.
- `PortForwardMode` carries `'auto-natpmp'`, but nothing ever performs NAT-PMP. NAT-PMP is deferred (`backlog/feat-cadre-host-nat-pmp-mapping`).
- `NatService` pushes "invite addresses" to the owner node over its admin channel (`getInviteAddresses`, `onAddressesChanged`, `pushInitialAddresses`, `CadreNodeLike`), which ties the service to the owner node. The next ticket replaces that with announce addresses passed to every node at spawn, so the push goes away here.

## Design

### Router adapter (`port-mapper.ts`)

Rewrite the adapter against the v4 API:

- **Gateway discovery.** `upnpNat({ description: 'sereus-cadre-host', autoRefresh: false })`, then take the first IPv4 gateway from `findGateways({ signal: AbortSignal.timeout(GATEWAY_DISCOVERY_TIMEOUT_MS) })` (10 s). No gateway within the timeout = UPnP unavailable (status says so; manual forwards still work).
- **LAN address.** `gateway.map` needs the host's LAN address. Pick the `os.networkInterfaces()` IPv4 entry whose subnet contains `gateway.host`, using Node's `net.BlockList` (`addSubnet(address, prefix)` from the entry's `cidr`, then `check(gateway.host)`). Do not use `mapAll`: it maps on every local address, leaving stray mappings for VPN and container interfaces. The chosen address is reported in status, since it is the address a user forwards to.
- **Map.** `gateway.map(internalPort, lanAddress, { externalPort: internalPort, protocol: 'tcp', ttl, autoRefresh: false })`. Ask for the same external port as the internal one; the router may assign another (IGDv2 `AddAnyPortMapping` returns `NewReservedPort`), and the mapping's **returned** `externalPort` is the one recorded and advertised. Check the units of `ttl` in the v4 typings (`mapPort` divides it by 1000 and floors it at 3600 s).
- **Unmap** by internal port (`gateway.unmap(internalPort)`), **external IP** via `gateway.externalIp()`.
- Library auto-refresh stays off; cadre-host renews leases itself so it can report lease expiry and per-mapping failures.

Keep `PortMapper` an interface so tests inject a fake. Its shape changes to: `discover()` → `{ lanAddress, routerHost } | null`, `map({ internalPort, protocol, ttlMs })` → `{ externalPort, leaseExpiresAt }` (throws `NatError('mapping_failed')` on refusal), `unmap(internalPort, protocol)`, `externalIp()`, `stop()`.

### Mapping table (replaces the single-mapping `PortMapperService`)

One table keyed by **node id** (the orchestrator's container id: `owner` for the owner node, the donation id for a donated node). Each node has two ports: `tcp` (`NodePorts.p2p`) and `ws` (`NodePorts.ws`). Health, metrics and admin ports are never mapped. A handle persisted by an older build without `ws` maps only `tcp`.

Per port the table holds a `PortRoute`:

```ts
interface PortRoute {
	internalPort: number;
	/** Port reachable from outside; null when there is no route. */
	externalPort: number | null;
	source: 'upnp' | 'manual' | null;
	leaseExpiresAt: string | null;   // ISO; upnp only
	error: string | null;            // last mapping failure, plain language
}
```

Rules:

- **Manual wins.** A port with a manual forward (below) is not requested over UPnP; its route is `{ source: 'manual', externalPort: <stated> }`.
- **Each mapping fails alone.** A router refusal (including a router that caps the number of mappings) records `error` on that port only; every other node's mappings are untouched.
- **One renewal pass for all mappings**, every `DEFAULT_REFRESH_MS` (half the 1 h lease). Each renewal is isolated: one failure does not stop the pass. A renewal that comes back with a different external port updates the route.
- **Which nodes get mappings.** The service reconciles against the orchestrator's node list (`listNodes()` + `onStateChange`, the same structural slice `DonationSupervisor` uses), on every state change and on a 1-minute timer:
  - a node whose status is `running` is mapped;
  - a node that has been `stopped` for longer than `NAT_UNMAP_GRACE_MS` (3 min, longer than the donation supervisor's whole respawn backoff of 150 s, so a crash-and-respawn keeps its mapping) is unmapped;
  - a node no longer in the list (terminated: `removeContainer`) is unmapped at once, and its manual forward entry is deleted from `nat.json`.
- **Host shutdown does not unmap.** Hosted children are detached and keep running across a host restart (including an update restart), so `stop()` only clears timers. Leases expire on their own within the TTL if the host stays down; the next `start()` re-maps re-attached nodes (re-mapping the same internal port is idempotent on the router). State that in a `NOTE:` at `stop()`.
- **Turning UPnP off** (`PUT /nat/settings { upnpEnabled: false }`) unmaps every `upnp` route; manual routes stay.

### Manual forwards

`nat.json` drops `externalPort`/`internalPort` and gains:

```ts
/** Per node id: the external port the user forwarded on their router, per port kind. */
forwards: Record<string, { tcp?: number; ws?: number }>;
```

- The loader's shape check stops requiring the two dropped fields and builds the settings object from known fields only, so an existing `nat.json` still loads and the next save drops them. (`forwards` defaults to `{}` when absent.) Validation: each stated port is an integer 1–65535.
- The installer's `seedNatSettings` writes only `upnpEnabled`.
- Route: `PUT /nat/nodes/:nodeId/forward` with body `{ tcp?: number | null; ws?: number | null }` (`null` clears that port; both cleared removes the entry) → the full status snapshot. Unknown node id → `404 unknown_node` (add the code to `NatErrorCode` and `error-handler.ts`). Bad port → `400 invalid_config`.
- `NatService.putForward(nodeId, patch)` applies it: releases the UPnP mapping for a port that became manual, re-requests one for a port whose manual entry was cleared.

### Public addresses per node (`address-resolver.ts`)

Replace `buildInviteAddresses` with a pure `buildPublicAddresses(input)`:

```ts
interface PublicAddressInput {
	ddnsHostname: string | null;
	/** Last known public IPv4; null when unknown. */
	externalIp: string | null;
	cgnatDetected: boolean;
	tcp: PortRoute;
	ws: PortRoute | null;
}
```

- Host part: `/dns4/<hostname>` when a DDNS hostname is configured (externally managed included), else `/ip4/<externalIp>` when it is a public IPv4, else none.
- One address per port that has a route: `<host>/tcp/<externalPort>` and `<host>/tcp/<externalPort>/ws`. No `/p2p/` suffix — the node appends its own (cadre-core `normalizeSelfAddrs`, libp2p for announce addresses).
- Under CGNAT, `upnp` routes produce nothing (the router's mapping is on a carrier-private address); `manual` routes still produce addresses, since the user asserted the forward.
- No libp2p fallback list: these are the public addresses only; the node's own LAN addresses come from libp2p.

`NatService.publicAddressesFor(nodeId, ports)` (synchronous, from cached state) returns this for a node. It also **predicts** an identity mapping (`externalPort = internalPort`, `source: 'upnp'`) for a port that has no route yet when UPnP is enabled and a gateway was discovered — the next ticket calls it at spawn time, before the mapping for a brand-new node exists. A port whose mapping attempt has failed is not predicted.

### External IP

Keep `ExternalIpDetector` (router probe + public probe, CGNAT flag). Add periodic re-detection every 5 minutes. A failed detection keeps the previous result rather than clearing it, so one failed probe does not drop every node's public address. Re-detection that changes the IP or the CGNAT flag fires the change listener (below). Only a public IPv4 counts as an external IP for addresses.

### Status snapshot

```ts
interface NatStatusSnapshot {
	upnpEnabled: boolean;
	gateway: { found: boolean; lanAddress: string | null; routerExternalIp: string | null; lastError: string | null };
	externalIp: string | null;
	externalIpDetectedAt: string | null;
	cgnatDetected: boolean;
	/** Roll-up across running nodes; see below. */
	directReachability: DirectReachability;
	lastTestedAt: string | null;
	ddns: NatDdnsStatus;
	nodes: NodeReachability[];
}
interface NodeReachability {
	nodeId: string;
	verdict: 'mapped' | 'manual' | 'unreachable';
	/** Plain-language reason and remedy when unreachable, e.g. "Router refused the WebSocket port mapping. Forward port 10004 to 192.168.1.20 on your router, then enter the external port here." */
	reason: string | null;
	tcp: PortRoute;
	ws: PortRoute | null;
	publicAddrs: string[];
}
```

- Node verdict: `unreachable` when either port has no route, or the host part is unknown (no DDNS hostname and no public IPv4), or the node's routes are `upnp` under CGNAT; otherwise `manual` when either port is manual, else `mapped`. The `reason` names the failing port, its internal port, the LAN address, and what to do (forward it, or enable UPnP, or "behind carrier-grade NAT: a port forward on your router will not help; a relay is needed" — relay support is `backlog/feat-cadre-host-children-reserve-on-a-relay`).
- Host roll-up `directReachability`: `cgnat` when CGNAT is detected and no node is reachable through a manual route; `unknown` with no running nodes; `reachable` when every running node is `mapped`/`manual`; else `unreachable`. Update `reachability.ts` to compute this.
- Drop `portMode`, `externalPort`, `internalPort`, `routerExternalIp` (now under `gateway`) and `mappingLeaseExpiresAt` from the host level; drop `'auto-natpmp'` and the `PortForwardMode` type if nothing else needs it.
- The SSE `connectivity-changed` event carries `directReachability` only (drop `portMode`). `NatService.onChange(listener)` fires whenever a node's routes, the external IP, the CGNAT flag or DDNS settings change; `server/index.ts` wires it to publish `connectivity-changed`, so the UI follows mappings that complete after a spawn.

### Mounting in every role

- `NatService` no longer takes a `cadreNode`; it takes `rootDir` and a node source (the orchestrator). Delete `CadreNodeLike`, `AddressesChangedListener`, `getInviteAddresses`, `onAddressesChanged`, `pushInitialAddresses`, the `initialPush*` options, the `OwnerNodeUnavailableError` import and the `node_unavailable` NAT code (check `error-handler.ts` still needs the code for other domains before removing its mapping).
- `bin/host.ts`: construct and `start()` `NatService` after `orchestrator.init()` and before the owner node is spawned and before `DonationSupervisor.start()`, in every role. `start()` awaits gateway discovery (bounded by the 10 s timeout) and external-IP detection, then maps re-attached running nodes in the background (not awaited) so the management API comes up promptly. Remove the owner invite-address push wiring (`owner.pushInviteAddresses`); `OwnerNodeClient.pushInviteAddresses` becomes unused — delete it. cadre-cli's `PUT /admin/invite-addresses` stays (cadre-cli is out of scope); with no push, the owner node's invitations carry its libp2p addresses, which include the announce addresses added by the next ticket.
- `server/index.ts`: `nat: NatService` becomes a required top-level option; `FounderServices` keeps `strands` only. `/nat/*` always mounts; the boot-time `connectivity-changed` publish always runs. `status.ts` and `settings.ts` take `nat` unconditionally.
- UI: the minimum to keep it compiling and truthful with the new snapshot (Connectivity page and Home tile visible in every role, badge driven by `directReachability`, host-level port fields removed). The per-node table and manual-forward form are the third ticket's.
- `cadre-host nat settings`: drop `--external-port`/`--internal-port` (only `--upnp`/`--no-upnp` remain). The rest of the CLI is the third ticket's; keep `printNatStatus` compiling against the new snapshot.
- Integration harness and the two scenarios that build `NatService` (`test-cadre-host.ts`, `cadre-host-bootstrap.integration.ts`, `cadre-host-sse-events.integration.ts`): construct it with the orchestrator, pass it as `nat`, and assert `directReachability` instead of `portMode`.

### Docs

Rewrite `docs/cadre-host.md` → "NAT and DDNS" item 1, "Reachability verdict" (per-node verdict + roll-up table), and replace "Invite address resolver" with "Public addresses per node" (the rules above). Remove the donor-role statements that `/nat/*` is unmounted ("Two roles" consequences, "Reachability (loopback-only in v1)", the Status section, the API table row). Update the orchestrator's child-env `NOTE:` that says the NAT forward covers the owner node's TCP port only. In `packages/cadre-host/README.md`, remove the statements that `/nat/*` and `cadre-host nat` belong to the founder role only (the role table row, the "reports a 404" paragraph, the "Founder role only" line under `nat status`) and the `nat settings --external-port/--internal-port` options. Strand nodes inside each child bind OS-assigned ports and are not mapped; they are reached through relays by design (`cadre-core/src/strand-network-config.ts`) — say so in one line in the NAT section.

## Edge cases & interactions

- Router caps the number of mappings: the mappings past the cap fail per port; nodes already mapped keep theirs. **Test** (fake mapper that refuses after N maps): two nodes, cap 3 → node A `mapped`, node B `unreachable` with a reason naming its WebSocket port; the next renewal pass leaves A's routes intact.
- Router assigns an external port different from the internal one: the route and `publicAddrs` carry the assigned port. **Test** (fake mapper returning `internal + 1`).
- `buildPublicAddresses` branching (DDNS vs IP vs private IP vs CGNAT+upnp vs CGNAT+manual, ws route missing): one table-driven **test** replacing the existing `address-resolver.test.ts` cases.
- A node terminated → both ports unmapped at once and its `forwards` entry deleted; a node stopped and respawned within the grace keeps its mapping; host `stop()` unmaps nothing. **Test** the removal and the grace with the fake mapper and an injected clock; host-stop by inspection.
- Gateway discovery times out: no UPnP routes, `gateway.found: false`, manual forwards still produce addresses and `manual` verdicts. By inspection.
- UPnP disabled while nodes are mapped: every `upnp` route is unmapped, manual ones kept. By inspection.
- A manual forward set for a port that has a live UPnP mapping: the UPnP mapping is released. By inspection.
- `PUT /nat/nodes/:nodeId/forward` for an unknown node → 404; out-of-range port → 400. By inspection.
- An existing `nat.json` with the old `externalPort`/`internalPort` fields loads, and saving drops them. By inspection.
- Two concurrent reconcile triggers (state change during the timer pass) must not map the same port twice or unmap a port a concurrent pass is mapping: serialize reconcile passes (one promise tail, as `DonationSupervisor` does).
- The owner node's TCP port is the `libp2pPort` setting rather than an allocated one; it is mapped like any other node's.

## TODO

- Rewrite the UPnP adapter against `@achingbrain/nat-port-mapper` v4 (discovery with timeout, LAN address by subnet match, map/unmap/externalIp on the gateway, returned external port).
- Replace `PortMapperService` with the per-node mapping table: reconcile against the orchestrator, unmap grace, single renewal pass, per-port failure isolation.
- `nat.json` `forwards`, `NatService.putForward`, `PUT /nat/nodes/:nodeId/forward`, `unknown_node` error code; drop the single-port fields; installer seeding.
- `buildPublicAddresses` + `publicAddressesFor` (with the identity-mapping prediction).
- Periodic external-IP re-detection that keeps the last good result.
- New status snapshot, per-node verdicts and reasons, host roll-up, `onChange` → `connectivity-changed`.
- Remove the invite-address push and the owner-node dependency; mount `/nat/*` in every role; wire `NatService` in `bin/host.ts` before any spawn.
- Minimal UI/CLI/integration-harness updates for the new snapshot.
- Tests named above; delete tests of removed behaviour (`getInviteAddresses`, initial push, single-mapping `PortMapperService`).
- Docs as listed.
- `yarn workspace @serfab/cadre-host build`, its unit tests, `yarn lint`, and the two cadre-host integration scenarios above.
