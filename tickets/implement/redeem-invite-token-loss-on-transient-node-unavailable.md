---
description: Defer the durable pending-invite removal in `TrustCircleService.redeemInvite` until *after* a successful `acceptPhone`, using an in-memory in-flight Set to keep the concurrent double-redeem guard. Fixes the regression where a transient `node_unavailable` from the authority-node admin channel permanently burns a one-time invite token.
files: packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/auth/__tests__/trust-circle.test.ts
---

## Root cause (verified)

`TrustCircleService.redeemInvite` durably removes the pending invite row *before*
awaiting `acceptPhone`. The synchronous removal was deliberate — it serialised
concurrent redemptions through the durable store. That was a fine ordering when
`acceptPhone` ran against an in-process `CadreNode` (couldn't fail transiently);
after 6.7 (`cadre-host-authority-node-delegation`), `acceptPhone` is an HTTP
call to the authority node's loopback admin channel. The node can be transiently
unavailable (restarting, not-ready), surfacing as `AuthorityNodeUnavailableError`
→ `node_unavailable`. The pending row is already gone → the token is permanently
consumed even though nothing was authorized.

## Idempotency check on cadre-core

I verified the crash-safety angle the original ticket flagged:

- `CadrePeer.PeerId` is a **primary key** (`schemas/control.qsql:44-46`).
- `SeedBootstrapService.authorizePeer` does a plain `insert into
  CadreControl.CadrePeer` (`packages/cadre-core/src/seed-bootstrap.ts:159-167`),
  **not** `insert or ignore` / upsert.
- Therefore `acceptPhone` is **not** idempotent on cadre-core when called twice
  with the same `phonePeerId` after a previous success — the second call throws
  a PK constraint error.

But this only matters for the **host-crash-mid-flight** edge case (acceptPhone
succeeded on the node, host crashed before the post-success durable removal).
For the *transient `node_unavailable`* case this ticket targets, the HTTP
request never reached the node's `acceptPhone` logic (connection refused or 503
from the admin server), so `CadrePeer` was **not** inserted, and a retry from
the same phone with the same token is a clean re-run.

The narrow crash window is acceptable: a re-redeem after host crash mid-flight
would surface the duplicate-`CadrePeer` error to the redeemer (not as
`node_unavailable`), and the admin can revoke the lingering pending row.

## Fix design

Keep the synchronous *claim* (so concurrent redeems still serialise) but switch
the claim from durable `removePending` to an in-memory `Set<string>`. Only
durably remove the pending row on success.

```
async redeemInvite({ token, peerId }) {
  // validation as today

  const pending = this.store.getPending(token);
  if (!pending) throw already_redeemed;
  if (expired(pending)) {
    this.store.removePending(token);      // expiry is permanent → reap
    throw expired;
  }

  // In-memory claim. Synchronous; serialises concurrent redeems for the same
  // token. Second concurrent caller sees the token in the set and rejects
  // synchronously *before* its first await.
  if (this.inFlightRedemptions.has(token)) throw already_redeemed;
  this.inFlightRedemptions.add(token);

  try {
    const reconstructed = { ... };        // unchanged
    await this.cadreNode
      .acceptPhone({ phonePeerId: peerId, token }, reconstructed)
      .catch(err => this.toDomainError(err));

    // Success: now durably consume. A crash here leaves the token
    // re-redeemable; a retry's acceptPhone will fail with a CadrePeer PK
    // error (not node_unavailable), which the admin can resolve by revoking.
    this.store.removePending(token);
    this.store.addMember({ peerId, label: pending.label, addedAt: ... });
    return { peerId, label: pending.label };
  } finally {
    this.inFlightRedemptions.delete(token);
  }
}
```

On `node_unavailable` (or any non-success), the `finally` clears the in-flight
slot and the pending row stays — the redeemer can retry once the node is back.

### Why not "remove on permanent errors only"

The ticket's option B (distinguish transient from permanent failures and only
re-instate the pending row on transient ones) is rejected: any non-`node_unavailable`
error from `acceptPhone` today (e.g. validation in cadre-core, transport-level
oddities not yet classified as `node_unavailable`) is *also* a case where the
peer wasn't authorised. Burning the token on those would re-introduce a smaller
version of the same regression. Leaving the row pending on *any* failure and
letting the admin revoke is the conservative choice.

### Why an in-memory Set is sufficient for the concurrent guard

The double-redeem race is *intra-process* (same host process, two concurrent
HTTP requests against the local-UI server). The orchestrator already enforces
single-process ownership of a given `rootDir` (see `TrustCircleStore`'s
"only one cadre-host process owns a given rootDir" assumption). No
file-locking promotion needed.

## Tests to add

In `packages/cadre-host/src/auth/__tests__/trust-circle.test.ts` under the
existing `redeemInvite` describe block:

1. **Transient node_unavailable preserves the token**:
   - Configure `MockCadreNode.acceptShouldThrow = new AuthorityNodeUnavailableError(...)`.
   - Assert `redeemInvite` rejects with `code: 'node_unavailable'`.
   - Assert `store.getPending(token)` is still defined.
   - Then clear `acceptShouldThrow` and re-invoke `redeemInvite` with the same
     token + peerId; assert success and `authorizedPeers.has(peerId)`.

2. **Concurrent guard during a hanging acceptPhone — pending stays on failure**:
   - Gate `acceptPhone` (existing pattern from the `claims pending atomically`
     test). Start two concurrent redeems; second rejects synchronously with
     `already_redeemed`. Reject the gate with `AuthorityNodeUnavailableError`
     instead of resolving. Assert the first call rejects with `node_unavailable`,
     pending row still exists, and a third call (after the in-flight Set
     clears) succeeds.

3. **Non-transient acceptPhone failure also leaves the token re-redeemable**
   (documents the broadened recovery semantics — adjust if the team prefers
   the narrower "transient only" rule):
   - Set `acceptShouldThrow = new Error('something else')`.
   - Assert the rethrow surfaces; assert `store.getPending(token)` still exists.

The existing tests should keep passing without modification (verified by code
read): `'happy path'` exercises the success → durable remove; `'rejects
expired'` exercises the expiry-reap path; `'double-redeem' (sequential)`
exercises the post-success `getPending` → `undefined` branch; `'claims pending
atomically'` exercises the in-flight-Set claim during a gated acceptPhone (the
second redeem still rejects synchronously because the in-flight `add` happens
before the first `await`).

## Doc touch-up

`docs/cadre-host.md:128` describes the old "atomically consumes the pending
row" semantics. Update the redeem step's wording to reflect the new ordering
("the authority node authorizes the peer; on success the pending row is
consumed; on transient node_unavailable the token remains redeemable").

## TODO

- Add `private readonly inFlightRedemptions = new Set<string>()` field to
  `TrustCircleService` (`packages/cadre-host/src/auth/trust-circle.ts`).
- Rewrite `redeemInvite` per the Fix design block above. Replace the synchronous
  `getPending + removePending` claim with `getPending` + in-flight-Set claim;
  defer `removePending` to the post-success branch (keep the expiry reap as a
  durable remove). Update the leading comment block to describe the new
  ordering and the crash-safety tradeoff.
- Add the three new tests in `packages/cadre-host/src/auth/__tests__/trust-circle.test.ts`
  listed under "Tests to add".
- Verify existing tests still pass (`yarn workspace @serfab/cadre-host test`
  or run vitest on `src/auth/__tests__/trust-circle.test.ts`).
- Update `docs/cadre-host.md` redeem-step bullet to reflect the new ordering.
- Run the cadre-host trust-circle integration test
  (`packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts`)
  to confirm the success path is unchanged end-to-end.
