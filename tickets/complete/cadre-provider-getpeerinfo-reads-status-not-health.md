description: ContainerService.getPeerInfo now reads peerId/multiaddrs from the container's /status payload (via the shared fetchContainerHealthStatus helper) instead of /health (which returns only { status }), so GET /containers/:id/peer no longer always returns 503. Reviewed, validated, and adversarially probed.
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-cli/src/server/health.ts
----

## What shipped

`getPeerInfo` (`container-service.ts:311-332`, backing `GET /containers/:id/peer`)
previously `fetch`ed the container's `/health` URL and read `peerId`/`multiaddrs`
off the body — but cadre-cli's `/health` route emits only `{ status }`
(`health.ts:271-275`), so those fields were always `undefined`, the cache never
warmed, and the route uniformly returned **503 NOT_AVAILABLE**. The fields live at
the top level of the richer `/status` (`HealthStatus`) payload
(`health.ts:147-159`, served verbatim at `health.ts:280-283`).

The fix reuses the shared `fetchContainerHealthStatus` helper (the same one
`getContainerStatus` uses) rather than re-deriving the `/status` URL inline:

- `container-health.ts:28-36` — local `ContainerHealthStatus` gained top-level
  optional `peerId?: string | null` and `multiaddrs?: string[]`.
- `container-service.ts:311-332` — `getPeerInfo` returns the cached value when
  present; else `fetchContainerHealthStatus(container)`; treats null/empty
  `peerId` **or** empty `multiaddrs` as "not available" (`return undefined`); on
  success caches both and persists. The old inline `fetch(healthEndpoint)` + loose
  cast is gone.
- `__tests__/container-get-peer.test.ts` — regression suite (now 9 tests).

No route-layer change: `routes.ts:247-255` maps `undefined` → 503 and a populated
return → `{ ok: true, data: { peerId, multiaddrs } }`.

## Review findings

**Checked:** the implement/fix diff (the code actually landed in fix-stage commit
`5c74f16`, not the implement-stage commit `b147710`, which only renamed the ticket
file — worth noting for the audit trail); the full `getPeerInfo` body and its
cache branch; the shared `container-health.ts` helper and its callers;
`routes.ts` peer route (ownership guard + 503/200 mapping); the cadre-cli
`/status`/`/health` server (`health.ts`) to confirm the wire shape; the
`Container` type; every other writer of `peerId`/`multiaddrs` in the package; the
test suite; and the docs that reference peer/container routes.

**Type safety — OK.** cadre-core `CadreNode.getMultiaddrs(): string[]`
(`cadre-node.ts:158-160`) maps `.toString()`, so the `/status` `multiaddrs` are
genuinely `string[]`, matching the provider's local type. The guard
`!status?.peerId || !status.multiaddrs?.length` correctly narrows
`string | null | undefined` down to `string` before the `Container.peerId: string`
assignment. Typecheck clean.

**Error handling / resource cleanup — OK.** The helper swallows fetch failures and
non-OK responses to `undefined` and never throws; `getPeerInfo` degrades to 503
rather than propagating. No streams/handles to clean up.

**MAJOR — warm-once cache never invalidated.** `getPeerInfo` is the *only* writer
of `Container.peerId`/`multiaddrs` (grep-confirmed); nothing resets them on
restart/recreate/terminate. Once warmed, every future call short-circuits the
cache with no TTL/refresh, so after a container re-keys its libp2p identity or
remaps its multiaddrs the route serves **stale dial info indefinitely**. This fix
*newly activated* the latent bug — previously the `/health` read meant the cache
never warmed, so the staleness path was dead code. Asymmetric with
`getContainerStatus`, which re-fetches `/status` live every call. Resolving it
needs a caching-policy decision (live / TTL / explicit invalidation), so filed as
**`tickets/fix/cadre-provider-getpeerinfo-cache-never-invalidated.md`**
(`prereq:` this ticket) rather than fixed inline.

**MINOR — edge-case test coverage (fixed inline).** The suite tested null-peerId
and omitted-fields, but not (a) a valid `peerId` with empty `multiaddrs` (a
distinct boolean branch of the guard) or (b) a non-OK `/status` response. Added
both tests; suite now 80/80 across the package (was 78).

**Noted, out of scope (no action):**
- `statusUrlFromHealthEndpoint` is a naive first-`/health`→`/status` `.replace`
  (shared/pre-existing, also used by `getContainerStatus`). An endpoint whose host
  or earlier path segment contained `/health` could mis-rewrite. Not introduced
  here; flagged for whoever owns the helper.
- No timeout on the `/status` fetch (pre-existing, inherited from the helper,
  already on the sibling status ticket's accepted-gaps list).
- `getPeerInfo` fetches `/status` regardless of `container.status`, where
  `getContainerStatus` gates on `=== 'running'`. Harmless (fetch fails gracefully
  to `undefined` for a stopped container); subsumed by the cache-staleness ticket.
- Tests mock `globalThis.fetch` — no real HTTP round-trip. Consistent with the
  rest of the service's unit suite; route-level 503→200 mapping is unchanged and
  service-internal, so not re-tested here.

**Docs — checked, no change needed.** `docs/architecture.md` references only
`POST /containers/:id/seed`; nothing documents `GET /containers/:id/peer`
behavior, and the fix is contract-preserving (still returns peerId/multiaddrs or
503). The `peerId`/`multiaddrs` protocol prose in `architecture.md`/`api.md`
concerns the cadre seed/CadrePeer layer, unrelated to this provider read path.

## Validation

- `yarn workspace @serfab/cadre-provider typecheck` → exit 0, clean.
- `yarn workspace @serfab/cadre-provider test` → 12 files, **80 tests pass**
  (78 pre-review + 2 added edge-case tests).
- `yarn eslint` over the three changed files → exit 0.

## Follow-up

- `tickets/fix/cadre-provider-getpeerinfo-cache-never-invalidated.md` — warm-once
  cache staleness (major; design decision required).

## Context

- Pre-existing bug, surfaced and filed by
  `cadre-provider-container-status-strands-type-drift`, which scoped itself to
  `getContainerStatus` and left `getPeerInfo` alone.
- AGENTS.md "no backwards compatibility yet" — the broken `/health` read path was
  removed outright, not deprecated.
