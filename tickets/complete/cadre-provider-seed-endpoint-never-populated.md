description: Provider populates Container.seedEndpoint through the orchestrator contract, so provider-delivered seed application (PUT /containers/:id/seed → node POST /seed) is functional end-to-end. Reviewed and completed.
files: packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts
----

## What shipped

The provider's seed-delivery path was dead: nothing in provisioning ever set `Container.seedEndpoint`, so `ContainerService.applySeed` always failed its `if (!container.seedEndpoint)` guard before any request was made, making `PUT /containers/:id/seed` permanently non-functional. The fix surfaces the seed endpoint through the orchestrator contract and persists it:

1. **`OrchestratorCreateResult` gained `seedEndpoint: string`** (`service/orchestrator.ts:33`), documented as the URL of the node's seed API (`POST /seed`), served on the health server's port.
2. **`DockerOrchestrator.createContainer`** returns `seedEndpoint: http://localhost:${healthPort}/seed` (`docker-orchestrator.ts:120`) — same host/port as `healthEndpoint`, path `/seed`.
3. **`MockOrchestrator.createContainer`** returns `seedEndpoint: http://localhost:${8080 + idCounter}/seed` (`orchestrator.ts:89`) — same port it already uses for `healthEndpoint`.
4. **`provisionContainer`** copies `updated.seedEndpoint = result.seedEndpoint` alongside the other orchestrator-provided endpoints (`container-service.ts:102`).

After this, a provisioned container reaching `enrolling`/`running` has a `seedEndpoint`, the `applySeed` guard passes, and the seed is POSTed to the node's `/seed` API.

## Review findings

### Scrutiny performed (with fresh eyes on the diff first)

- **Re-read the implement diff** (`ccea6e0`) before the handoff summary: orchestrator-contract field, both orchestrator returns, the `provisionContainer` copy, the persisted `Container.seedEndpoint` field (`types.ts:80`), and the new test.
- **Verified the node-side contract independently** in `packages/cadre-cli/src/server/health.ts`: `POST /seed` is dispatched on the same `HealthServer` as `/health`/`/status`/`/ready` (`health.ts:201-202`), so it is served on the health *port*; `handleSeedRequest` (`health.ts:222-258`) reads `{ seed }`, base64url-decodes, calls `node.applySeed`, and replies `{ success, peersAdded?, error? }`. This is exactly the body/result shape `ContainerService.applySeed` sends and parses (`container-service.ts:251-265`). The endpoint shape (`/health` → `/seed`) is correct. **No node-side change required.**
- **Confirmed the route wiring** `PUT /containers/:id/seed` (`routes.ts:229-264`): authenticates, checks ownership, requires a `seed` body, delegates to `applySeed`. Now reachable end-to-end.
- **Confirmed docs are accurate**: `docs/architecture.md` Provider Flow (lines 537-540: `POST /containers/:id/seed` → "Forward seed" → `applySeed()`, and steps 6-8 around lines 184-185/231-232) already describe this behavior. The fix realigns code with the existing doc — **no doc change needed**.
- **Build / type / tests**: `yarn workspace @serfab/cadre-provider build` → exit 0; `npx tsc --noEmit -p tsconfig.json` (base config, includes excluded-from-build test files) → exit 0; `yarn workspace @serfab/cadre-provider test` → **24/24 pass**. No ESLint is configured in this monorepo; strict `tsc` is the type/lint surrogate.

### Findings and disposition

- **MINOR — fixed inline. Test coverage gap on the now-live seed path.** The implementer's 3 tests covered happy-path-after-running and the guard. I added two focused cases to `container-seed-endpoint.test.ts`:
  - `applySeed` forwards while the container is still **`enrolling`** — this is the actual cold-start flow (`docs/architecture.md` steps 6-8), and the `applySeed` guard explicitly allows `enrolling`; the prior tests only exercised the post-`running` state.
  - `applySeed` surfaces a **non-OK node response** as `Seed endpoint returned 500: …` (the error path through `container-service.ts:258-261`), which the seed delivery this ticket makes live now actually depends on.
  Both pass; required adding a typed `(_url, _init)` signature to one `vi.fn` mock so its call-tuple type is non-empty (the same test-only type wrinkle the implementer noted).

- **NOT A DEFECT — DRY (derive vs. store) evaluated and rejected as a change.** Same-port sibling endpoints elsewhere are *derived* not stored (`statusUrlFromHealthEndpoint`, `container-health.ts:35`), so storing `seedEndpoint` as its own contract+persisted field looks redundant at first glance. It is intentional and must stay: sibling implement ticket `cadre-provider-seed-endpoint-auth` plans to carry a per-container seed **token / authenticated seed endpoint** on `OrchestratorCreateResult` and the stored `Container` (see that ticket's Design + TODO). Deriving the URL from `healthEndpoint` would conflict with that forthcoming auth work. No change made.

- **NOT FILED — security surface is already tracked.** The seed endpoint is currently unauthenticated and the Docker health/seed port binds on `0.0.0.0`. This is explicitly owned by sibling tickets `cadre-cli-seed-endpoint-auth` (gates `POST /seed` behind `CADRE_SEED_TOKEN`) and `cadre-provider-seed-endpoint-auth` (sends the bearer token + adds `HostIp: 127.0.0.1`). This ticket is scoped only to making the endpoint *reachable*; no new ticket needed.

- **NOTED, NOT FILED — `applySeed` `fetch` has no timeout.** Pre-existing; matches `getContainerStatus`/`waitForEnrollment`/`getPeerInfo` in the same file. Not introduced by this change; a hung node `/seed` would stall the call. Out of scope.

- **NOTED, NOT FILED — `MockOrchestrator` port drift.** Its `seedEndpoint` (`8080 + idCounter`) is derived independently of its `healthEndpoint` literal, so the "same port" invariant could silently drift if someone edits one formula. Cosmetic and test-only — the real `DockerOrchestrator` derives both from the single `healthPort` variable and cannot drift; the test asserts `seedEndpoint === healthEndpoint.replace('/health','/seed')`, which would catch a mock drift. Not worth a code change.

**Empty categories:** No major findings → **no new fix/plan tickets filed**. No documentation changes required (docs already matched, verified above). No pre-existing test failures encountered.

## Validation performed

- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc strict, `tsconfig.build.json`).
- `npx tsc --noEmit -p tsconfig.json` (base config — includes test files excluded from the build) → exit 0.
- `yarn workspace @serfab/cadre-provider test` → 24/24 pass (5 seed-endpoint incl. 2 added in review + 6 billing + 3 store-persistence + 10 shutdown).
