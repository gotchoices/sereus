description: Provider now populates Container.seedEndpoint through the orchestrator contract, so provider-delivered seed application (PUT /containers/:id/seed → node POST /seed) is functional end-to-end.
files: packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts
----

## What shipped

The provider's seed-delivery path was dead: nothing in provisioning ever set `Container.seedEndpoint`, so `ContainerService.applySeed` always failed its `if (!container.seedEndpoint)` guard before any request was made, making `PUT /containers/:id/seed` permanently non-functional. The fix surfaces the seed endpoint through the orchestrator contract and persists it:

1. **`OrchestratorCreateResult` gained `seedEndpoint: string`** (`service/orchestrator.ts:25-36`), documented as "the URL of the node's seed API (`POST /seed`), served on the health server's port".
2. **`DockerOrchestrator.createContainer`** returns `seedEndpoint: \`http://localhost:${healthPort}/seed\`` (`docker-orchestrator.ts:115-123`) — same host/port as `healthEndpoint`, path `/seed`. The node's seed API is bound to the health server's port (confirmed below).
3. **`MockOrchestrator.createContainer`** returns `seedEndpoint: \`http://localhost:${8080 + idCounter}/seed\`` (`orchestrator.ts:83-90`) — same port it already uses for `healthEndpoint`.
4. **`provisionContainer`** copies `updated.seedEndpoint = result.seedEndpoint` alongside the other orchestrator-provided endpoints (`container-service.ts:99-103`).

After this, a provisioned container reaching `enrolling`/`running` has a `seedEndpoint`, the `applySeed` guard passes, and the seed is POSTed to the node's `/seed` API.

## Why the endpoint shape is correct (contract verification)

The node-side seed API is served by cadre-cli `HealthServer` on the **same port as `/health`**, at `POST /seed`:
- Route dispatch: `packages/cadre-cli/src/server/health.ts:201-202` (`url.pathname === '/seed' && req.method === 'POST'`).
- Handler `handleSeedRequest` (`health.ts:222-258`): reads JSON body `{ seed }`, base64url-decodes, calls `node.applySeed(...)`, responds `{ success, peersAdded?, error? }`.

That body shape (`{ seed: encodedSeed }`) and result shape are exactly what `ContainerService.applySeed` already sends and parses (`container-service.ts:251-264`). The endpoint is therefore the health endpoint with `/health` → `/seed` — directly analogous to the existing `statusUrlFromHealthEndpoint` derivation (`container-health.ts:35`). **No node-side change was required; the contract already matched.** This realigns code with `docs/architecture.md` Provider Flow steps 6-7 ("Forward seed" / "applySeed") — no doc rewrite needed.

## How to test / validate (use cases)

Regression test added: `packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts` (follows the `MemoryStore` + `MockOrchestrator` + mocked `globalThis.fetch` pattern from `billing-collect-usage.test.ts`). It drives the private `provisionContainer` directly (cast to a typed `ProvisionInternal` surface) so the orchestrator→store path runs without the racy fire-and-forget `createContainer` background task. Three cases:

- **Persists a `/seed` endpoint on the health server port.** After provisioning, `seedEndpoint` is defined, ends in `/seed`, and equals `healthEndpoint.replace('/health','/seed')` (proves same host/port).
- **`applySeed` forwards correctly.** With `fetch` routed by URL (`/seed` → `{ success: true, peersAdded: 2 }`, `/health` → healthy during enrollment), `applySeed` returns the node's result verbatim and the `/seed` call is a `POST` with body `{ seed: 'encoded-seed-xyz' }`.
- **Guard still protects un-provisioned containers.** A running container with `seedEndpoint: undefined` (e.g. legacy record) still returns `{ success: false, error: 'Container does not have a seed endpoint' }` and never calls `fetch`.

Reviewer angles worth probing:
- The pre-fix failure was structural; the guard test documents the old behavior but the "before" path is no longer exercisable through provisioning. Confirm the test would actually fail if step 4 (the `provisionContainer` copy) were reverted — it should, via the first two cases.
- `MockOrchestrator` derives `seedEndpoint` from `8080 + idCounter` independently of its `healthEndpoint` literal. They coincide today; if someone later changes the mock's health port formula, the "same port" invariant could silently drift. The Docker orchestrator (the real path) derives both from the single `healthPort` variable, so it can't drift.

## Known gaps / honesty for the reviewer

- **No live Docker integration test.** Validation is structural (mock orchestrator + mocked fetch). The real `DockerOrchestrator.createContainer` path and an actual cadre-cli `/seed` round-trip are not exercised here — that belongs to integration-tests, not a unit ticket. The contract match is verified by code inspection (health.ts citations above), not by a running node.
- **Auth is a separate concern.** Sibling implement ticket `cadre-provider-seed-endpoint-auth` covers authentication/authorization on the seed path; this ticket only makes the endpoint reachable. The two are orthogonal — populating `seedEndpoint` does not change the auth surface.
- **`applySeed`'s `fetch` has no timeout** (pre-existing, matches `getContainerStatus`/`waitForEnrollment`). A hung node `/seed` would stall the call. Not introduced here; noted for completeness.
- **No port-collision / endpoint-uniqueness assertions** across multiple provisioned containers — out of scope; the orchestrators own port allocation.

## Validation performed

- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc strict, `tsconfig.build.json`).
- `npx tsc --noEmit -p tsconfig.json` (base config, **includes** test files which the build excludes) → exit 0. Caught and fixed one test-only type error (fetch mock needed a second `init` parameter for the call-tuple assertion).
- `yarn workspace @serfab/cadre-provider test` → 22/22 pass (3 new seed-endpoint + 6 billing + 3 store-persistence + 10 pre-existing shutdown). No ESLint configured in this monorepo; strict `tsc` is the lint/type-check surrogate.
