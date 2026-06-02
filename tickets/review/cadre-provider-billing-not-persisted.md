description: Review — FileStore now persists customer billing across restarts; collectUsage meters live strand counts; storage metering documented as blocked on Arachnode.
files: packages/cadre-provider/src/service/store.ts, packages/cadre-provider/src/service/billing-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/store-billing-persistence.test.ts, packages/cadre-provider/src/service/__tests__/billing-collect-usage.test.ts
----

## What was implemented

Two billing-path defects from the source ticket, plus a small shared helper.

### 1. FileStore now persists `customerBilling` (primary fix)

`store.ts` `loadCache`/`saveCache` previously serialized only `containers.json` and `api-keys.json`, so the in-memory `customerBilling` map was silently dropped on every restart — which made `BillingService.canCreateContainer` degrade to the free-tier `{ allowed: true }` branch (quota / outstanding-balance enforcement disabled).

- `saveCache` now also writes `customer-billing.json` from `Array.from(this.cache.customerBilling.values())`, 2-space JSON, matching the other two files.
- `loadCache` now reads `customer-billing.json` (when present) and rehydrates the two `Date` fields (`currentPeriodStart`, `currentPeriodEnd`) via `new Date(...)`, mirroring the container/api-key date handling. Optional `paymentMethodId` / `billingEmail` are plain strings — no special handling.
- `saveCustomerBilling` / `getCustomerBilling` were already cache-backed; no change needed once the cache round-trips.

`MemoryStore` was already correct (in-process map) and is unchanged.

### 2. `collectUsage` meters real strand counts

`billing-service.ts` `collectUsage` hardcoded `peakStrands: 0`. It now samples the container's live `/status` endpoint and uses the active strand count.

- New module `service/container-health.ts` centralizes the `/health`→`/status` URL derivation and the fetch:
  - `statusUrlFromHealthEndpoint(healthEndpoint)` — the single home for the `.replace('/health','/status')` surgery. `container-service.ts` `getContainerStatus` was refactored to call it (identical behavior, no duplication).
  - `fetchContainerHealthStatus(container)` — fetches `/status`, returns the parsed payload or `undefined`. **Swallows all errors** (no endpoint / fetch throws / non-OK) so a single unreachable container can't abort the collection loop.
- `peakStrands = health?.node?.strands?.active ?? 0`.

### 3. Storage metering documented as blocked (NOT faked)

`storageBytes: 0` is kept, but the misleading `// Would need to query actual storage` comment is replaced with an accurate note: no bytes-on-disk are surfaced by the health server or orchestrator stats, and real metering is blocked on the Arachnode storage ring — cross-referenced to `tickets/backlog/later/5-quota-enforcement.md`.

## ⚠️ Reviewer: please scrutinize this — a deliberate divergence from the source ticket

The source ticket's design said to read `health.strands.active`, based on the `ContainerStatusResponse.health` type (`types.ts:84-96`), which declares `strands` at the **top level**.

That type is **wrong / out of sync with the real payload**. The cadre-cli `/status` endpoint returns the `HealthStatus` shape (`packages/cadre-cli/src/server/health.ts:113-127, 197-200`), where strands live under **`node.strands`**, not top-level `strands`. So the implementation reads `health.node.strands.active` — verified against the actual emitted JSON, not the stale provider-side type. The new local `ContainerHealthStatus` type in `container-health.ts` matches the real shape.

**Pre-existing latent bug surfaced (out of scope, NOT fixed here):** `ContainerService.getContainerStatus` (`container-service.ts:175-184`) assigns the parsed `/status` JSON straight into `response.health` (typed with top-level `strands`). At runtime that field actually contains `node.strands`, so any consumer reading `response.health.strands.*` gets `undefined` (the assignment compiles only because `Response.json()` is `any`). The status route (`routes.ts:137`) just forwards the object, so there's no crash today, but the typed contract is a lie. Worth a separate fix ticket to reconcile `ContainerStatusResponse.health` with `HealthStatus` (move `strands` under `node`, or have `getContainerStatus` map it). I left it alone to keep this ticket scoped to billing.

## Validation performed

- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc strict, clean).
- `yarn workspace @serfab/cadre-provider test` → 17/17 pass (7 new + 10 pre-existing shutdown tests).

### New tests (treat as a floor, not a ceiling)

`__tests__/store-billing-persistence.test.ts`:
- save → new `FileStore` (simulated restart) → `getCustomerBilling` round-trips, `planId`/`balanceCents` intact, `currentPeriodStart` is a `Date` with the same epoch.
- optional fields (`paymentMethodId`, `billingEmail`, negative/credit `balanceCents`) survive; `currentPeriodEnd` rehydrates as a `Date`.
- a `customer-billing.json` backing file is actually written.

`__tests__/billing-collect-usage.test.ts` (drives the private `collectUsage` via a typed cast; mocks `globalThis.fetch`):
- `peakStrands` reflects the reported active count; `bandwidthBytes` = orchestrator `networkTxBytes`; `storageBytes` = 0.
- fetch targets the derived `/status` URL (not `/health`).
- a `/status` fetch failure degrades that container to `peakStrands: 0` **and the loop still meters the other container** (collection not aborted).
- non-running / missing-`dockerId` containers are skipped.

## Known gaps / things to poke at

- **`peakStrands` is a point sample, not a true peak.** It's the instantaneous `active` count at collection time (default every 60s), so it under-reports real peaks between samples. Documented inline; a true peak would need continuous sampling (separate enhancement, not built).
- **`storageBytes` is always 0** until the Arachnode storage ring exists — overage billing on storage is inert by design, not a wiring TODO. See `5-quota-enforcement`.
- **No test exercises the real cadre-cli `/status` payload end-to-end** — the collectUsage test mocks `fetch` with a hand-built `node.strands` body. If you want belt-and-suspenders, an integration test against a live cadre-cli health server would confirm the `node.strands` path against the real emitter (and would catch the `getContainerStatus` type drift noted above).
- **`fetchContainerHealthStatus` swallows errors silently** (returns `undefined`) — intentional for loop resilience, but it means a persistently-unreachable container meters 0 strands with no per-fetch log line. The surrounding `collectUsage` try/catch logs other failures; consider whether silent strand-fetch failures deserve a debug log.
- **Concurrency:** `collectUsage` fetches containers' `/status` sequentially in a `for` loop. Fine at current scale; if a deployment has many containers and a slow/hung endpoint, one container's latency delays the rest within an interval. Not addressed here.
