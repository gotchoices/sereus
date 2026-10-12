description: A phone can now connect to a node rented from the multi-tenant hosting service. Rented nodes accept WebSocket connections, announce an address at the provider's public host, and the request to create one may leave out the phone's address when the provider has a public host configured.
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/config/schema.ts, packages/cadre-provider/src/config/env.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-provider/src/config/__tests__/config-validation.test.ts, packages/cadre-provider/src/service/__tests__/container-env.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/README.md, packages/cadre-provider/example.provider.yaml, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/integration-tests/src/harness/provider-process-orchestrator.ts, docs/architecture.md
----
# A phone can use a rented cadre-provider node — review handoff

A phone has no TCP transport and listens on nothing, so it can only add a provider-hosted node ("drone") if the node accepts WebSocket connections at an address the phone is given. Before this change a provider container listened on TCP only, advertised only its Docker-internal addresses, and `POST /containers` demanded `bootstrapNodes` (the phone's address, which a phone does not have). The phone side (`CadreNode.addDrone`, `reconcileControlCohort()`) is shared cadre-core code and was not touched.

## What landed

**WebSocket listener, a fourth published port.**
- `container-env.ts`: `NodeEnvPorts` / `CONTAINER_PORTS` gain `ws: 4002`; `buildNodeEnv` emits `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<p2p>,/ip4/0.0.0.0/tcp/<ws>/ws` (same pair as cadre-host's `childListenAddrs`).
- `docker-orchestrator.ts`: `CONTAINER_PORT_KEYS` is `['health','metrics','p2p','ws']` (appended, so existing keys keep allocation order); `4002/tcp` published on all interfaces like `p2p`; `ExposedPorts` set from `CONTAINER_PORTS` on create, so publishing no longer depends on the image's `EXPOSE`. Rehydration and `hostPortsOf` pick the key up through the list; a container created before this change has no `ws` binding and keeps TCP only.
- Image: Dockerfile `EXPOSE` adds `4002/tcp` and its `CADRE_LISTEN_ADDRS` default adds `/ws`; compose and `env.example` get the matching default and `HOST_WS_PORT`.

**Public address, announced by the node.**
- New optional config `docker.publicHost` (env `PROVIDER_DOCKER_PUBLIC_HOST`).
- `container-env.ts`: `hostComponent(host)` (`/ip4`, `/ip6` per `node:net` `isIP`, else `/dns4`) and exported `publicNodeAddrs(publicHost, { p2p, ws })` → `[<host>/tcp/<p2p>, <host>/tcp/<ws>/ws]`. `NodeEnvSpec.appendAnnounceAddrs` → `CADRE_APPEND_ANNOUNCE_ADDRS` when non-empty. `DockerOrchestrator.announceAddrsFor` computes the list from `config.publicHost` and the allocated **host** ports; the env's `ports` stay in-container. In-container addresses stay advertised (append, not replace), so `GET /containers/:id/peer` now returns both sets with no route change.
- `publicNodeAddrs` is exported from the package index for the next ticket's harness.
- Config check (`config/schema.ts`, `publicHost` checker): refused at start unless it has no whitespace, `multiaddr(hostComponent(host))` parses to exactly one component, and (for a DNS name) the component's value equals the input. IPv6 is compared loosely because multiaddr canonicalizes it (`2001:DB8::1` → `2001:db8::1`); a strict text round-trip would have refused valid IPv6.
- The closed-list NOTE in `buildNodeEnv` is replaced by one about a TLS proxy (`/wss` on 443) needing a per-container path or port. A `NOTE:` at the `Env:` line in `createContainer` says a changed `publicHost` reaches only containers created afterwards.

**`bootstrapNodes` optional only when containers are reachable.**
- `validateBootstrapNodes(value, { optional })`: absent or `[]` → `{ nodes: [] }` when optional; otherwise refused with `bootstrapNodes is required: this provider announces no public address for its containers (docker.publicHost is unset), so a container with no bootstrap peers could never be reached`. Per-entry rules unchanged.
- `optional` = `config.docker.publicHost !== undefined`, decided in `createProviderServer`, carried as `RouteContext.bootstrapNodesOptional` into `validateCreateContainerRequest(body, customerId, { optional })`.
- `buildNodeEnv` omits `CADRE_BOOTSTRAP_NODES` for an empty list; `entrypoint.sh` gains `bootstrap_nodes_yaml()`, which writes `bootstrapNodes: []` for an empty/unset variable (a bare `bootstrapNodes:` would be YAML null, refused by cadre-cli), and no longer refuses an empty `CADRE_BOOTSTRAP_NODES`.
- Harness `ProviderProcessOrchestrator`: `ws` port, `/ws` in its copy of the image's `CADRE_LISTEN_ADDRS`, and its config file now carries `controlNetwork.bootstrapNodes: []` (the entrypoint's output for an empty list). No `publicHost` option yet: `provider-drone-phone-requester-scenario` adds it.

**Docs.** `docs/architecture.md`: "Phone Adds Provider Drone" key points (working flow, plus the cold-start admission bullet: a drone with no authorized members admits any peer until the phone's rows arrive), "Which Side Dials" row 4 and the two paragraphs after the table, and the create-request validation paragraph. Ticket links removed. `packages/cadre-provider/README.md`: config paragraph (four ports per container, 2,500 containers in the default range; `publicHost` validity), env table row, "Bootstrap addresses are checked at create time" says when the list may be empty, and a new section "Phones dial containers at the public host" (flow, in-container addresses still returned, host fixed at create, cold-start window, no TLS proxy). `example.provider.yaml` has a commented `publicHost`.

## Deviations from the ticket — check these

- **Whitespace clause in the `publicHost` check.** The ticket said to reuse the host-component helper and not write a separate hostname check. multiaddr's `dns4` codec accepts any text (`/dns4/a b` parses to one component), so whitespace — which the ticket's edge cases say must be refused — needs its own clause. Everything else goes through the multiaddr parser.
- **One config test added** (ticket said none unless the helper grows branches). The checker has four outcomes and probing found the IPv6 canonicalization bug above, so a small table test pins it.
- **Compose `CADRE_BOOTSTRAP_NODES` relaxed** from `${…:?required}` to optional, and `env.example` says an empty value starts a node that waits to be dialed. Not in the ticket; done so compose agrees with the entrypoint, which no longer requires it.
- **Stale comments about a cadre-host copy fixed.** The bootstrap test header and `create-request-validation.ts` described a cadre-host copy of the rule (`packages/cadre-host/src/server/routes/bootstrap-node-validation.ts`) that was deleted in `cadre-host-hosted-nodes-join-by-qr`; both now describe the provider's rule alone.

## Tests

Added or changed, each beside what it verifies:

- `server/__tests__/bootstrap-node-validation.test.ts`
  - `refuses an absent field and an empty list alike when containers announce no public address` — the `optional: false` branch and its message naming `docker.publicHost`.
  - `accepts an absent field and an empty list alike as no bootstrap peers when optional` — the `optional: true` branch.
  - `still applies the per-entry rule when optional` — the optional branch does not skip entry checks.
  - Existing per-entry rows now pass `{ optional: false }`; the route suite (no `publicHost`) still expects `[]` → 400.
- `config/__tests__/config-validation.test.ts` — `accepts a DNS name or IP address as docker.publicHost and refuses anything else` (accepts DNS, IPv4, uppercase IPv6; refuses `a/b`, trailing `/`, inner and leading whitespace, each attributed to `PROVIDER_DOCKER_PUBLIC_HOST`).
- Updated for the new shape, not new tests: `container-env.test.ts` (listen pair, `ws` in custom ports); `orchestrator-port-leak.test.ts` (ranges resized for four ports, `4002/tcp` bound on all interfaces, and the restart case's surviving container keeps only three bindings, which exercises a pre-change container being rehydrated).

Not tested, by design: that `DockerOrchestrator` passes `announceAddrsFor` into `buildNodeEnv` with `publicHost` set, and the server → route → validator plumbing (wiring). The end-to-end proof is the next ticket.

## Validation

- `yarn workspace @serfab/cadre-provider typecheck` — clean.
- `yarn workspace @serfab/cadre-provider test` — 31 files, 240 passed.
- `yarn workspace @serfab/integration-tests typecheck` — clean.
- `yarn workspace @serfab/integration-tests exec vitest run src/scenarios/provider-seed-accepted.integration.ts` — 5/5 passed (TCP requester, non-empty list, new env with the `/ws` listener and the config file's `bootstrapNodes: []` overridden from the env).
- `yarn lint` — clean.
- Builds run to make the integration suite's stale-build guard pass: `@serfab/cadre-provider` (its `dist` is what the harness imports) and `@serfab/cadre-host` (its `dist` was already stale from earlier commits; no uncommitted edits in it). No sibling repo was built.
- `entrypoint.sh`: `bootstrap_nodes_yaml` was extracted and run under `sh -e` for an empty value, two entries, and a trailing comma; output as expected. **The Docker image was not built or run**; the Dockerfile and compose changes are unexercised.

## Known gaps

- No test sees a real child bind its `/ws` listener, announce the `publicHost` pair, or start with an empty bootstrap list. `provider-drone-phone-requester-scenario` (prereq on this ticket) owns that proof.
- `docker.network: host` makes Docker ignore `PortBindings`, so every container would try to bind 4001/4002 on the host. Pre-existing for `p2p`; not handled.
- `entrypoint.sh` has CRLF line endings in this Windows working copy (git stores LF, `core.autocrlf=true`); an image built from this checkout would carry them. Pre-existing, not caused by this change.
