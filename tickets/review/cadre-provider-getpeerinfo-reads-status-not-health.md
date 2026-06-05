description: Review the fix to ContainerService.getPeerInfo — it now reads peerId/multiaddrs from the container's /status payload (via the shared fetchContainerHealthStatus helper) instead of /health (which returns only { status }), so GET /containers/:id/peer no longer always returns 503. Change + regression suite already landed; validate and adversarially probe.
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-cli/src/server/health.ts
----

## What shipped

`getPeerInfo` (`container-service.ts:311-332`, backing `GET /containers/:id/peer`,
`routes.ts:227`) used to `fetch(container.healthEndpoint)` — the **`/health`** URL — and read
`peerId`/`multiaddrs` off that body. But cadre-cli's `/health` route emits only
`{ status }` (`health.ts:271-275`); those fields are always `undefined` there, the cache branch
never warmed (nothing else in the provider writes `container.peerId`/`multiaddrs`), and the route
therefore **always returned 503 NOT_AVAILABLE**. `peerId` (`string | null`) and `multiaddrs`
(`string[]`) live at the top level of the richer **`/status`** (`HealthStatus`) payload
(`health.ts:154-159`, served verbatim at `health.ts:280-283`).

The fix reuses the existing shared helper rather than re-deriving the `/status` URL inline:

- `container-health.ts:28-36` — local `ContainerHealthStatus` (the provider's narrowed slice of the
  cadre-cli `/status` shape) gained top-level optional `peerId?: string | null` and
  `multiaddrs?: string[]`. URL derivation (`statusUrlFromHealthEndpoint`) and the fetch helper
  (`fetchContainerHealthStatus`) are otherwise unchanged and now carry the peer fields through.
- `container-service.ts:311-332` — `getPeerInfo` now: returns the cached `{peerId, multiaddrs}` when
  both are present; else calls `fetchContainerHealthStatus(container)` (the same helper
  `getContainerStatus` uses); treats `null`/empty `peerId` **or** empty `multiaddrs` as "not
  available" (`return undefined`), guarding the node-still-starting case; on success caches both on
  the container, persists, and returns. The old inline `fetch(container.healthEndpoint)` + loose
  `{ peerId?, multiaddrs? }` cast is gone.
- `__tests__/container-get-peer.test.ts` — new 7-test regression suite (fetch-mock pattern mirrored
  from `container-get-status.test.ts`).

No route-layer change: `routes.ts:247-255` already maps an `undefined` return to
`503 NOT_AVAILABLE` and a populated return to `{ ok: true, data: { peerId, multiaddrs } }`
(note: the peer object is **wrapped** under `data`, not returned bare).

## Validation re-run during implement (the floor — treat as a starting point)

- `yarn workspace @serfab/cadre-provider typecheck` → exit 0, clean.
- `yarn workspace @serfab/cadre-provider test` → 12 files, **78 tests pass** (suite has grown since
  the fix-stage 8-file/45-test snapshot; all green, includes the 7 new peer tests).
- `yarn eslint` over the three changed files → exit 0.

## Use cases the suite covers

- Running container whose `/status` body carries `peerId` + `multiaddrs` → returns exactly those.
- Hits the **derived `/status`** URL (`http://localhost:8080/status`), not `/health` — asserted on
  the fetch mock.
- Caches on the container: a second call returns the same value and the fetch mock is called once;
  the persisted store record carries the warmed `peerId`.
- `/status` reports `peerId: null` + `multiaddrs: []` (node still starting) → `undefined`.
- `/status` omits the peer fields entirely → `undefined`.
- `/status` fetch throws (connection refused) → `undefined` (helper swallows, never propagates).
- Unknown container id → `undefined`.

## Known gaps / where to probe (honest)

- **The peer cache is warmed-once and never invalidated.** Once `container.peerId`/`multiaddrs` are
  set they short-circuit every future `getPeerInfo` with no TTL or refresh. If a container restarts
  and re-keys its libp2p identity (or its multiaddrs change), the route will serve **stale** values
  indefinitely. Note the asymmetry with `getContainerStatus`, which re-fetches `/status` live on
  every call. Decide whether peer info should also be live/TTL'd or whether warm-once is acceptable
  here — this is the most consequential design question in the diff.
- **Tests mock `globalThis.fetch`** — no real HTTP server, no real cadre-cli `/status` round-trip.
  The `/health`→`/status` URL rewrite is exercised only through the simple
  `http://localhost:8080/health` case.
- **`statusUrlFromHealthEndpoint` is a naive `.replace('/health', '/status')`** (shared/pre-existing,
  also used by `getContainerStatus`). It rewrites the first `/health` substring only; an endpoint
  whose host or earlier path segment contained `/health` could mis-rewrite. Not introduced here, but
  worth a glance given this ticket newly depends on it for peer data.
- **No timeout on the `/status` fetch** — pre-existing, inherited from the helper, matches
  `applySeed`/`waitForEnrollment`; already on the sibling status ticket's accepted-gaps list. Out of
  scope.
- **No ownership/route test** — the 503-vs-200 mapping and the customer-ownership guard
  (`routes.ts:243-249`) are unchanged and untested by this suite (service-level only). The fix is
  service-internal, so this is reasonable, but the reviewer may want to confirm the end-to-end
  503→200 transition is what they expect.

## Context

- Pre-existing bug, surfaced (and filed) by `cadre-provider-container-status-strands-type-drift`,
  which deliberately scoped itself to `getContainerStatus` and left `getPeerInfo` alone.
- AGENTS.md "no backwards compatibility yet" — the broken `/health` read path was removed outright,
  not deprecated.
