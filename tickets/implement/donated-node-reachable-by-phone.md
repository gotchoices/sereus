description: A phone cannot connect to a node that a self-hosted machine lends it. The lent node only accepts plain TCP connections, which a phone cannot make, and the request that creates it demands an address where the node can reach the phone, which a phone never has. Make the lent node accept WebSocket connections on ports that stay the same across restarts, and let the request leave the phone's address out so the phone dials in instead.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts, packages/cadre-host/src/server/routes/provision-request-validation.ts, packages/cadre-host/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/__tests__/, packages/cadre-provider/src/server/bootstrap-node-validation.ts (module comment only), docs/cadre-host.md
----
# A lent node a phone can reach

Part of the "phone adds a cadre-host node to its cadre" work, split from the plan ticket `phone-adds-cadre-host-node-to-its-cadre`. Siblings: `owner-keeps-dialing-node-it-added` (the phone side, cadre-core), `donation-scenario-phone-shaped-requester` (the end-to-end proof), `rn-request-node-from-cadre-host` (the app). The question of whether a lent node hosts the phone's app strands is parked in `blocked/always-on-nodes-host-strands-of-apps-they-do-not-run`.

## Terms

- **Lent node** / **donated node**: a cadre node that cadre-host spawns as a child process into someone else's cadre, on request with a grant token (`DonationService`, `docs/cadre-host.md` → Node donation).
- **Requester**: the device that owns that cadre and asks for the node. The intended one is a phone.
- **Phone shape**: a node with `network.listenAddrs: []` and only WebSocket, circuit-relay and WebRTC transports (`packages/reference-app-rn/src/phone-node-config.ts`, `cadre-phone.ts`). It can dial out; nothing can dial it.

## Decision: the requester dials the lent node

Today the lent node is told where the requester is (`bootstrapNodes`, required non-empty by `validateBootstrapNodes`) and dials it. A phone has no address to give, so the direction is reversed for such a requester:

| step | before | after, when `bootstrapNodes` is empty |
| --- | --- | --- |
| spawn | node starts with the requester as a bootstrap peer | node starts with no bootstrap peers and waits |
| seed applied | node dials the seed's owner peers | owner peers with no address are skipped (unchanged code) |
| first connection | node → requester | requester → node, over the node's `/ws` address |

Why not the other option the plan ticket raised (the phone first reserves a relay slot so it becomes dialable): the natural relay is the lent node itself, and it does not exist until after the request that needs the address. Making a phone dialable is `plan/phone-reachable-for-strand-invitations`; this ticket does not depend on it.

Confirmed by reading (the scenario ticket proves it on the wire):

- **The lent node admits the requester's first connection with no bootstrap entry for it.** Its owner-key anchor is non-empty from boot (`CADRE_OWNER_KEYS`), so `admitControlPeerUnconditionally` does not short-circuit. But `admitInboundControlConnection` (`packages/cadre-core/src/cadre-node.ts` ~1706) admits when `listAuthorizedMembers()` is empty, which is true while its control database holds no rows, and `authorizeInboundControlStream` (~1897) admits while its authorized-member snapshot is empty. The first rows to arrive are the requester's party rows, which authorize the requester (the lent node excludes itself).
- **Nothing on the lent node retries against the phone.** A seed owner entry with no addresses is skipped by `SeedBootstrapService.applySeed`'s dial loop (`seed-bootstrap.ts` ~762-777) and by `CadreNode.recordSeedBootstrapPeers` (~2978). With no `bootstrapNodes`, the cold-start pass (`dialColdStartBootstrap`) has no targets and returns immediately.

## Changes

### 1. The lent node listens on WebSocket as well as TCP

`launchChild` sets `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<p2p>` and scrubs every inherited `CADRE_*` variable (`host-process-orchestrator.ts` ~566). Change it to `/ip4/0.0.0.0/tcp/<p2p>,/ip4/0.0.0.0/tcp/<ws>/ws`. cadre-cli splits the variable on `,`, and cadre-core's `resolveTransportOptions` (`relay-addrs.ts`) adds the WebSocket transport when a listen entry names `/ws`, so no cadre-cli or cadre-core change is needed.

