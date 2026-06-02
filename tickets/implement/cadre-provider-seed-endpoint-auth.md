----
description: Provider must authenticate to the container's now-gated seed endpoint and confine the published health port to loopback
prereq: cadre-cli-seed-endpoint-auth
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/types.ts
----

## Context

> **Note:** the cli-side auth contract this ticket depends on **already landed**
> via `seed-network-path-authn` (the `cadre-cli-seed-endpoint-auth` prereq slug
> was reduced to deployment-surface hardening only). The container's `POST /seed`
> code gate is live now; this ticket is purely the provider-side wiring.

A cadre container's `POST /seed` route is **disabled unless `CADRE_SEED_TOKEN`
is set** and, when enabled, requires `Authorization: Bearer <CADRE_SEED_TOKEN>`. The provider is the in-tree
consumer of that endpoint (`ContainerService.applySeed` → `fetch(seedEndpoint,
{ method: POST, body: { seed } })`, `container-service.ts:233-265`), so it must
now (a) provision the container with a seed token, (b) present that token when
delivering a seed, and (c) stop publishing the seed/health surface to the world.

This ticket assumes the sibling fix `cadre-provider-seed-endpoint-never-populated`
also lands — that one makes `Container.seedEndpoint` non-null in the first place
(today it is never set, so seed delivery is a dead path). The two are
complementary: that ticket wires *where* to deliver; this one wires *the secret*
to deliver with, and the host-binding hardening. Implement them together if
picked in the same pass; otherwise either order works since the field/contract
changes are additive.

## Design

- **Generate a per-container seed token** when provisioning (a random
  high-entropy string). Inject it into the container as `CADRE_SEED_TOKEN`
  alongside the existing env in `DockerOrchestrator.createContainer`
  (`docker-orchestrator.ts:79-88`). Persist the token (or the resulting
  authenticated `seedEndpoint`) on the stored `Container` so `applySeed` can use
  it. A natural place is to carry it on `OrchestratorCreateResult` next to the
  seed endpoint the sibling ticket adds, and copy it in `provisionContainer`.
- **Confine the host port binding.** `docker-orchestrator.ts:90-94` publishes
  `8080/tcp` with a bare `HostPort`, which Docker binds on `0.0.0.0` of the host.
  Add `HostIp: '127.0.0.1'` to the health (and seed) port binding so the surface
  is only reachable from the provider host's loopback — the provider runs on the
  same host and reaches `http://localhost:<port>`. (Decide whether the metrics
  port should also be loopback-bound; metrics is read-only but typically scraped
  remotely — document the choice.)
- **Send the bearer header** in `ContainerService.applySeed`'s `fetch`
  (`container-service.ts:250-256`): add
  `Authorization: 'Bearer ' + <token>` to the request headers. Source the token
  from the stored container field.
- **MockOrchestrator** (`orchestrator.ts`) must mirror whatever fields are added
  to `OrchestratorCreateResult` so provider tests stay green.

## TODO

- [ ] Generate a random `CADRE_SEED_TOKEN` per container in
      `DockerOrchestrator.createContainer`; add it to the container `Env`.
- [ ] Surface the token (and/or the authenticated seed endpoint) on
      `OrchestratorCreateResult` (`types.ts`) and mirror in `MockOrchestrator`.
- [ ] Persist it onto the stored `Container` in `provisionContainer`
      (coordinate with the field added by
      `cadre-provider-seed-endpoint-never-populated`).
- [ ] Add `HostIp: '127.0.0.1'` to the health/seed `PortBindings` entry; decide
      and document the metrics-port binding.
- [ ] Add `Authorization: Bearer <token>` to the seed-delivery `fetch` in
      `ContainerService.applySeed`.
- [ ] Update/extend provider tests to assert the bearer header is sent and that
      a missing token surfaces a clear error.
- [ ] `yarn workspace @serfab/cadre-provider build` and `... test` green.

## Notes

- Does not address the seed *trust-policy* gap
  (`seed-signerkey-trust-policy-self-asserting`); that is orthogonal and tracked
  separately.
