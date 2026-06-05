description: Drop the warm-once peer-info cache in ContainerService.getPeerInfo so GET /containers/:id/peer always reads the live /status payload, matching getContainerStatus's freshness model. Fixes indefinitely-stale peerId/multiaddrs after a container restart re-keys its libp2p identity or remaps its multiaddrs.
prereq: cadre-provider-getpeerinfo-reads-status-not-health
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts, packages/cadre-provider/src/types.ts
----

## Problem

`getPeerInfo` (`container-service.ts:311-332`) caches `peerId`/`multiaddrs`
warm-once on the container record and short-circuits every subsequent call with
**no TTL or freshness check** (`container-service.ts:316-318`). It is the sole
reader *and* writer of `Container.peerId`/`Container.multiaddrs` (grep across
`packages/cadre-provider/src` confirms — `types.ts:62/64` declare them,
`container-health.ts` has an unrelated `ContainerHealthStatus.peerId`). Nothing
on enrollment, restart, recreation, or termination resets them. So once warmed,
`GET /containers/:id/peer` serves stale dial info forever: after a restart that
re-keys identity (no persisted identity volume) or remaps Docker ports/IPs,
customers can no longer reach the node.

The sibling `getContainerStatus` (`container-service.ts:192-207`) calls
`fetchContainerHealthStatus` **live on every request** and caches nothing. The
two read paths over the same `/status` payload disagree on freshness.

This was latent until the `getpeerinfo-reads-status-not-health` fix landed:
previously `getPeerInfo` read `/health` (which carries only `{ status }`), so the
peer fields were always `undefined`, the cache never warmed, and the route
uniformly 503'd. The staleness path is now live.

## Chosen policy: live every call

Of the three options in the source ticket (live-every-call / TTL / explicit
invalidation), **live-every-call** is selected. Rationale:

- Matches `getContainerStatus` exactly — one freshness model across both
  `/status` read paths, no clock/TTL field to reason about.
- The `/peer` route is customer-gated (`ContainersRead` scope, `routes.ts:235`)
  and low-frequency; there is no concrete need to shield containers from one
  extra `/status` round-trip per request. TTL/invalidation add state and
  lifecycle-hook surface to solve a load problem that does not exist.

Trade-off accepted: one `/status` fetch per `/peer` request (same cost
`getContainerStatus` already pays).

### Side effect to be aware of

`getContainerStatus` returns `{ container }`, so the persisted
`container.peerId`/`multiaddrs` currently ride along in the `GET status`
response. Once `getPeerInfo` stops writing them, that response stops carrying
peer fields. This is acceptable — `/peer` is the dedicated source of truth and
the values it carried were exactly the stale ones this fix removes. Do **not**
re-add a write to keep them populated; that would reintroduce a stale-prone
record.

### Container.peerId / multiaddrs fields

After this change nothing writes `Container.peerId`/`multiaddrs` and nothing in
`cadre-provider/src` reads them. Verify no cross-package consumer reads these
fields off a provider `Container` (grep the other packages, not just
cadre-provider). If clean, remove the two fields from `types.ts:61-64` so the
type stays honest. If a consumer does read them (e.g. a serialized status
response asserted elsewhere), leave the fields in place and add a one-line
comment that they are no longer populated by the provider, then note the finding
in the review handoff.

## Acceptance

- `getPeerInfo` no longer serves stale peer info after an identity/multiaddr
  change: warm a value, change what `/status` returns, second call reflects the
  change.
- Behavior matches `getContainerStatus`'s freshness model (live fetch, no
  cache).
- `yarn workspace @serfab/cadre-provider test` (or the package's vitest run) is
  green; `yarn workspace @serfab/cadre-provider build` / typecheck passes.

## TODO

- In `container-service.ts`, delete the cache short-circuit
  (`if (container.peerId && container.multiaddrs?.length) { ... }`,
  lines 316-318) and the cache write (lines 326-329:
  `container.peerId = ...; container.multiaddrs = ...; updatedAt; saveContainer`).
  Always `fetchContainerHealthStatus(container)`, return
  `{ peerId, multiaddrs }` when both are present, else `undefined`. Refresh the
  doc comment (lines 301-310) to state it reads live every call with no cache.
- Update `__tests__/container-get-peer.test.ts`: rewrite the
  "caches peer info ... skips the fetch" test (lines 70-85) to assert the
  opposite — second call re-fetches; have the mock return changed
  peerId/multiaddrs on the second call and assert the result reflects the new
  value and `fetchMock` was called twice. Keep the other cases (null peerId,
  empty multiaddrs, non-OK, missing fields, fetch throws, unknown id) as-is.
- Grep all packages for reads of `Container.peerId` / `.multiaddrs` off a
  provider container. If none, remove the fields from `types.ts:61-64`; if any,
  keep them with a "no longer populated" comment and record it in the handoff.
- Run the package test + build; write the `review/` handoff noting the chosen
  policy, the status-response side effect, and the fields decision.
