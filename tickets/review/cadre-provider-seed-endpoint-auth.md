description: Review the provider-side wiring that authenticates seed delivery to the container's gated POST /seed and confines the health/seed/metrics surface to loopback
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/types.ts, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/src/service/__tests__/container-provision-cleanup.test.ts
----

## What this implements

The cadre container gates `POST /seed` behind `Authorization: Bearer <CADRE_SEED_TOKEN>`
(and refuses to register the route at all when the env var is empty). The provider
is the in-tree consumer of that endpoint, so it now mints a per-container token,
injects it, presents it on seed delivery, and stops publishing the seed/health
surface to the world.

Both prereqs already landed (`cadre-cli-seed-endpoint-auth` and the sibling
`cadre-provider-seed-endpoint-never-populated`), so `Container.seedEndpoint` was
already populated; this ticket was purely the secret + host-binding wiring.

### Changes

- **`docker-orchestrator.ts`** — generate `seedToken = randomBytes(32).toString('base64url')`
  (256-bit) per container; inject as `CADRE_SEED_TOKEN` in `Env`; return it on the
  create result. Added `HostIp: '127.0.0.1'` to the `8080/tcp` (health + seed) and
  `9090/tcp` (metrics) `PortBindings`. The `4001/tcp` p2p binding is intentionally
  left on all interfaces (libp2p peers must reach it).
- **`orchestrator.ts`** — added required `seedToken: string` to `OrchestratorCreateResult`;
  `MockOrchestrator` returns a deterministic `mock-seed-token-<n>`.
- **`types.ts`** — added optional `seedToken?: string` to the stored `Container`.
- **`container-service.ts`** — `provisionContainer` copies `result.seedToken` onto the
  stored container; `applySeed` sends `Authorization: Bearer <token>` and now guards a
  missing token with a clear error (`'Container does not have a seed token'`) before
  any fetch.

### Metrics-port binding decision (called out by the ticket)

I bound metrics (9090) to loopback alongside health/seed. Rationale: the provider
already stores `metricsEndpoint` as `http://localhost:<port>/metrics`, so any
scraping was always host-local; and this matches the cadre-cli deployment hardening
(`HOST_METRICS_BIND` defaults to `127.0.0.1`). **Reviewer: confirm this matches the
intended deployment** — if an operator scrapes metrics from a remote Prometheus, they
must now go through the provider host / a co-located sidecar rather than hitting the
published port directly.

## Validation performed

- `yarn workspace @serfab/cadre-provider build` — green.
- `yarn workspace @serfab/cadre-provider test` — **75 passed (11 files)**.
- ESLint on all touched files — 0 errors (2 pre-existing `any` warnings in
  `getStats`, lines 205-206, untouched by this ticket).

### Test coverage (the floor, not the ceiling)

- `orchestrator-port-leak.test.ts` — new case asserts a non-empty high-entropy
  `seedToken` is returned, that the same value is injected as `CADRE_SEED_TOKEN` in
  `Env`, and that `8080`/`9090` bindings carry `HostIp: '127.0.0.1'` while `4001`
  does not. Drives the real `DockerOrchestrator` with a mocked dockerode.
- `container-seed-endpoint.test.ts` — existing "applySeed POSTs {seed}" case now
  also asserts `Authorization: Bearer mock-seed-token-1`; new cases assert (a) a
  persisted token is sent verbatim as the bearer header alongside `Content-Type`,
  and (b) a container with an endpoint but no token fails with
  `'Container does not have a seed token'` and never calls fetch. Enrolling/running
  fixtures updated to carry a `seedToken`.
- `container-provision-cleanup.test.ts` — the literal `OrchestratorCreateResult`
  fixture gained `seedToken` (type-required).

## Known gaps / things to scrutinize

- **No real cross-process integration test.** The DockerOrchestrator test mocks
  dockerode; nothing in-tree exercises provider → a *real* cadre node `POST /seed`
  with the bearer handshake end to end. The container side of the contract is
  covered by cadre-cli's `bearer.spec.ts` / `health-server.spec.ts`, but the
  round-trip is unverified here. A scenario in `integration-tests` would close this.
- **Token durability vs. running container.** The seed token lives only on the
  provider store's `Container` record. With `MemoryStore`, a provider restart loses
  the token while the container keeps running with its env-injected `CADRE_SEED_TOKEN`;
  a later `applySeed` would then hit the new missing-token guard. This is the same
  durability profile as `dockerId`/`seedEndpoint` (all store-resident), so not a
  regression — persistent stores retain it — but worth a reviewer's eye.
- **Token at rest is plaintext** in the store (same as every other field). No
  encryption; acceptable pre-1.0 and consistent with existing patterns, but flagged.
- **Legacy containers** provisioned before this change have no `seedToken` and will
  now fail `applySeed` with the clear error rather than silently 401. No migration
  path — they'd need re-provisioning. Fine pre-1.0.
- **Seed trust-policy gap is out of scope** (`seed-signerkey-trust-policy-self-asserting`),
  per the source ticket.

## Suggested review focus

1. Is loopback-binding metrics the right call for the provider's deployment model? (above)
2. Is `randomBytes(32).toString('base64url')` the right entropy/encoding, and does
   it round-trip cleanly as a bearer token (no `:` or whitespace — base64url is safe)?
3. The missing-token guard ordering in `applySeed` (after the endpoint guard, before
   fetch) and its error string.