- Add `ws` to `NodePorts` (`orchestrator/types.ts`) and to `NODE_PORT_KEYS` (`port-allocator.ts`), **appended last**, so the allocation order of the existing four keys does not shift (the comment on `NODE_PORT_KEYS` explains why that order is fixed).
- Build the listen list in a small exported pure function (for example `childListenAddrs(ports): string[]`) so it can be unit-tested without spawning a process. `host-process-orchestrator.ts` has no test file of its own (`backlog/debt-host-process-orchestrator-untested`), so do not try to cover it by spawning.
- `launchChild` is shared by `createContainer` (lent nodes) and `ensureOwnerNode` (the host's own cadre, founder role), so both get the listener. That is intended: a friend's phone joining the host's own cadre needs it too.
- Update the NOTE at ~566-576: the port set is now TCP and WebSocket, strand nodes derive an ephemeral `/ws` entry from it (`strand-network-config.ts` rewrites fixed ports to 0), and a NAT forward still covers the TCP port only.

### 2. A respawned node keeps its ports

`createContainer` drops the stale handle for the same `containerId` (which releases its ports) and then calls `allocateNodePorts` afresh. The allocator hands out the lowest free port, so a respawn usually gets the same set back, but nothing guarantees it. With the requester dialing in, a changed port is not a slow reconnect: the phone's only record of the node's address is the one it was given, so a moved port strands a phone-only cadre.

Pass the dropped handle's ports as `allocateNodePorts` overrides. The drop → launch window is synchronous (see `restoreDroppedHandles`), so those ports cannot have been taken in between. Keys the dropped handle lacks (a `ws` port on a handle written before this change) are allocated fresh. Apply the same rule in `ensureOwnerNode`, keeping its configured `libp2pPort` override as the `p2p` value. A pure helper (for example `reusedPorts(dropped: Handle[]): Partial<NodePorts>`) keeps this testable.

### 3. `bootstrapNodes` becomes optional on `POST /grants`

- `validateBootstrapNodes` (`server/routes/bootstrap-node-validation.ts`): absent or `[]` → `{ nodes: [] }`. Non-array, non-string entries, and every per-entry rule stay exactly as they are.
- Rewrite the module comment and the function doc. The **per-entry** rule stays identical to cadre-provider's copy. The **list-level** requirement now differs on purpose: a lent node's requester may dial in, while a provider container still requires bootstrap peers. Update the matching paragraph in `packages/cadre-provider/src/server/bootstrap-node-validation.ts` (comment only; its behaviour and test table do not change). Provider parity is `backlog/feat-provider-drone-reachable-by-phone`.
- `DonationProvisionRequest.bootstrapNodes` doc (`donation-service.ts` ~81): empty means "the requester dials the node itself".

### 4. Respawn accepts an empty bootstrap list

`DonationService.respawn` returns `not_respawnable` when `!donation.bootstrapNodes?.length` (~527). An empty list is now a valid persisted spawn input. Change the check to `donation.bootstrapNodes === undefined || !donation.ownerKeys?.length`, so only a record written before spawn inputs were persisted stays un-respawnable.

### 5. Docs

`docs/cadre-host.md` → Node donation:

- The lifecycle diagram: `bootstrapNodes` optional in step 1, and after step 4 "a requester that gave no bootstrap nodes dials the node's `/ws` address from `GET /grants/:id/peer`".
- The `bootstrapNodes` paragraph: an empty list is accepted, and why. Replace the "byte-identical rule" sentence with the per-entry vs list-level distinction.
- The respawn paragraph: ports are reused, so a lent node comes back at the same addresses; a respawn with no surviving handle (lost `state.json`) gets fresh ports and a phone-only cadre then cannot find it.
- Reachability: a phone on the same LAN can reach the `/ws` port directly, and the `/grants` request is still loopback-only.
- The host port range now costs five ports per node.

## Edge cases & interactions

- **`state.json` handles written before `ws` existed.** Rehydration (`init` re-holding ports) and `releasePorts` must skip a missing key. `PortAllocator.markUsed(undefined)` currently adds `undefined` to the used set (the range checks compare `undefined` and are false), so guard non-integers there.
- **Port range exhaustion.** Five ports per node means a given range fits fewer nodes. `allocateNodePorts` already unwinds atomically on exhaustion; add a test that a range with room for four ports but not five fails cleanly and releases what it took.
- **Override collides with a held port.** Unreachable inside the synchronous window. Do not add retry logic; a test that overrides come back exactly is enough.
- **Failed respawn restore.** `restoreDroppedHandles` re-reserves the dropped handle's ports including `ws`; the released-then-reused ports must not be released twice on the unwind path (ports are released before restore, see the comment in `createContainer`).
- **A request with `bootstrapNodes` present and non-empty** behaves exactly as today. `cadre-host-node-donation.integration.ts` (a TCP-dialable cadre-cli requester) must stay green unchanged.
- **Record with `bootstrapNodes: []`** respawns and writes `controlNetwork.bootstrapNodes: []` into the child's `cadre.json`. A record with the field absent is still `not_respawnable`.
- **`GET /grants/:id/peer`** now returns `/ws` addresses alongside TCP ones, bound on every interface (`0.0.0.0`, so loopback and LAN addresses both appear). Pass-through only; the requester filters by its own transports.
- **Owner node.** It gets the listener and port reuse too. `NatService` maps and advertises only the TCP port (the `/ws` port for a remote phone is an arm added to `backlog/feat-cadre-host-wan-grant-reachability`).
- **cadre-host UI.** Anything that renders `NodePorts` (`packages/cadre-host/ui`) must accept the fifth key; `yarn workspace @serfab/cadre-host typecheck` checks both tsconfigs.

## Tests

- `bootstrap-node-validation.test.ts`: absent and `[]` accepted as `{ nodes: [] }`; `null`, a string, and an array with a non-string still rejected; every existing per-entry row unchanged.
- The provision-request validator's tests (if present beside it): a body with no `bootstrapNodes` yields `request.bootstrapNodes` equal to `[]`.
- `DonationService` unit tests (fake orchestrator): provision with `[]` forwards `[]` to `createContainer`; respawn of a `seeded` record with `[]` returns `respawned`; a record with no `bootstrapNodes` field returns `not_respawnable`.
- Pure helpers: `childListenAddrs` returns the TCP and `/ws` entries for given ports; `reusedPorts` returns the dropped handle's ports, omits a missing `ws`, and returns `{}` when nothing was dropped.
- `port-allocator` tests: `allocateNodePorts` yields five distinct ports; overrides are honored; `markUsed` ignores a non-integer.

Run: `yarn workspace @serfab/cadre-host test`, `yarn workspace @serfab/cadre-host typecheck`, `yarn lint`. Build cadre-host and cadre-cli and run `cadre-host-node-donation.integration.ts` from `packages/integration-tests` to confirm the existing path still passes.

## TODO

- Add `ws` to `NodePorts` and `NODE_PORT_KEYS` (last); guard `markUsed`/`release` against a missing key.
- Extract `childListenAddrs`; set `CADRE_LISTEN_ADDRS` from it; update the NOTE in `launchChild`.
- Extract `reusedPorts`; use it as `allocateNodePorts` overrides in `createContainer` and `ensureOwnerNode`.
- Make `bootstrapNodes` optional in `validateBootstrapNodes`; rewrite its docs; update the provider copy's comment.
- Relax the respawn check to "field absent"; update `DonationProvisionRequest.bootstrapNodes` doc.
- Unit tests listed above.
- Update `docs/cadre-host.md` (lifecycle, bootstrap paragraph, respawn ports, reachability, five ports per node).
- Run cadre-host tests, typecheck, lint, and the existing donation integration scenario.
