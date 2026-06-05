description: REVIEW — ContainerService.getPeerInfo now reads the live `/status` payload on every call with no cache, matching getContainerStatus's freshness model. The warm-once peerId/multiaddrs cache (which served stale dial info forever after a restart re-keyed identity or remapped multiaddrs) is gone, along with its only writer. The now-dead `Container.peerId`/`multiaddrs` fields were removed from types.ts (no cross-package consumer read them). Package test (80) + typecheck + build all green.
prereq: cadre-provider-getpeerinfo-reads-status-not-health
files: packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/container-get-peer.test.ts, packages/cadre-provider/src/types.ts
----

# Review: getPeerInfo live every call

`GET /containers/:id/peer` (`server/routes.ts:247`) now always reflects the
container's current libp2p dial info. The warm-once cache that made it serve
stale `peerId`/`multiaddrs` indefinitely after a restart is removed.

## What changed

### `container-service.ts` — `getPeerInfo` (now `~301-326`)
- **Deleted the cache short-circuit** (`if (container.peerId && container.multiaddrs?.length) return ...`).
- **Deleted the cache write** (`container.peerId = ...; container.multiaddrs = ...; updatedAt; saveContainer`).
- Now it unconditionally `fetchContainerHealthStatus(container)` and returns
  `{ peerId, multiaddrs }` when both are present on the live `/status` payload,
  else `undefined`. Same `null peerId` / empty-`multiaddrs` "not available"
  handling as before.
- Doc comment rewritten to state it reads live every call with no cache, and why
  (matches `getContainerStatus`; the old cache served stale dial info forever).

This makes the two `/status` read paths agree on freshness: `getContainerStatus`
(`container-service.ts:192-207`) already fetched live on every request and cached
nothing; `getPeerInfo` now does the same.

### `types.ts` — `Container` (fields removed)
After the change, **nothing** writes or reads `Container.peerId`/`multiaddrs`.
Grep across all `packages/` confirms the only `.peerId`/`.multiaddrs` reads off a
provider `Container` were the two lines in `getPeerInfo` (now gone) and the test.
Cross-package importers of `@serfab/cadre-provider` (`cadre-host`) import only
`Orchestrator*` types and `ContainerStatus`, never the `Container` peer fields.
So the two optional fields were removed to keep the type honest.

### `container-get-peer.test.ts`
Rewrote the former "caches peer info … skips the fetch" case into
**"re-fetches live every call, reflecting peer info that changed after a
restart"**: the fetch mock returns `12D3KooWOld` / `/ip4/10.0.0.1/tcp/4001` on
the first call and `12D3KooWNew` / `/ip4/10.0.0.2/tcp/5002` on the second
(simulating a restart re-keying identity + remapping multiaddrs). Asserts the
first result is the old value, the second reflects the **new** value, and
`fetchMock` was called **twice**. The other eight cases (live happy path,
derived `/status` URL, null peerId, empty multiaddrs, non-OK, missing fields,
fetch throws, unknown id) are unchanged.

## How to validate (use cases)

### Automated (ran green — `yarn workspace @serfab/cadre-provider test`)
- **`re-fetches live every call, reflecting peer info that changed after a restart`**
  — the core regression guard for this fix; proves no stale serving and two fetches.
- The eight surrounding `getPeerInfo` cases continue to pin the
  not-available/error branches.
- **`container-get-status.test.ts`** still green — confirms the side effect below
  did not break the status read path (it never asserted peer fields).

### Build / typecheck (ran green)
- `yarn workspace @serfab/cadre-provider typecheck` — clean (proves the
  field removal has no remaining referencers in the package).
- `yarn workspace @serfab/cadre-provider build` — clean.
- `yarn workspace @serfab/cadre-provider test` — **80 passed (12 files)**.

### Suggested reviewer probes (not covered by unit tests)
1. **Route-level freshness** — `GET /containers/:id/peer` against a container
   whose `/status` peerId changes between two requests; confirm the second
   response carries the new value. Only the service layer is unit-tested here.
2. **Load posture** — every `/peer` hit now triggers one `/status` round-trip
   (the accepted trade-off; identical to the cost `getContainerStatus` already
   pays). The route is `ContainersRead`-gated (`routes.ts:235`) and low
   frequency, so this is expected to be a non-issue — worth a sanity check if
   any caller polls `/peer` tightly.

## Honest gaps / things for the reviewer to weigh

- **Status-response side effect (intended, per ticket).** `getContainerStatus`
  returns `{ container }`, so the persisted `container.peerId`/`multiaddrs`
  previously rode along in `GET status`. Now that nothing writes those fields,
  the status response no longer carries peer info. This is the documented,
  accepted behavior — `/peer` is the dedicated source of truth and the values
  the status response used to carry were exactly the stale ones removed here. Do
  not re-add a write to repopulate them. No test asserted peer fields on the
  status response, so nothing broke; confirm no out-of-repo consumer relied on
  `status.container.peerId`.
- **Fields removed vs. commented.** The ticket allowed leaving the two fields
  with a "no longer populated" comment if a consumer read them. The grep came
  back clean (no provider-`Container` peer-field reader anywhere in `packages/`),
  so they were removed outright. Reviewer should sanity-check the grep
  conclusion if there is any serialized-`Container` consumer outside this repo.
- **No route/integration test added.** Validation is service-layer unit only;
  there is no live-container or HTTP-route test exercising the end-to-end
  `/peer` freshness. A focused route test (or integration scenario) would be the
  highest-value follow-up if the reviewer wants stronger coverage.
