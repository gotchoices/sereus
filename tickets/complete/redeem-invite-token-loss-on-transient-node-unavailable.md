---
description: Defer the durable pending-invite removal in `TrustCircleService.redeemInvite` until *after* a successful `acceptPhone`, using an in-memory in-flight `Set<string>` to preserve the concurrent double-redeem guard. Fixes the regression where a transient `node_unavailable` from the authority-node admin channel permanently burned a one-time invite token.
files: packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/auth/__tests__/trust-circle.test.ts, docs/cadre-host.md
---

## Outcome

`TrustCircleService.redeemInvite` was reordered so the durable `removePending`
fires only after a successful `acceptPhone`. The concurrent-redeem guard moved
from the durable store (synchronous `removePending`) to a process-local
`inFlightRedemptions: Set<string>` that is added to synchronously before the
first await and cleared in a `finally`. A transient `AuthorityNodeUnavailableError`
(or any other `acceptPhone` failure) now leaves the pending row intact so the
redeemer can retry once the underlying issue clears.

Crash-safety tradeoff documented inline: if the host crashes between
`acceptPhone` success and `removePending`, a retry's `acceptPhone` will be
rejected by cadre-core's `SeedBootstrapService.authorizePeer` (plain insert
into `CadrePeer`, PK on `PeerId`), surfacing to the redeemer as a
non-`node_unavailable` error. The admin can revoke the lingering pending row.
This is a narrower window than the prior "any transient outage burns the token"
behaviour.

## Review findings

### Categories checked

- **Correctness / ordering** — reordering is consistent with the design: sync
  prefix (`getPending` → expiry-reap → in-flight claim) cannot interleave under
  JS's single-thread model, so the second concurrent caller deterministically
  observes the in-flight slot and rejects synchronously. The `finally` block
  guarantees in-flight clears on every exit path.
- **Resource cleanup** — `inFlightRedemptions` add → finally delete is paired.
  Set is bounded by concurrent same-token redeems (≤ 1 entry per token).
- **Error handling** — `toDomainError` preserves the
  `AuthorityNodeUnavailableError → node_unavailable` mapping. Non-transient
  errors propagate unchanged (test 3 covers this).
- **Type safety** — no `any` introduced; no signature changes.
- **HTTP status mapping** (`packages/cadre-host/src/server/error-handler.ts:39,42`)
  — `already_redeemed → 404`, `node_unavailable → 503`. Both are still
  produced by the new code path with the intended meanings.
- **Docs** — `docs/cadre-host.md:128` accurately reflects the new ordering.
  No other docs in `docs/` or `packages/cadre-host/` reference the old
  "atomically consumes the pending row" wording (verified by grep). The
  6.7-cadre-host-authority-node-delegation complete ticket retains the
  historical wording in its discussion of the bug — appropriate as archival.
- **Tests** — `vitest run src/auth/__tests__/trust-circle.test.ts` → 27
  passed. Integration test `trust-circle-integration.test.ts` → 1 passed, 1
  skipped (unchanged). Full auth suite (40 passed, 1 skipped). Three new tests
  cover (a) transient `node_unavailable` preserves pending + retry succeeds,
  (b) concurrent gated `node_unavailable` — second caller still bounces
  synchronously, first rejects with `node_unavailable`, third succeeds after
  in-flight slot frees, (c) non-transient `acceptPhone` failure preserves
  pending. Pre-existing tests (happy path, double-redeem, claims-pending-
  atomically, expiry-reap) still cover their original branches.
- **Lint** — no lint script in this package.
- **Type-check** — `tsc --noEmit` produces only pre-existing failures in
  unrelated files (`src/nat/__tests__/nat-service.test.ts`,
  `src/server/__tests__/{error-handler,nodes-route,publishers,status-route}.test.ts`).
  None reference the modified files; not investigated as part of this ticket.

### Minor findings (noted, not fixed)

- **Misleading `already_redeemed` to second concurrent caller when first call
  later fails.** When two concurrent redeems hit the same token and the first
  ultimately fails with `node_unavailable`, the second was rejected
  synchronously with `already_redeemed` — but the token is in fact still
  redeemable. The second caller would need to retry to discover that. Concurrent
  same-token redeems are unusual (one-time-use, intra-process), and the
  cure (deferring the second caller until the first resolves, then either
  re-running it or surfacing its failure) is more complexity than the
  scenario justifies. Acceptable.
- **Revoke-during-in-flight race not introduced but slightly shifted.**
  Previously, `revokePending` during an in-flight redeem was a no-op
  (pending already removed). Now `revokePending` succeeds at removing the
  pending row, but the in-flight redeem still proceeds to authorize the peer
  and write a labelled member row (post-success `removePending` becomes a no-op).
  Net user-visible behaviour is the same as before — in both designs, revoke
  cannot stop an in-flight authorization — so this is not a regression. Worth
  noting in case a future ticket wants revoke to also reject in-flight
  redemptions (would require checking `inFlightRedemptions` in `revokePending`
  and either failing or queueing).

### Major findings

None.

### Deferred / out of scope

- **Crash-during-success window not exercised by automated tests.** The
  behaviour (retry → cadre-core PK constraint error from the second
  `CadrePeer` insert → surfaces to redeemer as a non-`node_unavailable` error
  → admin revokes the lingering pending row) is reasoned about in the source
  comment but would require harness work (mid-call process kill) to verify
  end-to-end. The implement ticket flagged this as deferred; no new ticket
  filed because the failure mode is bounded, well-documented, and survivable
  via the existing admin revoke path.
- **Test 3's broadened "any failure leaves pending" semantics.** Implementer
  flagged this as a design judgment call. After review: the broader rule is
  the safer choice. The narrower "transient only → preserve, otherwise burn"
  rule would re-introduce a smaller version of the original regression for
  failure classes not yet wrapped in `AuthorityNodeUnavailableError` (e.g.
  transport-level oddities, future cadre-core errors). Conservative rule
  retained; no new ticket.

## Files touched

- `packages/cadre-host/src/auth/trust-circle.ts` — added
  `private readonly inFlightRedemptions = new Set<string>()`, rewrote
  `redeemInvite` per the design above, expanded leading JSDoc with the new
  ordering and crash-safety tradeoff.
- `packages/cadre-host/src/auth/__tests__/trust-circle.test.ts` — added three
  new tests under `describe('TrustCircleService.redeemInvite', …)`.
- `docs/cadre-host.md` — updated the Redeem lifecycle bullet (step 3 of the
  trust-circle lifecycle) to reflect the new ordering.

## Verification

- `yarn workspace @serfab/cadre-host vitest run src/auth/__tests__/trust-circle.test.ts` → 27 passed.
- `yarn workspace @serfab/cadre-host vitest run src/auth/__tests__/` → 40 passed, 1 skipped.
- `yarn workspace @serfab/cadre-host vitest run src/auth/__tests__/trust-circle-integration.test.ts` → 1 passed, 1 skipped (real-network integration; success path unchanged end-to-end).
- `yarn workspace @serfab/cadre-host tsc --noEmit` — only pre-existing failures in unrelated files (NAT and server route tests). None reference the modified files.
