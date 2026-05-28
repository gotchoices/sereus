---
description: Review the fix that defers durable pending-invite removal in `TrustCircleService.redeemInvite` until after a successful `acceptPhone`, replacing the synchronous durable claim with an in-memory `Set<string>` so transient `node_unavailable` no longer permanently burns a one-time invite token.
files: packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/auth/__tests__/trust-circle.test.ts, docs/cadre-host.md
---

## What changed

`TrustCircleService.redeemInvite` was reordered:

- **Before**: `getPending` + synchronous durable `removePending` → `acceptPhone` (over HTTP to authority node admin channel) → `addMember`. A transient `AuthorityNodeUnavailableError` from `acceptPhone` (which surfaces as `code: 'node_unavailable'`) burned the token permanently because the pending row was already gone.
- **After**:
  1. `getPending` — synchronous lookup.
  2. Expiry check; reap (durable `removePending`) and throw `expired` if past TTL.
  3. Synchronous claim in `this.inFlightRedemptions: Set<string>` (a new private field on the service). If the token is already claimed, throw `already_redeemed` synchronously, *before* the first await. This preserves the intra-process concurrent double-redeem guard.
  4. `acceptPhone` (await).
  5. **Only on success**: durable `removePending`, then `addMember`.
  6. `finally` clears the in-flight slot.

Net effect: any failure from `acceptPhone` (transient `node_unavailable`, or any other error from cadre-core / transport) leaves the pending row intact so the redeemer can retry once the underlying issue is resolved.

## Crash-safety tradeoff (documented in the source comment)

If the host crashes between `acceptPhone` succeeding and the post-success durable `removePending`, the token stays pending. A retry will reach `acceptPhone`, where cadre-core's `SeedBootstrapService.authorizePeer` does a plain `insert into CadreControl.CadrePeer` (not an upsert), and `CadrePeer.PeerId` is a primary key — so the second insert raises a PK constraint error. That surfaces to the redeemer as a non-`node_unavailable` error; the admin can revoke the lingering pending row. This is a narrower failure window than the prior "any transient outage burns the token" behaviour.

The fix-ticket research established that `SeedBootstrapService.authorizePeer` is at `packages/cadre-core/src/seed-bootstrap.ts:159-167` and `CadrePeer.PeerId` is a PK at `schemas/control.qsql:44-46`.

## Files touched

- `packages/cadre-host/src/auth/trust-circle.ts` — added `private readonly inFlightRedemptions = new Set<string>()`, rewrote `redeemInvite`, expanded the leading JSDoc to describe the new ordering and crash-safety tradeoff.
- `packages/cadre-host/src/auth/__tests__/trust-circle.test.ts` — added three new tests (see below); existing tests unchanged and still passing.
- `docs/cadre-host.md` — updated the "Redeem" lifecycle bullet (step 3 of the trust-circle lifecycle) to reflect the new ordering: in-flight claim, post-success durable consumption, transient-on-failure-leaves-pending semantics.

## New tests added

In `packages/cadre-host/src/auth/__tests__/trust-circle.test.ts`, under `describe('TrustCircleService.redeemInvite', …)`:

1. **`preserves the pending token when acceptPhone fails with node_unavailable`** — sets `acceptShouldThrow = new AuthorityNodeUnavailableError('node down')`, asserts `redeemInvite` rejects with `code: 'node_unavailable'`, asserts the pending row still exists, then clears the mock and retries the same `{ token, peerId }` and asserts success. This is the **primary regression test** for the original bug.

2. **`concurrent redeem during a gated node_unavailable leaves the token re-redeemable`** — gates `acceptPhone` on a promise that rejects with `AuthorityNodeUnavailableError`. Starts two concurrent redeems; second rejects synchronously with `already_redeemed` (proves the in-flight guard still fires). Releases the gate; first rejects with `node_unavailable`. Asserts the pending row still exists and the in-flight Set has cleared (a third redeem against a healthy mock succeeds). Combines the concurrent-claim and the failure-recovery behaviours.

3. **`preserves the pending token on non-transient acceptPhone failures (admin must revoke)`** — sets `acceptShouldThrow = new Error('cadre-core rejected the peer')`. Asserts the error propagates and the pending row is preserved. Documents the broadened "any acceptPhone failure leaves token re-redeemable" semantics. **Reviewer judgment call**: the fix ticket calls this out explicitly — if the team prefers a narrower "transient only" rule (re-add only when the error is an `AuthorityNodeUnavailableError`), this test should be updated and the `redeemInvite` body should branch on `err instanceof AuthorityNodeUnavailableError` before falling through to `toDomainError`. The current implementation is the safer "leave pending on any failure" rule.

## Verification

- `yarn workspace @serfab/cadre-host vitest run src/auth/__tests__/trust-circle.test.ts` → **27 passed**.
- `yarn workspace @serfab/cadre-host vitest run src/auth/__tests__/trust-circle-integration.test.ts` → **1 passed, 1 skipped** (real-network integration; success path unchanged end-to-end).
- `yarn workspace @serfab/cadre-host tsc --noEmit` — pre-existing failures only in unrelated files (`src/nat/__tests__/nat-service.test.ts`, `src/server/__tests__/error-handler.test.ts`, `src/server/__tests__/nodes-route.test.ts`, `src/server/__tests__/publishers.test.ts`, `src/server/__tests__/status-route.test.ts`). None of these errors reference the modified files; they were present on master before this change. Not investigated as part of this ticket.

## Use cases / behaviours to spot-check

A reviewer should be able to walk through each of these against the implementation:

- **Transient node_unavailable on first redeem → retry works**: same `{token, peerId}` pair should succeed once the node recovers. Covered by test 1.
- **Concurrent double-redeem (legit race, healthy node)**: second caller sees `already_redeemed` synchronously, only one peer gets authorised. Covered by the pre-existing "claims pending atomically" test (unchanged).
- **Concurrent double-redeem during outage**: second caller still sees `already_redeemed`; first sees `node_unavailable`; pending row preserved. Covered by test 2.
- **Expired invite**: reaped on lookup before the in-flight claim. Covered by the pre-existing "rejects expired" test (unchanged).
- **Successful redeem then retry**: second attempt sees `already_redeemed` because the post-success `removePending` ran. Covered by the pre-existing "double-redeem" test (unchanged).
- **Non-transient acceptPhone failure**: token stays pending; admin can revoke. Covered by test 3 — flag for design judgment per above.

## Known gaps the reviewer should weigh

- **Crash-during-success window**: not exercised by automated tests. The behaviour (retry → PK constraint error from cadre-core, surfaces to redeemer; admin revokes pending) is reasoned about in the source comment but not directly verified. A targeted integration test that crashes between `acceptPhone` and `removePending` would require harness work; deferred.
- **Test 3 documents a broadened semantics** (any non-transient `acceptPhone` failure leaves pending). If the team disagrees and wants strict "only transient → preserve, otherwise burn", `redeemInvite` needs to branch and the test needs to flip. The fix-ticket research argued explicitly for the broadened rule ("Leaving the row pending on *any* failure and letting the admin revoke is the conservative choice"); I followed that recommendation, but it is a judgment call worth a second pair of eyes.
- **No file-locking**: the in-flight `Set` is intra-process. The orchestrator's single-process-per-rootDir guarantee (documented in `TrustCircleStore`) is what makes this safe. If that invariant ever changes, the guard needs to be promoted to a file-based lock.
