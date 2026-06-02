description: FileStore now persists customer billing across restarts (customer-billing.json); collectUsage meters live strand counts via a shared container-health helper; storage metering documented as blocked on Arachnode. Reviewed and accepted.
files: packages/cadre-provider/src/service/store.ts, packages/cadre-provider/src/service/billing-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/store-billing-persistence.test.ts, packages/cadre-provider/src/service/__tests__/billing-collect-usage.test.ts
----

## What shipped

Two billing-path defects from the source ticket plus a shared helper:

1. **FileStore persists `customerBilling`.** `loadCache`/`saveCache` now round-trip a third
   backing file `customer-billing.json` alongside `containers.json` / `api-keys.json`, with the
   two `Date` fields (`currentPeriodStart`, `currentPeriodEnd`) rehydrated via `new Date(...)`.
   This restores quota / outstanding-balance enforcement in `BillingService.canCreateContainer`,
   which had silently degraded to the free-tier `{ allowed: true }` branch because the in-memory
   map was dropped on every restart.

2. **`collectUsage` meters real strand counts.** A new `service/container-health.ts` centralizes
   the `/health`→`/status` URL derivation (`statusUrlFromHealthEndpoint`) and the fetch
   (`fetchContainerHealthStatus`, swallows errors → `undefined` so one unreachable container
   can't abort the loop). `peakStrands = health?.node?.strands?.active ?? 0`.
   `container-service.ts` was refactored to reuse the URL helper (no duplicated string surgery).

3. **Storage metering documented as blocked**, not faked. `storageBytes: 0` retained with an
   accurate comment cross-referencing `tickets/backlog/later/5-quota-enforcement.md` (Arachnode
   storage ring).

## Review findings

### Verified (read every touched file + the ones it should have touched)

- **Persistence round-trip (`store.ts`).** Confirmed `saveCache` writes
  `customer-billing.json` and `loadCache` reads + rehydrates it; the `Date` handling mirrors the
  existing container/api-key pattern. `saveCustomerBilling`/`getCustomerBilling` were already
  cache-backed, so the fix is complete and minimal. `MemoryStore` correctly unchanged.
- **The implementer's flagged divergence (`node.strands` vs top-level `strands`) is correct.**
  Cross-checked against the actual emitter: cadre-cli `HealthServer.getHealthStatus`
  (`packages/cadre-cli/src/server/health.ts:113-127`) serves strands under `node.strands` at the
  `/status` route (`health.ts:197-200`). The billing code reads `health.node.strands.active` —
  matching the real wire payload, not the stale provider-side `ContainerStatusResponse.health`
  type. Reading the source-ticket design's `health.strands.active` would have returned
  `undefined`. Good catch; the divergence was the right call.
- **DRY / modularity.** The shared `container-health.ts` helper removes the duplicated
  `.replace('/health','/status')`; `getContainerStatus` now calls it. Behavior identical.
- **Build + tests green.** `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc strict).
  `yarn workspace @serfab/cadre-provider test` → all pass. No ESLint is configured in this
  monorepo; the strict `tsc` build is the type-check/lint surrogate.

### Fixed inline (minor)

- **Edge-case test coverage.** The implementer's `collectUsage` tests covered happy path, URL
  derivation, fetch-throws resilience, and skip logic — but not two reachable branches:
  `fetchContainerHealthStatus`'s `if (!res.ok) return undefined` (non-OK HTTP response) and the
  `?? 0` fallback when the payload omits `node.strands`. Added two tests in
  `billing-collect-usage.test.ts` (503 response → `peakStrands: 0`; strandless `starting`
  payload → `peakStrands: 0`). Suite now 6 tests in that file, 19 total, all green.

### Filed as new ticket (major, pre-existing, out of scope)

- **`ContainerStatusResponse.health` type drift.** `types.ts:84-96` declares `strands` at the
  top level, but `getContainerStatus` (`container-service.ts:175-184`) assigns the raw `/status`
  JSON (`any`), whose real shape is `node.strands`. So `response.health.strands` is `undefined`
  at runtime, and `GET /containers/:id` (`routes.ts:137-149`) forwards that lying contract to API
  clients. No crash today (grep confirms no in-repo consumer reads `response.health.strands`),
  but the typed/documented API contract is wrong. Pre-existing (not introduced by this diff) and
  genuinely outside the billing scope → filed `tickets/fix/cadre-provider-container-status-strands-type-drift.md`.

### Accepted as documented gaps (not defects)

- **`peakStrands` is a point sample, not a true peak.** Instantaneous `active` count at
  collection time; under-reports peaks between samples. Documented inline; a true peak needs
  continuous sampling — a separate enhancement, correctly not built here.
- **`storageBytes` always 0** until the Arachnode storage ring exists. Inert by design,
  cross-referenced to `5-quota-enforcement`. Honest, not a wiring TODO.
- **`fetchContainerHealthStatus` swallows fetch errors silently** (no per-fetch debug log).
  Intentional for loop resilience; the surrounding `collectUsage` try/catch logs other failures.
  Acceptable; a debug line is a possible future nicety, not required.
- **`fetch` has no timeout** in `fetchContainerHealthStatus` (and the pre-existing
  `getContainerStatus`). A hung `/status` endpoint stalls that container's collection until the
  socket times out, and — because `collectUsage` iterates containers sequentially — delays the
  rest of the pass. Matches pre-existing behavior; fine at current scale. Noted alongside the
  implementer's sequential-fetch concurrency observation; not addressed here.

### Checked and clean (empty categories, explicitly)

- **Regressions:** none. All 10 pre-existing shutdown tests still pass; the change only adds a
  third persisted file and a new sampling read — no existing code path altered except the
  DRY-refactored URL derivation (behavior-identical).
- **Resource cleanup:** no new long-lived resources, handles, or timers introduced (the helper
  is a stateless fetch). Nothing to clean up.
- **Type safety in the new code:** `container-health.ts` is fully typed (no `any`). The one
  remaining `any` is the pre-existing `Response.json()` blob in `getContainerStatus`, captured by
  the new fix ticket above. The `loadCache` `JSON.parse` is `any` but matches the established
  store pattern for all three backing files — consistent, not a new wart.

## Validation

- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc strict, clean).
- `yarn workspace @serfab/cadre-provider test` → 19/19 pass (9 new billing/persistence + 10
  pre-existing shutdown).
