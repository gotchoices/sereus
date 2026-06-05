description: ContainerService.getPeerInfo caches peerId/multiaddrs warm-once on the container and never invalidates them. Once warmed, every future GET /containers/:id/peer short-circuits the cache with no TTL/refresh, so after a container restart that re-keys its libp2p identity or remaps its multiaddrs the route serves stale dial info indefinitely. The sibling getContainerStatus re-fetches /status live on every call — getPeerInfo is asymmetric. The recently-landed getpeerinfo-reads-status-not-health fix newly activated this latent bug: previously the /health read path meant the cache never warmed (the route always 503'd), so warm-once staleness was unreachable. Now it is.
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts
prereq: cadre-provider-getpeerinfo-reads-status-not-health
----

## Problem

`getPeerInfo` (`container-service.ts:311-332`) is the **only** writer of
`Container.peerId` / `Container.multiaddrs` (verified by grep across
`packages/cadre-provider/src`). Nothing on enrollment, restart, container
recreation, or termination ever resets them. So:

1. First successful `getPeerInfo` fetches `/status`, caches `{peerId, multiaddrs}`
   on the container, and persists.
2. Every subsequent call hits the cache branch (`container-service.ts:316-318`)
   and returns the stored value **without any TTL or freshness check**.
3. If the container restarts and its libp2p identity re-keys (no persisted
   identity volume) or its mapped multiaddrs change (Docker port/IP reassignment),
   `GET /containers/:id/peer` serves the **stale** peerId/multiaddrs forever, and
   customers can no longer dial the node.

Contrast `getContainerStatus` (`container-service.ts:192-207`), which calls
`fetchContainerHealthStatus` **live on every request** and caches nothing. The two
sibling read paths over the same `/status` payload disagree on freshness.

This is not a regression introduced by the warm-once code itself (that caching
predates the recent fix), but the `getpeerinfo-reads-status-not-health` fix
**activated** it: before that fix, `getPeerInfo` read `/health` (which carries
only `{ status }`), so `peerId`/`multiaddrs` were always `undefined`, the cache
never warmed, and the route uniformly returned 503. The staleness path was dead
code. It is now live for the first time.

## Decision needed

Pick a caching policy for peer info and align it with the rest of the service:

- **Live every call** (simplest, matches `getContainerStatus`): drop the
  warm-once cache entirely; always `fetchContainerHealthStatus` and return.
  Trade-off: one `/status` round-trip per `/peer` request.
- **TTL cache**: keep the cached value but stamp it (reuse `container.updatedAt`
  or add a dedicated field) and re-fetch once older than some TTL.
- **Explicit invalidation**: clear `container.peerId`/`multiaddrs` on
  restart/terminate/recreate so warm-once stays correct across lifecycle events.

Live-every-call is the recommended default unless there is a concrete reason to
shield containers from per-request `/status` load (none is evident — the route is
customer-gated and low-frequency).

## Acceptance

- `getPeerInfo` no longer serves indefinitely-stale peer info after a container
  identity/multiaddr change.
- Behavior is consistent with `getContainerStatus`'s freshness model (or the
  divergence is documented with a reason).
- Regression test: warm a value, change what `/status` returns, assert the second
  call reflects the change (the current
  `__tests__/container-get-peer.test.ts` "caches ... skips the fetch" test
  asserts the *opposite* and will need to be updated to match the chosen policy).
