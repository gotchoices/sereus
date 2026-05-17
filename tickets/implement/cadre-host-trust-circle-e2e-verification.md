---
description: Verify the new end-to-end integration tests for SeedBootstrapService.removePeer and the full TrustCircleService issue→redeem→list→remove cycle pass cleanly, then hand off to review.
prereq: cadre-host-trust-circle
files: packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-core/src/seed-bootstrap.ts
---

## Status

The two integration tests called out in the parent fix ticket have been written and pass locally:

1. **`packages/cadre-core/test/seed-bootstrap.spec.ts`** — added a new
   `describe('authorizePeer / removePeer — round-trip against a real control DB', …)`
   block under `SeedBootstrapService Helper Methods`. It boots a real
   `CadreNode`, inserts the authority key, calls `node.authorizePeer(...)`,
   reads `CadreControl.CadrePeer` directly via `db.eval`, calls
   `node.removePeer(...)`, and asserts the row is gone. Co-located with the
   guard-rail-only `removePeer` describe block already present.

2. **`packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts`** —
   new file. Spins up two real `CadreNode`s (host + phone), wires the host
   into `TrustCircleService` with a `TrustCircleStore` on a `tmpdir`, issues
   an invite, redeems it with the phone's peerId, then asserts:
     - `CadrePeer` contains the phone's row (read via `db.eval`)
     - `service.list()` returns one labelled member
     - `service.removeMember(phonePeerId)` removes both the `CadrePeer` row
       and the local label, and `list()` reflects the removal.

   This replaces the mock `CadreNodeLike` in `trust-circle.test.ts` for
   the v1 surface — the mocked tests stay (they exercise the
   atomic-claim / concurrent-redeem semantics far more cheaply than a
   real node bring-up).

The redeem path went through real `cadre-core` validation:
`TrustCircleService.redeemInvite` reconstructs a sparse `CadreInvite`
(`partyId: ''`, `authorityAddrs: []`) and passes it to
`CadreNode.acceptPhone`. The integration test confirms cadre-core accepts
this shape (no `partyId` cross-check against the invite, just a
token/expiry check) and that the resulting `authorizePeer` call inserts
the CadrePeer row exactly as expected. The Quereus DELETE-with-context
syntax in `SeedBootstrapService.removePeer` is also confirmed working —
the constraint signs over `digest(coalesce(new.PeerId, old.PeerId), …)`,
so the same signature pattern as `authorizePeer` is correct on delete.

## Why not 2 connected nodes?

Each test brings up nodes with disjoint partyIds (`host-…` and `phone-…`)
and no bootstrap nodes; the phone node is used only for its peerId. The
ticket's redemption-cycle scope is local to the host's control DB —
cross-node libp2p connectivity is `cadre-host-over-P2P` work. Connecting
the two nodes would add ~seconds of dial/setup time without exercising
any new code path.

## TODO

- Run `cd packages/cadre-core && yarn test` and `cd packages/cadre-host && yarn test` to confirm green (both pass at 133/133 and 150/2-skipped/152, with the new integration test at ~380ms).
- Run `yarn build` in each of `packages/cadre-core` and `packages/cadre-host` to confirm typecheck.
- Hand off to review.
