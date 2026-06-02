description: ContainerService.getPeerInfo fetches the container's `/health` URL, but `/health` returns only `{ status }` — `peerId`/`multiaddrs` live on `/status`. Nothing else ever populates the `container.peerId`/`multiaddrs` cache, so `GET /containers/:id/peer` always returns 503. getPeerInfo should fetch the derived `/status` URL (reusing the same derivation as the health helper).
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-provider/src/server/routes.ts
----

## Problem (found during review of cadre-provider-container-status-strands-type-drift)

`ContainerService.getPeerInfo` (`container-service.ts:275-306`) returns peer identity for the
`GET /containers/:id/peer` route (`routes.ts:218`). Its logic:

1. Return cached `container.peerId` / `container.multiaddrs` if present.
2. Otherwise `fetch(container.healthEndpoint)` and read `health.peerId` / `health.multiaddrs`,
   caching them on the container.

The fetch hits the **`/health`** endpoint URL stored in `container.healthEndpoint`. But the cadre-cli
health server's `/health` route emits only `{ status }`
(`packages/cadre-cli/src/server/health.ts:247-251`):

```ts
res.end(JSON.stringify({ status: status.status }));
```

`peerId` and `multiaddrs` are present **only** on the richer `/status` payload (`HealthStatus`,
top-level `peerId: string | null` and `multiaddrs: string[]` — `health.ts:21-22, 134-135`).

So `health.peerId` / `health.multiaddrs` are always `undefined` on the `/health` response, the
caching branch (`container-service.ts:292-300`) never runs, and — because nothing else in the
provider ever writes `container.peerId` / `container.multiaddrs` (the only assignments in the repo
are inside `getPeerInfo` itself) — the cache is never warmed. **`GET /containers/:id/peer`
therefore always returns `503 NOT_AVAILABLE`** for any container, regardless of whether the node is
healthy and reporting a peerId.

(For contrast, the sibling `waitForEnrollment` is correct: it reads only `health.status`, which
`/health` does return.)

## Expected behavior

`GET /containers/:id/peer` should return `{ peerId, multiaddrs }` for a running container whose node
has a libp2p identity, and `503` only when the node genuinely has no peer info yet (e.g. still
starting, `peerId` null).

## Suggested direction (not prescriptive)

`getPeerInfo` should fetch the **`/status`** URL — the same derivation the health helper already
encapsulates (`statusUrlFromHealthEndpoint` / `fetchContainerHealthStatus` in
`container-health.ts`) — and read top-level `peerId` / `multiaddrs` from the `HealthStatus`-shaped
body. Note `peerId` may be `null` on `/status` while the node is still starting; guard for that
(treat `null`/empty as "not available" → keep returning `undefined`). Consider whether a typed
helper (mirroring `fetchContainerHealthStatus`) is warranted so the wire shape is owned in one place
rather than re-cast inline with a loose `{ peerId?, multiaddrs? }` cast.

Add a regression test (mirror `container-get-status.test.ts`'s fetch-mock pattern): a running
container whose `/status` body carries `peerId` + `multiaddrs` → `getPeerInfo` returns them and hits
the `/status` URL (not `/health`); `null`/missing peerId → `undefined`.

## Notes

- Pre-existing bug; not introduced by the strand-type-drift ticket. That ticket scoped itself to
  `getContainerStatus` and explicitly left `getPeerInfo` alone.
- AGENTS.md "no backwards compatibility yet" applies — no need to preserve the (broken) `/health`
  read path.
