description: COMPLETE — ContainerService.getPeerInfo reads the live `/status` payload on every call with no cache, matching getContainerStatus's freshness model. The warm-once peerId/multiaddrs cache (which served stale dial info forever after a restart re-keyed identity or remapped multiaddrs) and its only writer are gone. The now-dead `Container.peerId`/`multiaddrs` fields were removed from types.ts. Reviewed: change verified correct, field-removal safety independently confirmed across all packages, lint + typecheck + 80 tests green.
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts, packages/cadre-provider/src/types.ts
----

# Complete: getPeerInfo live every call

`GET /containers/:id/peer` (`server/routes.ts:227`) now always reflects the
container's current libp2p dial info. The warm-once cache that served stale
`peerId`/`multiaddrs` indefinitely after a restart is removed, and the two
`/status` read paths (`getContainerStatus`, `getPeerInfo`) now agree on
freshness — both fetch live and cache nothing.

## What shipped

- **`container-service.ts:316-326`** — `getPeerInfo` deleted the cache
  short-circuit and the cache write (`peerId`/`multiaddrs`/`updatedAt` +
  `saveContainer`). It now unconditionally calls `fetchContainerHealthStatus`
  and returns `{ peerId, multiaddrs }` when both are present on the live
  `/status` payload, else `undefined`. Doc comment rewritten to explain the
  live-every-call policy and why the old cache was wrong.
- **`types.ts`** — removed the dead `Container.peerId` / `Container.multiaddrs`
  optional fields (nothing writes or reads them after the change).
- **`container-get-peer.test.ts`** — the former "caches … skips the fetch" case
  became "re-fetches live every call, reflecting peer info that changed after a
  restart" (old value first call, new value second, two fetches). Eight
  surrounding branch cases unchanged.

## Review findings

### What was checked

- **Implement diff read first** (`git show e2da88d`) before the handoff summary.
- **Correctness of the change** — `getPeerInfo` (`container-service.ts:316-326`)
  is a clean delegation to `fetchContainerHealthStatus` with correct
  "not-available" handling (`!status?.peerId || !status.multiaddrs?.length →
  undefined`). The null-peerId and empty-multiaddrs branches are both covered.
- **Field-removal safety (the highest-risk claim)** — independently verified,
  not taken from the handoff:
  - `git grep` for `container.peerId` / `container.multiaddrs` / `.peerId =` /
    `.multiaddrs =` across `packages/cadre-provider/*` → **no matches**. The
    only `peerId`/`multiaddrs` symbols left in the package are the *live*
    `ContainerHealthStatus` wire type (`container-health.ts:31-32`) and the
    `getPeerInfo` return shape — neither is the removed `Container` field.
  - Cross-package: the sole external importer of `@serfab/cadre-provider`
    (`cadre-host`) imports only `Orchestrator*`, `ContainerStatus`,
    `ContainerResources` (`cadre-host/src/index.ts:21-28`,
    `server/events/types.ts:8`, `orchestrator/host-process-orchestrator.ts`).
    All `peerId`/`multiaddr` hits in `cadre-host/src` are trust-circle /
    authority-node *member* records, unrelated to the provider `Container`.
  - `typecheck` passing is independent proof there are no remaining type
    referencers.
- **Status-response side effect** — `redactContainer` (`routes.ts:34-37`)
  spreads the whole `Container` minus `seedToken` into both the list and status
  responses, so the removed fields silently drop out of the `data.container`
  shape. Confirmed no test asserts peer fields on the status/list responses, and
  the only external consumer (`cadre-host`) never reads them off the wire shape.
  **Positive correction to the handoff's "honest gap":** `GET /containers/:id`
  still carries live peer info — `getContainerStatus` attaches the live
  `ContainerHealthStatus` under `data.health` (`container-service.ts:202-204`),
  and that payload has top-level `peerId`/`multiaddrs`. So a status consumer that
  wants dial info reads `data.health.peerId` (live, fresh) rather than the old
  `data.container.peerId` (stale). Peer info was not lost from `/status`, only
  the stale persisted copy was.
- **Test coverage** — happy path, derived `/status` URL, the new
  re-fetch-every-call regression guard, null peerId, peerId-without-multiaddrs,
  non-OK response, omitted peer fields, fetch-throws, and unknown id. Branch
  coverage of `getPeerInfo` is complete at the service layer.
- **Docs** — read `docs/` and `cadre-provider/README.md`. No doc referenced the
  removed `Container.peerId`/`multiaddrs` fields or the cache behavior; the
  README only lists the route + scope (`README.md:145`), which is unchanged.
  Nothing to update.
- **Lint / typecheck / test** — all green (see below).

### Findings

- **Correctness:** none. The change is minimal and does exactly what the ticket
  specified.
- **Major:** none — no new tickets filed.
- **Minor (noted, not fixed):** the test helper `makeService` still returns
  `{ service, store }` but no case in the file destructures `store` after the
  rewrite. This is a harmless extra return property on a per-file test helper
  (not an unused-variable lint error, and plausibly useful for future cases), so
  it was left as-is rather than churned.
- **Resource cleanup / error handling / type safety / DRY:** clean.
  `fetchContainerHealthStatus` centralizes the `/status` derivation and
  never-throws contract; `getPeerInfo` reuses it rather than duplicating fetch
  logic. No `any`, no eaten exceptions.

### Coverage gaps left open (acceptable, by design)

- **No route/HTTP-level test** for `/peer` freshness — validation is
  service-layer unit only. The route handler (`routes.ts:227-256`) is a thin
  auth+ownership wrapper over `getPeerInfo` with no caching of its own, so the
  service-layer regression guard covers the freshness behavior. A focused route
  or integration test would be the highest-value follow-up but is not required
  for correctness; not filed as a ticket.
- **Load posture:** every `/peer` hit triggers one `/status` round-trip — the
  accepted trade-off, identical to the cost `getContainerStatus` already pays on
  every `GET /containers/:id`. The route is `ContainersRead`-gated and
  low-frequency. Non-issue.

### Validation (ran green)

- `yarn workspace @serfab/cadre-provider typecheck` — clean.
- `yarn workspace @serfab/cadre-provider test` — **80 passed (12 files)**.
- `yarn eslint` on the three changed files — clean (no per-package lint script;
  ran the root ESLint directly).
