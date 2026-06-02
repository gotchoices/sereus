description: Reconciled ContainerStatusResponse.health to the real /status wire shape — it is now ContainerHealthStatus (strands under health.node.strands), and getContainerStatus parses /status via the shared fetchContainerHealthStatus helper instead of an untyped `any` assignment. Deliberate public-contract change for GET /containers/:id (health.strands → health.node.strands). Needs review.
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/service/__tests__/container-get-status.test.ts, packages/cadre-provider/src/service/__tests__/billing-collect-usage.test.ts
----

## What shipped

The provider's declared container-status type lied about the strand wire shape. Fixed by
reconciling the type to reality and routing the fetch through the existing health helper, so the
compiler now catches this class of drift.

1. **`ContainerStatusResponse.health` is now `ContainerHealthStatus | undefined`**
   (`types.ts:84-92`). The old inline block declared strands at the **top level**
   (`health.strands.{total,active,idle,hibernating}`); the real `/status` payload emitted by
   cadre-cli `HealthServer.getHealthStatus` (`packages/cadre-cli/src/server/health.ts:130-144`)
   puts them under `node.strands`. `types.ts` now `import type { ContainerHealthStatus }` from
   `./service/container-health.js` and reuses it. Added a doc-comment telling consumers to read
   `health?.node?.strands?.active ?? 0`.

2. **`getContainerStatus` reuses `fetchContainerHealthStatus`** (`container-service.ts:170-186`).
   The bespoke `fetch(statusUrlFromHealthEndpoint(...))` + `response.health = await healthRes.json()`
   (an untyped `any` assignment — the sole reason the old drift compiled) is gone. The method now
   does `if (container.status === 'running') response.health = await fetchContainerHealthStatus(container)`.
   The helper already short-circuits to `undefined` on missing endpoint / fetch throw / non-OK, so
   the old `&& container.healthEndpoint` guard and inline try/catch were redundant and removed. The
   import switched from `statusUrlFromHealthEndpoint` to `fetchContainerHealthStatus` (the former is
   no longer referenced in this file).

3. **Re-exported the wire types from the package index** (`index.ts:87-93`):
   `ContainerHealthStatus`, `ContainerStrandCounts`, plus `fetchContainerHealthStatus` /
   `statusUrlFromHealthEndpoint`. `ContainerStatusResponse` is already public, and its `health`
   field now names `ContainerHealthStatus` — without this export a consumer could not name the type.

No change needed in `routes.ts`: `GET /containers/:id` (`routes.ts:128-151`) forwards the whole
`status` object verbatim as JSON, so it transparently emits the corrected shape.

## Why this approach (vs. mapping node.strands up to a flat field)

Took the source ticket's lower-risk "reconcile to reality" path: it's DRY (the wire-accurate
`ContainerHealthStatus` already existed in `container-health.ts:26-32` and is what the billing path
consumes), and it makes one place own the `/status` shape so future drift is compiler-caught.
AGENTS.md's "no backwards compatibility yet" stance makes the contract change acceptable. The old
`health` only declared `{ status, uptime, strands }`; `ContainerHealthStatus` is
`{ status, uptime, node?: { strands? } }` — nothing previously declared is lost.

## Public-contract change (flag for reviewer)

`GET /containers/:id`'s `data.health` moves strand counts from `health.strands.*` to
`health.node.strands.*`, and those fields are now **optional** (a strandless `starting` payload
omits `node.strands`). A repo-wide grep found **no** in-repo consumer reading
`response.health.strands` (only ticket markdown references the old shape), and no `docs/` describe
the flat shape — but the reviewer should double-check external/API-doc consumers if any exist
outside this repo.

## Tests

New `container-get-status.test.ts` (6 tests, mirrors the `jsonResponse` / fetch-mock pattern from
`billing-collect-usage.test.ts`):
- live `/status` body with `node.strands` → `result.health?.node?.strands?.active` honors the count
  (the contract is now honest);
- the fetch hits the derived `/status` URL, not `/health`;
- `health` is `undefined` when the container is not `running` (and no fetch is attempted);
- `health` is `undefined` when the fetch throws;
- `health` is `undefined` when `/status` responds non-OK;
- `getContainerStatus` returns `undefined` for an unknown id.

## Validation done

- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc strict). The `any` assignment is
  gone; the type now flows. The `types -> service/container-health` `import type` edge raised no
  cycle/layering complaint (both directions are type-only), so the documented fallback
  (relocating the types into `types.ts`) was not needed.
- `yarn workspace @serfab/cadre-provider test` → 30/30 pass (6 new + 6 pre-existing billing that
  already assert the `node.strands` shape + 18 others). No ESLint configured in this monorepo;
  strict `tsc` is the lint surrogate.

## Known gaps / watch-outs for review

- **No timeout on the `/status` fetch.** Inherited from `fetchContainerHealthStatus` /
  the old `getContainerStatus`; a hung endpoint stalls this call until the socket times out.
  Pre-existing, out of scope here, already noted in the billing review's accepted-gaps list.
- **`waitForEnrollment` and `getPeerInfo` still hit `container.healthEndpoint` with their own
  inline `fetch` + `any`-ish casts** (`container-service.ts:133-147, 291-304`). They read a
  different/looser shape (`{ status }`, `{ peerId, multiaddrs }`) and were intentionally left
  alone — this ticket scoped to the `/status` strand drift only. Reviewer may judge whether those
  warrant their own typed helper, but that's a separate cleanup, not a defect introduced here.
- **Only `running` containers fetch health** (unchanged from before). An `enrolling` container
  returns `health: undefined` even though its `/status` may be reachable; this matches prior
  behavior and the billing path's `running`-only metering.
