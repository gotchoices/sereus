description: Persist FileStore customer billing across restarts (customer-billing.json) and meter real strand usage; document storage metering as blocked on Arachnode.
files: packages/cadre-provider/src/service/store.ts, packages/cadre-provider/src/service/billing-service.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/types.ts
----

## Summary

Two defects in the multi-tenant provider's billing path:

1. **(Primary, fully fixable)** `FileStore` never persists the `customerBilling` map. `saveCache` serializes only `containers.json` and `api-keys.json`, and `loadCache` reads back only those two files, so `cache.customerBilling` is always an empty `Map` after a restart. Quota / outstanding-balance enforcement in `BillingService.canCreateContainer` then silently degrades to the free-tier `allowed: true` branch.

2. **(Secondary)** `BillingService.collectUsage` hardcodes `storageBytes: 0` and `peakStrands: 0`. Strand counts *are* obtainable from the running container; storage usage *is not* (see Research below).

## Reproduction (confirmed)

The following test fails today (`getCustomerBilling` returns `undefined` after a fresh `FileStore` is constructed over the same data dir, i.e. a simulated restart). Add it as part of the fix (suggested path: `packages/cadre-provider/src/service/__tests__/store-billing-persistence.test.ts`) — it should pass once persistence is wired:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore } from '../store.js';
import type { CustomerBilling } from '../../types.js';

describe('FileStore customer billing persistence', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-store-')); });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('reloads customer billing after a restart', async () => {
    const billing: CustomerBilling = {
      customerId: 'cust-1',
      planId: 'professional',
      balanceCents: 500,
      currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
    };
    const store = new FileStore(dataDir);
    await store.saveCustomerBilling(billing);

    const reloaded = new FileStore(dataDir); // simulated restart
    const result = await reloaded.getCustomerBilling('cust-1');

    expect(result).toBeDefined();
    expect(result?.planId).toBe('professional');
    expect(result?.balanceCents).toBe(500);
    expect(result?.currentPeriodStart).toBeInstanceOf(Date);
    expect(result?.currentPeriodStart.getTime()).toBe(billing.currentPeriodStart.getTime());
  });
});
```

## Root cause

- `packages/cadre-provider/src/service/store.ts:108-147` — `loadCache` builds `cache.customerBilling = new Map()` but has no `customer-billing.json` read; `saveCache` writes only `containers.json` + `api-keys.json`.
- `packages/cadre-provider/src/service/store.ts:192-196` — `saveCustomerBilling` mutates the in-memory map then calls `saveCache`, which drops the map on the floor.
- `packages/cadre-provider/src/service/billing-service.ts:144-161` — missing record ⇒ `{ allowed: true }`, so the persistence gap manifests as disabled enforcement.
- `packages/cadre-provider/src/service/billing-service.ts:124-132` — `collectUsage` hardcodes `storageBytes: 0`, `peakStrands: 0`.

## Research: what usage data is actually available

**Strands — available now.** The container's health server exposes a `/status` endpoint (on the health port) returning `HealthStatus` with `node.strands.{ total, active, idle, hibernating }` (`packages/cadre-cli/src/server/health.ts:16-34,99-127`). `Container.healthEndpoint` is the `/health` URL; the existing pattern to reach status is `fetch(healthEndpoint.replace('/health', '/status'))` — see `ContainerService.getContainerStatus` (`packages/cadre-provider/src/service/container-service.ts:168-187`), which already parses the response into `ContainerStatusResponse.health.strands` (`packages/cadre-provider/src/types.ts:84-96`). So `peakStrands` can be sourced from the live `/status` strand counts.

**Storage — NOT available; blocked on Arachnode.** No storage/disk usage is surfaced anywhere in the stack:
- `HealthStatus` / `MetricsData` (`packages/cadre-cli/src/server/health.ts`) expose only node/strand/peer fields — no bytes-on-disk.
- `OrchestratorStats` (`packages/cadre-provider/src/service/orchestrator.ts:36-46`) carries cpu/memory/network only — no disk usage. `DockerOrchestrator.getStats` reads Docker stats (cpu/mem/net), not filesystem size.
- Per `tickets/backlog/later/5-quota-enforcement.md`, per-strand/total storage tracking and "report usage to the provider for billing metering" are explicitly **blocked on the Arachnode storage ring system**, which is not yet built.

Therefore real storage metering cannot be implemented end-to-end in this ticket. Faking it (e.g. Docker layer size) would measure the wrong thing and mislead overage billing. The honest call: meter strands now, and leave `storageBytes` as a documented, cross-referenced gap rather than a silent `0`.

## Design

### 1. Persist customer billing in FileStore

Add a third backing file `customer-billing.json` alongside `containers.json` / `api-keys.json`, following the exact same load/save + Date-rehydration pattern.

- In `loadCache`: after the `api-keys.json` block, read `customer-billing.json` if it exists; for each record rehydrate `currentPeriodStart` and `currentPeriodEnd` via `new Date(...)` (mirror the container/api-key date handling at `store.ts:121-122,131-133`), then `cache.customerBilling.set(b.customerId, b)`.
- In `saveCache`: write `customer-billing.json` from `Array.from(this.cache.customerBilling.values())`, matching the existing `JSON.stringify(..., null, 2)` formatting.
- No change needed to `saveCustomerBilling` / `getCustomerBilling` — they already go through the cache; once `saveCache`/`loadCache` cover the map, persistence works.

`CustomerBilling` (`packages/cadre-provider/src/types.ts:141-156`) has exactly two `Date` fields (`currentPeriodStart`, `currentPeriodEnd`); `paymentMethodId` / `billingEmail` are optional plain strings and need no special handling.

### 2. Meter real strand usage in collectUsage

In `BillingService.collectUsage` (`billing-service.ts:114-138`), for each running container additionally fetch its live `/status` and use the strand count for `peakStrands`.

- Reuse the existing status-fetch shape from `ContainerService.getContainerStatus` rather than duplicating string surgery. Prefer adding a small helper the billing service can call (e.g. inject `ContainerService` or factor a `fetchContainerHealth(container)` util) so the `/health`→`/status` URL derivation lives in one place. Decide based on what wiring is already available where `BillingService` is constructed — check `BillingServiceOptions` (`billing-service.ts:65-71`) and the server bootstrap.
- Map `peakStrands` from the status payload. The field is named "peak" but collection is an interval point-sample; use `health.strands.active` (active strands at sample time) and document that it is an instantaneous sample, not a true period peak. (If a true peak is wanted later, that's a separate enhancement — note it, don't build it here.)
- Network egress already comes from `stats.networkTxBytes`; keep it.
- Be resilient: if the `/status` fetch fails, fall back to `0` strands and continue (don't abort the whole collection loop — the existing `try/catch` per container already guards `getStats`).

### 3. Storage metering — document the block, don't fake it

Leave `storageBytes: 0` in the constructed `UsageMetrics`, but replace the misleading inline `// Would need to query actual storage` comment with an accurate note that storage usage is unavailable until the Arachnode storage ring exposes it, cross-referencing `tickets/backlog/later/5-quota-enforcement.md`. This keeps `collectUsage` honest and prevents a future reader from assuming storage metering is merely a TODO wiring task.

