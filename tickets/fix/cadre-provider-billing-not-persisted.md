----
description: Provider customer billing/quota state is never persisted across restarts; FileStore drops customerBilling and usage metering reports zero storage/strands.
files: packages/cadre-provider/src/service/store.ts, packages/cadre-provider/src/service/billing-service.ts
----
## Problem

The multi-tenant provider runtime is meant to enforce per-customer plan, quota, and balance limits using the file-backed (production) store. In practice the customer billing state never survives a process restart, so quota enforcement silently degrades to free-tier behavior.

`FileStore.saveCustomerBilling` writes only to the in-memory cache: it sets `cache.customerBilling` and calls `saveCache`, but `saveCache` serializes only `containers.json` and `api-keys.json`, and `loadCache` reads back only those same two files (`packages/cadre-provider/src/service/store.ts:108-147,192-196`). The `cache.customerBilling` map is therefore never written to disk and is always empty after a restart, because `loadCache` reconstructs it as an empty `Map` with no backing file.

## Consequence

`BillingService.canCreateContainer` reads billing via `store.getCustomerBilling` and treats a missing record as allowed / free tier (`packages/cadre-provider/src/service/billing-service.ts:144-161`: `if (!billing) return { allowed: true };`). Combined with the persistence gap above, every customer's persisted plan, quota, and outstanding-balance state is silently lost across restarts. After any provider restart the plan/container-limit and outstanding-balance checks no longer fire, undermining quota and payment enforcement for the production store — the exact store intended for real deployments.

## Secondary defect: usage metering reports zero

`BillingService.collectUsage` constructs `UsageMetrics` with `storageBytes: 0` and `peakStrands: 0` unconditionally (`packages/cadre-provider/src/service/billing-service.ts:124-132`), with inline notes that these "would need to query actual storage" and "would need to query health endpoint". As a result, storage-overage and strand-based billing cannot function even when billing records do exist and are loaded — the metered usage is always zero for those dimensions.

## Expected behavior

- Customer billing records must be durably persisted and reloaded by `FileStore`: `saveCache` must serialize the `customerBilling` map (e.g. to a `customer-billing.json` file alongside `containers.json` and `api-keys.json`) and `loadCache` must read it back, restoring plan/quota/balance state across restarts. Any `Date` fields in `CustomerBilling` should round-trip correctly, matching the existing date-rehydration pattern used for containers and API keys.
- After a restart, `BillingService.canCreateContainer` must see the persisted billing record so plan container limits and outstanding-balance enforcement continue to apply (rather than falling through to the free-tier `allowed: true` branch).
- Usage metering should measure real storage and strand usage rather than hardcoding zero, so storage-overage and plan/quota/overage enforcement work end-to-end for the file-backed store.

## Key references

- `packages/cadre-provider/src/service/store.ts:108-147` — `loadCache` / `saveCache` handle only `containers.json` and `api-keys.json`.
- `packages/cadre-provider/src/service/store.ts:192-196` — `saveCustomerBilling` writes only the in-memory cache.
- `packages/cadre-provider/src/service/billing-service.ts:144-161` — `canCreateContainer` treats a missing billing record as allowed/free-tier.
- `packages/cadre-provider/src/service/billing-service.ts:124-132` — `collectUsage` hardcodes `storageBytes: 0` and `peakStrands: 0`.
- Related (not duplicate): `tickets/backlog/later/5-quota-enforcement.md` — Arachnode-based storage quota enforcement and usage reporting, currently blocked on the Arachnode storage ring system.
