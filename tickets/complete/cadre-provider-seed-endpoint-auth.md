description: Provider-side wiring that authenticates seed delivery to the container's gated POST /seed (per-container bearer token) and confines the health/seed/metrics surface to loopback. Reviewed + hardened against a secret-leak regression.
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/types.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/__tests__/container-token-redaction.test.ts, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts
----

## What landed

The cadre container gates `POST /seed` behind `Authorization: Bearer <CADRE_SEED_TOKEN>`
(and refuses to register the route when the env var is empty). The provider now:

- mints a per-container 256-bit token (`randomBytes(32).toString('base64url')`) in
  `DockerOrchestrator.createContainer`, injects it as `CADRE_SEED_TOKEN`, and returns
  it on `OrchestratorCreateResult.seedToken`;
- persists it onto the stored `Container` (`provisionContainer`) and presents it as
  `Authorization: Bearer <token>` on `applySeed`, with a clear pre-fetch guard
  (`'Container does not have a seed token'`) for records that lack one;
- binds the container's `8080/tcp` (health + seed) and `9090/tcp` (metrics) host
  publications to `127.0.0.1`, leaving `4001/tcp` (libp2p p2p) on all interfaces.

The contract was verified end-to-end against the container side: `CADRE_SEED_TOKEN`
is read in `cadre-cli/src/commands/start.ts`, the route is registered only when the
token is non-empty (`health.ts`), and `checkBearer` (`bearer.ts`) does a
constant-time `Bearer <token>` compare. `base64url` is bearer-safe (no whitespace/`:`).

## Review findings

### Checked

- **Implement diff read first, fresh eyes** — `docker-orchestrator.ts`,
  `container-service.ts`, `orchestrator.ts`, `types.ts`, and all three test files,
  before the handoff summary.
- **Cross-package contract** — env-var name, route-registration gate, and bearer
  header format all match the container side (`start.ts`, `health.ts`, `bearer.ts`).
  Token entropy/encoding is sound and round-trips as a bearer token.
- **`applySeed` guard ordering** — not-found → wrong-status → no-endpoint →
  no-token → fetch. Correct; the no-token guard short-circuits before any network
  call (covered by test).
- **Loopback binding vs. deployment model** — confirmed the provider's
  health/metrics→`127.0.0.1`, p2p→all-interfaces split exactly mirrors the
  documented deployment defaults (`packages/cadre-cli/docker/*`,
  `ops/docker/sereus-node/*`: `HOST_HEALTH_BIND`/`HOST_METRICS_BIND` default
  `127.0.0.1`). The metrics-loopback decision the implementer flagged is **correct**.
  Defense-in-depth holds: even a co-tenant container reachable on the node's
  in-container `0.0.0.0:8080` still needs the bearer token to drive `/seed`.
- **Resource cleanup / port-leak path** — token minting sits inside the existing
  try/cleanup envelope; no new leak path. Verified by `orchestrator-port-leak.test.ts`.
- **Store mutation safety** — the new redaction helper (below) builds a fresh object
  via rest-spread and never mutates the stored record.

### Found + fixed (minor — fixed in this pass)

- **Secret leak: `seedToken` was serialized to the provider's HTTP API.** Adding
  `seedToken` to the `Container` type meant the three read routes that serialize a
  full `Container` — `GET /containers`, `GET /containers/:id`, `POST /containers` —
  would hand the freshly-minted seed credential to any client holding
  `containers:read`. The node is loopback-bound so it is not *directly* remotely
  exploitable, but emitting a per-container bearer secret in API responses
  undermines the exact secret this ticket introduces (and the handoff never flagged
  it). **Fix:** added a `redactContainer()` helper in `routes.ts` that strips
  `seedToken` at the API boundary, applied to all three sites. The token stays at
  rest in the store (where `applySeed` reads it directly) but never crosses the wire.
  Added `container-token-redaction.test.ts` (3 cases) pinning that list/get/create
  responses omit the field and never contain the stored token value, while asserting
  the secret really is present in the store (so the test can't pass vacuously).

### Found — not actionable here (already flagged / out of scope)

- **Token durability** (token store-resident; a `MemoryStore` provider restart
  orphans a running container's env-injected token) — same profile as
  `dockerId`/`seedEndpoint`, not a regression; persistent stores retain it.
- **Token at rest is plaintext** — consistent with every other field; acceptable
  pre-1.0.
- **Legacy containers** provisioned before this change fail `applySeed` with the
  clear guard rather than a silent 401 — acceptable; re-provision to recover.
- **No real cross-process integration test** of provider → live node `POST /seed`.
  The DockerOrchestrator test mocks dockerode and the container side is covered by
  cadre-cli's `bearer.spec.ts` / `health-server.spec.ts`, but the round trip is
  unverified in-tree. Left as-is (an `integration-tests` scenario would close it);
  not blocking and not a regression.
- **Seed trust-policy gap** (`seed-signerkey-trust-policy-self-asserting`) — the
  bearer gate authenticates the *delivery path* only, not seed *trust*. Explicitly
  out of scope per the source ticket and documented in `health.ts`.

### Not done

- No new fix/plan tickets filed — the one real finding was a contained
  serialization fix, dispositioned minor and fixed inline.

## Validation

- `yarn workspace @serfab/cadre-provider build` — green.
- `yarn workspace @serfab/cadre-provider test` — **78 passed (12 files)** (was
  75/11; +3 redaction regression tests).
- ESLint on touched files — **0 errors** (7 pre-existing `(request as any).customer`
  `any` warnings in `routes.ts`, none introduced by this change).
