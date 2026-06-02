----
description: Populate Container.seedEndpoint through the orchestrator contract so provider seed delivery works
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-cli/src/server/health.ts
----
The provider's seed-delivery path is dead: nothing in the provisioning pipeline ever sets `Container.seedEndpoint`, so `ContainerService.applySeed` always fails its `if (!container.seedEndpoint)` guard (`packages/cadre-provider/src/service/container-service.ts:244-246`) before any request is made. The `PUT /containers/:id/seed` route (`packages/cadre-provider/src/server/routes.ts:229-264`) is therefore permanently non-functional, which breaks the provider-delivered cold-start enrollment flow in `docs/architecture.md` (Provider Flow, steps 6-7).

## Root cause

`OrchestratorCreateResult` (`packages/cadre-provider/src/types.ts` — note: the type actually lives in `packages/cadre-provider/src/service/orchestrator.ts:24-34`, not `types.ts`) declares only `{ dockerId, healthEndpoint, metricsEndpoint, p2pPort }`. Both orchestrators honor that shape (`DockerOrchestrator.createContainer` returns those four fields at `docker-orchestrator.ts:115-120`; `MockOrchestrator` mirrors it at `orchestrator.ts:83-88`), and `provisionContainer` copies only `dockerId`/`healthEndpoint`/`metricsEndpoint` onto the stored container (`container-service.ts:99-101`). So the persisted `Container.seedEndpoint` is always `undefined`.

## Key finding: where the node's seed API actually lives

The node-side seed API is served by the cadre-cli `HealthServer` on the **same port as `/health`**, at `POST /seed`:
- Route dispatch: `packages/cadre-cli/src/server/health.ts:201-202` (`url.pathname === '/seed' && req.method === 'POST'`).
- Handler `handleSeedRequest` (`health.ts:222-258`): reads JSON body `{ seed }`, base64url-decodes it, calls `node.applySeed(decodedSeed)`, and responds with `{ success, peersAdded?, error? }`.

This is exactly the body shape (`{ seed: encodedSeed }`) and result shape that `ContainerService.applySeed` already sends and parses (`container-service.ts:251-264`). It also means the seed endpoint is the health endpoint with `/health` → `/seed`, directly analogous to the existing `statusUrlFromHealthEndpoint` derivation (`container-health.ts:35-37`). No node-side change is required — the contract already matches.

## Fix

Surface the seed endpoint through the orchestrator result and persist it:

1. Add `seedEndpoint: string` to `OrchestratorCreateResult` (in `orchestrator.ts`), documented as "the URL of the node's seed API (`POST /seed`)".
2. `DockerOrchestrator.createContainer` returns `seedEndpoint: \`http://localhost:${healthPort}/seed\`` — same host/port as `healthEndpoint`, path `/seed` (the seed API is bound to the health server's port).
3. `MockOrchestrator.createContainer` returns `seedEndpoint: \`http://localhost:${8080 + this.idCounter}/seed\`` — same port it already uses for `healthEndpoint`.
4. `provisionContainer` copies `updated.seedEndpoint = result.seedEndpoint` alongside the other orchestrator-provided endpoints (`container-service.ts:99-101`).

After this, a provisioned container that reaches `running`/`enrolling` has a `seedEndpoint`, the `applySeed` guard passes, and the signed seed is POSTed to the node's `/seed` API.

## Reproduction (no node-side change needed)

Structural: provision a container via `MockOrchestrator`, then call `ContainerService.applySeed(id, encodedSeed)`. Before the fix it returns `{ success: false, error: 'Container does not have a seed endpoint' }`. After, `seedEndpoint` is populated, the guard passes, and (with `fetch` mocked to the node's `/seed` contract) `applySeed` forwards the seed and returns the node's result. A regression test should assert `container.seedEndpoint` is set after `provisionContainer` and that `applySeed` reaches the seed endpoint.

## TODO

- Add `seedEndpoint: string` to `OrchestratorCreateResult` in `packages/cadre-provider/src/service/orchestrator.ts` with a doc comment.
- Populate `seedEndpoint` in `DockerOrchestrator.createContainer` (`docker-orchestrator.ts:115-120`) as `http://localhost:${healthPort}/seed`.
- Populate `seedEndpoint` in `MockOrchestrator.createContainer` (`orchestrator.ts:83-88`) as `http://localhost:${8080 + this.idCounter}/seed`.
- Copy `result.seedEndpoint` onto the stored container in `provisionContainer` (`container-service.ts:99-101`).
- Add a vitest regression test under `packages/cadre-provider/src/service/__tests__/` (follow the `MemoryStore` + `MockOrchestrator` + mocked `globalThis.fetch` pattern in `billing-collect-usage.test.ts`): after provisioning, `seedEndpoint` is set and ends in `/seed`; `applySeed` POSTs `{ seed }` to that endpoint and returns the node's `{ success, peersAdded }`.
- Run `yarn workspace @serfab/cadre-provider build` and the provider test suite (e.g. `yarn workspace @serfab/cadre-provider test 2>&1 | tee /tmp/provider-test.log`); ensure type-check and tests pass.
- If touching the architecture flow understanding, keep `docs/architecture.md` Provider Flow steps 6-7 accurate (no rewrite expected — the fix realigns code with the existing doc).
