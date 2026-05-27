---
description: redeemInvite consumes the one-time pending invite row *before* delegating acceptPhone to the authority node. Now that acceptPhone round-trips over the loopback admin channel (6.7), a *transient* node_unavailable (node restarting / not-ready) permanently burns the token — the member must be re-invited even though nothing was actually authorized. With the old in-process node this failure mode was effectively impossible.
files: packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/auth/trust-circle-store.ts, packages/cadre-host/src/auth/__tests__/trust-circle.test.ts
---

## Problem

`TrustCircleService.redeemInvite` (in `packages/cadre-host/src/auth/trust-circle.ts`) claims and
removes the pending invite row *synchronously* before any async work:

```ts
const pending = this.store.getPending(token);
if (!pending || !this.store.removePending(token)) {
  throw new TrustCircleError('already_redeemed', ...);
}
// ... expiry check ...
await this.cadreNode.acceptPhone({ phonePeerId: peerId, token }, reconstructed)
  .catch((err) => this.toDomainError(err));   // may throw node_unavailable
```

The early `removePending` is deliberate — it closes the concurrent double-redeem race and is the
safe failure mode for a *one-time durable* credential against a crash. That reasoning held when
`acceptPhone` ran against an in-process `CadreNode` (it essentially couldn't fail transiently).

After the 6.7 control-plane realignment, `acceptPhone` is an HTTP call to the authority node's
loopback admin channel. The node can be **transiently** unavailable (restarting, not-ready after a
`/api/nodes/authority/restart`, briefly refusing connections). In that window:

- the pending row is already gone,
- `acceptPhone` throws `node_unavailable` (→ 503),
- the peer was **never** inserted into `CadrePeer`,
- the token is permanently consumed → the admin must issue a brand-new invite.

So a recoverable, no-op-on-the-node failure is indistinguishable from a successful redemption as far
as the token lifecycle is concerned. This is a behavioral regression introduced by delegation.

## Expected behavior

A transient `node_unavailable` during redemption should leave the invite **re-redeemable** (the
token survives), so a retry once the node is back succeeds — without weakening the one-time guarantee
on the *success* path or re-opening the concurrent double-redeem race.

## Notes / direction (for the fix stage to settle)

- One option: keep the synchronous *claim* (so concurrent redeems still serialize) but defer the
  durable `removePending` until **after** a successful `acceptPhone`; restore/leave the pending row
  on a `node_unavailable` failure. Must preserve the double-redeem race protection (e.g. an
  in-memory "in-flight" guard distinct from the durable removal).
- Alternatively, distinguish transient (`node_unavailable`) from permanent (`already_redeemed`,
  `expired`, validation) failures and only re-instate the pending row on transient ones.
- Watch the crash-safety tradeoff the current comment calls out: deferring the durable removal means
  a crash mid-`acceptPhone` could leave a redeemable token whose peer *was* inserted. Decide whether
  that's acceptable (a re-redeem is idempotent on the node side if acceptPhone is idempotent — verify
  that against cadre-core).
- Add tests: transient `node_unavailable` during `acceptPhone` leaves the token redeemable; a second
  concurrent redeem of the same token still gets `already_redeemed`; the success path still consumes
  the token exactly once.

Surfaced by the 6.7 review (`cadre-host-authority-node-delegation`).
