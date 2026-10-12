description: A phone cannot connect to a node rented from the multi-tenant hosting service: the rented node accepts only plain TCP connections, never tells anyone its public address, and creating it demands an address for the phone. Make rented nodes accept WebSocket connections at a public address the provider knows, and let the request leave out the phone's address.
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/config/schema.ts, packages/cadre-provider/src/config/env.ts, packages/cadre-provider/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-provider/README.md, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/docker-compose.yml, packages/integration-tests/src/harness/provider-process-orchestrator.ts, docs/architecture.md
----
# A phone can use a rented cadre-provider node

`docs/architecture.md` → "Enrollment Flow: Phone Adds Provider Drone" calls this the most common case: a phone behind NAT rents a node (a "drone") from `@serfab/cadre-provider`, seeds it, and then dials it. Three things stop that today:

1. **No WebSocket listener.** `buildNodeEnv` (`service/container-env.ts`) sets `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<p2p>`. A React Native phone has no TCP transport; it dials only `/ws` addresses.
2. **No public address.** The node inside a container advertises only the addresses it binds inside the container (Docker bridge addresses such as `172.17.0.5`). `GET /containers/:id/peer` returns exactly those (`ContainerService.getPeerInfo` reads the node's `/status`), so nothing off the provider's machine is ever told the published host port. Until now nobody needed it: the container dials the requester, outbound through Docker's NAT. The NOTE in `buildNodeEnv` anticipates this ("add the var … the provider is the side that knows the port mapping").
3. **`bootstrapNodes` is required.** `validateBootstrapNodes` refuses an absent or empty list, and the image's `entrypoint.sh` refuses an empty `CADRE_BOOTSTRAP_NODES`. A phone has no address to give.

cadre-host fixed (1) and (3) for its lent nodes in `donated-node-reachable-by-phone` (`childListenAddrs` in `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`; optional `bootstrapNodes` with the per-entry rule unchanged). The phone side is shared cadre-core code (`CadreNode.addDrone` retains the drone's addresses; `reconcileControlCohort()` dials them) and needs no change.

Demand: gotchoices/sereus#40 (kjeib). The reply (`blocked/report-issue-replies-2026-10-11`) invited a pull request for the listener and optional `bootstrapNodes`; if one arrives, review it against this ticket.

The claim model (container starts waiting to be claimed, `CADRE_CLAIM_SECRET`) is **not** in this ticket. Whether the provider adopts it is decided in `provider-client-and-sign-up`, and the container bring-up for it moved there with the decision.

## Design

### WebSocket listener and a fourth published port

- `NodeEnvPorts` / `CONTAINER_PORTS` gain `ws: 4002` (in-container port).
- `buildNodeEnv` emits `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<p2p>,/ip4/0.0.0.0/tcp/<ws>/ws`, the same pair cadre-host's `childListenAddrs` builds.
- `DockerOrchestrator`: `CONTAINER_PORT_KEYS` becomes `['health', 'metrics', 'p2p', 'ws']` (appended last so the existing keys keep their allocation order). `PortBindings` publishes `4002/tcp` on all interfaces, like `p2p`. `hostPortsOf` and rehydration pick it up through the key list with no further change.
- Set `ExposedPorts` on `docker.createContainer` from `CONTAINER_PORTS` (all four), so publishing does not depend on the operator's image declaring `EXPOSE`. The Docker Engine API, unlike the `docker run -p` command line, does not add a bound port to the container's exposed set by itself.
- Image: `packages/cadre-cli/docker/Dockerfile` adds `4002/tcp` to `EXPOSE` and the `/ws` entry to its `CADRE_LISTEN_ADDRS` default; `docker-compose.yml` gets the matching default and a `HOST_WS_PORT` publish line. The image's defaults and `CONTAINER_PORTS` describe the same ports, so they stay in step.

A container now holds four host ports, so a port range serves a quarter as many containers instead of a third. Say so in the README where `docker.portRange` is described.

### The provider's public host, announced by the node

- New optional config `docker.publicHost` (env `PROVIDER_DOCKER_PUBLIC_HOST`): the DNS name or IP address at which this machine's published container ports are reachable from outside.
- New exported function in `container-env.ts`: `publicNodeAddrs(publicHost, hostPorts: { p2p: number; ws: number }): string[]` returns `[<host>/tcp/<p2p>, <host>/tcp/<ws>/ws]`, where `<host>` is `/ip4/<h>` or `/ip6/<h>` when `node:net`'s `isIP` says so, and `/dns4/<h>` otherwise. `/dns4` because every published-address example in this repo and the phone apps uses it.
- `NodeEnvSpec` gains `appendAnnounceAddrs?: readonly string[]`; `buildNodeEnv` emits `CADRE_APPEND_ANNOUNCE_ADDRS=<comma-joined>` when it is non-empty and nothing otherwise. Keep `buildNodeEnv` free of the decision; `DockerOrchestrator.createContainer` computes the list from `config.publicHost` and the allocated host ports (the env's `ports` stay the in-container ports).
- *Append*, not replace: the in-container addresses stay advertised, so containers on the same Docker network can still reach one another directly. libp2p adds `/p2p/<peerId>` to announced addresses itself, so the node's `/status` and therefore `GET /containers/:id/peer` now include the public pair. No change to `getPeerInfo` or the route.
- Replace the `buildNodeEnv` NOTE about the closed address list with one that says what remains open: a provider that fronts tenants with a TLS proxy (`/wss` on 443) would announce the proxy's address instead, and would need a per-container path or port there.
- Config validation (`config/schema.ts`): `publicHost` is a non-empty string for which `multiaddr(<host component>)` parses to exactly one component; reject anything else at provider start, naming the key. Reuse the helper that builds the host component; do not write a separate hostname check.

### `bootstrapNodes` becomes optional when containers are reachable

- `validateBootstrapNodes(value, { optional })`: when `optional`, an absent field or `[]` returns `{ nodes: [] }`. Every per-entry rule is unchanged. When not `optional`, the current refusal stays, with a message that names the reason: `bootstrapNodes is required: this provider announces no public address for its containers (docker.publicHost is unset), so a container with no bootstrap peers could never be reached`.
- `optional` is `config.docker.publicHost !== undefined`, decided once in `createProviderServer` and passed through `RouteContext` to `validateCreateContainerRequest`. Tying it to `publicHost` keeps the module's rule that a create call never answers 201 for a container that can only come up alone.
- The validated `CreateContainerRequest.bootstrapNodes` stays `string[]` (normalized to `[]`).
- Rewrite the module comment's "At least one address is required" paragraph to state the new rule and its reason; keep the per-entry rationale as is.

### An empty list reaches the node as "no bootstrap peers"

- `buildNodeEnv` omits `CADRE_BOOTSTRAP_NODES` when the list is empty, the same as `CADRE_OWNER_KEYS`.
- `entrypoint.sh` `generate_config`: drop the `CADRE_BOOTSTRAP_NODES is required` check; when the variable is empty or unset write `bootstrapNodes: []`, otherwise the current list. cadre-cli's schema already accepts `[]` ("a cadre's founding node … has no one to dial") but requires the key, and the current loop would write a bare `bootstrapNodes:` (YAML null) for an empty value, which fails validation. cadre-cli skips a set-but-empty env override (`specifiedEnv`), so the file's `[]` stands.
- `ProviderProcessOrchestrator` (integration-test harness that reproduces the image in process): its `ensureConfigFile` writes no `controlNetwork` today because the env always supplied the list. Make it write `controlNetwork.bootstrapNodes: []`, mirroring the entrypoint's output, and add the `/ws` entry to its copy of the image's `CADRE_LISTEN_ADDRS` and a `ws` port to its port set. This keeps `provider-seed-accepted.integration.ts` running against the new env; the phone-shaped scenario itself is `provider-drone-phone-requester-scenario`.

### Docs

- `docs/architecture.md`: the "Phone Adds Provider Drone" bullet that says the provider does not work yet (around line 446) and row 4 of "Which Side Dials" (around line 805) now describe the working flow: the container listens on TCP and `/ws`, announces `docker.publicHost` with its published ports, `bootstrapNodes` is optional when `publicHost` is set, and the phone dials the addresses from `GET /containers/:id/peer`. Remove the links to this ticket. Add the provider case wherever the docs describe the cold-start admission window (see Edge cases).
- `packages/cadre-provider/README.md`: config table row for `PROVIDER_DOCKER_PUBLIC_HOST`; the "Bootstrap addresses are checked at create time" section states when the list may be empty; port-range capacity; what the peer route now returns.

## Edge cases & interactions

- **`publicHost` unset.** No announce variable; `bootstrapNodes` stays required with the new message. Today's behaviour otherwise. Verified by the validation table test.
- **`publicHost` is an IPv4, IPv6 or DNS name; or junk (`a/b`, whitespace).** First three produce `/ip4`, `/ip6`, `/dns4` addresses; junk is refused at provider start. Verified by inspection plus the config check; no separate test unless the helper grows branches beyond `isIP`.
- **`publicHost` changed between provider restarts.** A container's `Env` is fixed at create, so existing containers keep announcing the old host until recreated. Document in the README next to the config row; a `NOTE:` at the `createContainer` site.
- **Containers created before this change.** They have no `ws` binding; `hostPortsOf` leaves the key out and rehydration reserves only what exists. They stay TCP-only. No migration (the project keeps no backwards compatibility yet). Verified by inspection.
- **Range exhaustion part-way.** `allocatePortSet` is already all-or-nothing over the key list; adding a key keeps that. No new test.
- **`docker.network` set to `host`.** Docker ignores `PortBindings` in host mode, so every container would try to bind 4001/4002 on the host. Not new (p2p already had this); not handled here.
- **Cold-start admission window.** A node with no authorized members admits any peer until the phone's rows arrive (cadre-core's design: `admitInboundControlConnection` / `authorizeInboundControlStream` in `packages/cadre-core/src/cadre-node.ts`; the docs that describe it sit near `docs/architecture.md` → "Per-stream protocol guard" — grep for where the cadre-host lent-node case was written up and add the provider case beside it). A provider container already had a public TCP port with the same window; a phone-rented node may sit in it longer, until the phone dials after seeding. Document it for the provider in the same terms; no code change.
- **Phone dials an in-container address first.** The peer route returns the Docker-internal addresses too; libp2p dials the candidates and the unreachable ones fail. Accepted; the public `/ws` address is among them.
- **Empty `CADRE_BOOTSTRAP_NODES` with an existing `cadre.yaml`** (a container restart): `generate_config` runs only when the file is absent; the file written at first start already has `[]`. No issue.

## Tests

- Extend `server/__tests__/bootstrap-node-validation.test.ts`'s table with the list-level rule on both branches: absent and `[]` accepted when `optional`, refused with the `publicHost` message when not. This pins the branching rule; nothing else needs a new unit test.
- Run `provider-seed-accepted.integration.ts` after the harness change to prove the env contract still holds (TCP requester, non-empty list).
- The wire proof that a phone-shaped requester reaches a provider node is the next ticket, `provider-drone-phone-requester-scenario`.

## TODO

- `container-env.ts`: `ws` port, two listen entries, `publicNodeAddrs`, `appendAnnounceAddrs` in `NodeEnvSpec`, omit empty `CADRE_BOOTSTRAP_NODES`, replace the closed-list NOTE.
- `docker-orchestrator.ts`: `ws` key, `ExposedPorts`, `4002/tcp` binding, announce list from `config.publicHost`, `NOTE:` on publicHost changes.
- Config: `docker.publicHost` type, schema check, `PROVIDER_DOCKER_PUBLIC_HOST` env mapping.
- Validation: `validateBootstrapNodes(value, { optional })`, `validateCreateContainerRequest` and `RouteContext` plumbing from `createProviderServer`; module comment.
- Image: `entrypoint.sh` empty-list handling, Dockerfile `EXPOSE` and listen default, compose file.
- Harness: `ProviderProcessOrchestrator` config file, listen default, `ws` port.
- Tests: validation table rows; run the cadre-provider suite and `provider-seed-accepted.integration.ts`.
- Docs: architecture.md (bullet, row 4, cold-start sentence), cadre-provider README.
- `yarn lint`, `yarn workspace @serfab/cadre-provider typecheck`.