## Tradeoffs / scope notes

- This ticket fully fixes the persistence defect (the primary production-impacting bug) and the strand half of the metering defect. The storage half is genuinely blocked upstream (Arachnode) and is deferred to `5-quota-enforcement` — documented in code and here rather than stubbed with a wrong proxy.
- `MemoryStore` already persists billing within a process; no change needed there. The repro and any new tests should target `FileStore`.

## TODO

- [ ] In `store.ts` `loadCache`: read `customer-billing.json` (if present), rehydrate `currentPeriodStart` / `currentPeriodEnd` as `Date`, populate `cache.customerBilling`.
- [ ] In `store.ts` `saveCache`: serialize `cache.customerBilling` values to `customer-billing.json` (2-space JSON, same as the others).
- [ ] Add the persistence test from the Reproduction section (FileStore save → new FileStore → getCustomerBilling round-trips, Dates intact).
- [ ] In `billing-service.ts` `collectUsage`: fetch live container `/status` and set `peakStrands` from `health.strands.active`, with a per-container fallback to `0` on fetch failure. Reuse the `/health`→`/status` derivation already in `container-service.ts` (factor a shared helper rather than duplicating).
- [ ] Replace the `storageBytes: 0` / `peakStrands: 0` "Would need to query…" comments: keep `storageBytes: 0` with an accurate note cross-referencing `tickets/backlog/later/5-quota-enforcement.md` (Arachnode block); `peakStrands` is now metered.
- [ ] Add/extend a `BillingService.collectUsage` test (mock orchestrator + a fake `/status` source) asserting `peakStrands` reflects reported active strands and that a `/status` failure degrades to `0` without aborting collection.
- [ ] `yarn workspace @serfab/cadre-provider build` and `yarn workspace @serfab/cadre-provider test` both green.
