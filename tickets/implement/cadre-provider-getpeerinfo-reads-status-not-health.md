description: Fix ContainerService.getPeerInfo to read peerId/multiaddrs from the container's /status endpoint (where they live) instead of /health (which returns only { status }), so GET /containers/:id/peer stops always returning 503. Fix is already applied + validated in the fix stage; implement stage validates and produces the review handoff.
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-provider/src/server/routes.ts
----

## Summary

`ContainerService.getPeerInfo` (`container-service.ts`) backs `GET /containers/:id/peer`
(`routes.ts:218`). It previously fetched `container.healthEndpoint` — the **`/health`** URL — and
read `peerId`/`multiaddrs` from the body. But the cadre-cli `/health` route emits only
`{ status }` (`packages/cadre-cli/src/server/health.ts`), so those fields were always `undefined`,
the caching branch never ran, nothing else in the provider warms `container.peerId` / `multiaddrs`,
and the route therefore **always returned `503 NOT_AVAILABLE`**. `peerId` (`string | null`) and
`multiaddrs` (`string[]`) live at the top level of the richer **`/status`** (`HealthStatus`) payload.

## Change applied (fix stage)

The fix reuses the existing shared helper rather than re-deriving the `/status` URL inline:

- `container-health.ts` — extended the locally-typed `ContainerHealthStatus` interface (the subset of
  the cadre-cli `/status` payload the provider consumes) with top-level optional
  `peerId?: string | null` and `multiaddrs?: string[]`. The `/status` URL derivation
  (`statusUrlFromHealthEndpoint`) and the fetch helper (`fetchContainerHealthStatus`) are unchanged
  and now carry the peer fields through.

- `container-service.ts` — rewrote `getPeerInfo` to call `fetchContainerHealthStatus(container)`
  (same helper `getContainerStatus` uses), then treat a `null`/empty `peerId` or empty `multiaddrs`
  as "not available" (`return undefined`) — guarding the node-still-starting case. On success it
  caches `peerId`/`multiaddrs` on the container and returns them. The old inline `fetch` of
  `container.healthEndpoint` with the loose `{ peerId?, multiaddrs? }` cast is gone.

- `__tests__/container-get-peer.test.ts` — new regression suite mirroring
  `container-get-status.test.ts`'s fetch-mock pattern: running container whose `/status` body carries
  `peerId` + `multiaddrs` → returns them and hits the **`/status`** URL (not `/health`); caches so a
  second call skips the fetch; `null` peerId / omitted peer fields / fetch failure / unknown id →
  `undefined`.

## Validation already run (fix stage)

- `yarn workspace @serfab/cadre-provider test` → 8 files, **45 passed** (7 new).
- `yarn workspace @serfab/cadre-provider typecheck` → clean.
- `eslint` over the three changed files → clean.

## Notes

- Pre-existing bug; not introduced by `cadre-provider-container-status-strands-type-drift` (which
  scoped itself to `getContainerStatus` and left `getPeerInfo` alone).
- AGENTS.md "no backwards compatibility yet" — the broken `/health` read path was removed outright.

## TODO

- Re-confirm `yarn workspace @serfab/cadre-provider test` and `typecheck` are green on the committed tree.
- Spot-check `routes.ts:218` (`GET /containers/:id/peer`) still maps an `undefined` return to `503`
  and a populated return to `{ peerId, multiaddrs }` — no route-layer change was needed, but confirm.
- Produce the review-stage handoff (honest about any gaps, e.g. that caching is in-memory/store-only
  and never invalidated once warmed).
