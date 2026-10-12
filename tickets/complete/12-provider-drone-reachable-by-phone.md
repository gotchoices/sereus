description: A phone can now connect to a node rented from the multi-tenant hosting service. Rented nodes accept WebSocket connections, announce an address at the provider's public host, and the request to create one may leave out the phone's address when the provider has a public host configured.
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/config/schema.ts, packages/cadre-provider/src/config/env.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/README.md, packages/cadre-provider/example.provider.yaml, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/integration-tests/src/harness/provider-process-orchestrator.ts, docs/architecture.md
----
# A phone can use a rented cadre-provider node

A phone has no TCP transport and listens on nothing, so it can add a provider-hosted node only if that node accepts WebSocket connections at an address the phone is given. This ticket gave `@serfab/cadre-provider` containers that shape (implemented in `ticket(implement): provider-drone-reachable-by-phone`):

- **WebSocket listener.** Each container listens on TCP 4001 and WebSocket 4002 (`CONTAINER_PORTS.ws`), both published on all interfaces from `docker.portRange` (now four host ports per container). `ExposedPorts` is set on create so publishing does not depend on the image's `EXPOSE`. The cadre-cli image, compose file and `env.example` carry the same `/ws` listener and a `HOST_WS_PORT`.
- **Public address.** New config `docker.publicHost` (`PROVIDER_DOCKER_PUBLIC_HOST`). When set, each container gets `CADRE_APPEND_ANNOUNCE_ADDRS` with `publicNodeAddrs(publicHost, hostPorts)` — `/dns4|ip4|ip6/<host>/tcp/<p2p>` and `…/tcp/<ws>/ws` — on top of its in-container addresses, so `GET /containers/:id/peer` returns both. The value is checked at provider start (one multiaddr host component, no whitespace). It is fixed in a container's environment at create.
- **Optional `bootstrapNodes`.** `POST /containers` accepts an absent or empty `bootstrapNodes` only when `publicHost` is set; otherwise it answers 400 naming `docker.publicHost`. An empty list omits `CADRE_BOOTSTRAP_NODES`, and the image entrypoint writes `bootstrapNodes: []`.
- **Docs.** `docs/architecture.md` (Phone Adds Provider Drone key points incl. the cold-start admission window, Which Side Dials row 4) and the provider README section "Phones dial containers at the public host".

The wire proof (a real child binding `/ws`, announcing the public pair, a phone-shaped requester dialing it) is `provider-drone-phone-requester-scenario`.

## Review findings

**Checked, by reading the diff first and then the surrounding code:**

- *Announce wiring end to end.* `CADRE_APPEND_ANNOUNCE_ADDRS` is mapped by cadre-cli's `config/env.ts` to `network.appendAnnounceAddrs`, written by the entrypoint, forwarded by cadre-core's `resolveAnnounceAddrs` to libp2p's `appendAnnounce`; cadre-host uses the same var the same way. `/peer` reports the node's `/status` multiaddrs unfiltered. Correct as written; the next ticket observes it on a real child.
- *Empty bootstrap list.* cadre-cli's schema requires the key but accepts `[]`; the env var, when present, overrides the file. The provider never emits an empty or comma-only value, so the entrypoint's `bootstrap_nodes_yaml` edge case (a value of only commas would write YAML null) is unreachable from the provider; not changed.
- *Port bookkeeping.* `CONTAINER_PORT_KEYS` appended, not reordered; `hostPortsOf` returns a partial set for a pre-change container and `reservePortSet`/`releasePortSet` handle it (pinned by the existing restart test, which now rehydrates a three-binding survivor).
- *`publicHost` check.* Walked `a/b`, trailing `/`, whitespace, uppercase IPv6, IPv4; the whitespace clause is needed because the `dns4` codec accepts any text. `hostComponent` uses `/dns4`, so an IPv6-only DNS name would not resolve; consistent with every published-address example in the repo, left as is.
- *Layering.* `config/schema.ts` importing `hostComponent` from `service/` matches its existing import of `resource-limits`; type-only imports from there, no cycle.
- *Security.* A container with a public port and no bootstrap peers admits any peer until the phone's rows arrive; seeds still need the pinned owner key. This is cadre-core's documented cold-start rule and both docs state it; no change.
- *Docs.* Read architecture.md's changed sections, the provider README, `example.provider.yaml`, compose, Dockerfile, `env.example`. Anchors resolve; no doc still links to this ticket.
- *Tests.* The added tests each pin a branch (optional/required bootstrap list, the four outcomes of the `publicHost` check incl. the IPv6 canonicalization defect the implementer found). Nothing restates a constant or mocks an owned module; nothing cut.

**Found and fixed in this pass:**

- *`docker.network: host` (and `none`, `container:<id>`)* — the handoff's known gap. Docker ignores `PortBindings` in those modes, so every container binds the same in-container ports on the host and the provider, which reaches each container at its allocated host port, reaches none. Pre-existing for `p2p`/health, widened by the fourth port. Fixed at the config boundary: `config/schema.ts` refuses those modes at provider start (`dockerNetwork` checker), with one table test in `config-validation.test.ts` and a sentence in the README config paragraph.
- *`env.example` stale comment* — it called `CADRE_ANNOUNCE_ADDRS` "accepted but not yet applied", contradicting the cadre-cli README and cadre-core, and did not list `CADRE_APPEND_ANNOUNCE_ADDRS` at all although compose passes it. Rewritten to match the README and the append var added with a `/ws` example.

**Major findings:** none — nothing needed a ticket.

**Tripwires:** none new. The implementer's NOTEs (a changed `publicHost` reaches only containers created afterwards, at `createContainer`'s `Env`; a TLS proxy would need a per-container path or port, in `buildNodeEnv`) are the right sites.

**Not verified:** the Docker image was not built or run, so the Dockerfile, compose and entrypoint changes are exercised only by the implementer's extracted-function run. `entrypoint.sh` has CRLF endings in this Windows checkout (git stores LF); pre-existing, unchanged.

**Validation:** `yarn workspace @serfab/cadre-provider typecheck` clean; `yarn workspace @serfab/cadre-provider test` 31 files, 241 passed; `yarn lint` clean. Rebuilt `@serfab/cadre-provider` so the integration suite's stale-build guard sees the schema change. No sibling repo was built.
