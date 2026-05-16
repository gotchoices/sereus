---
description: Stand up real CadreNode + Quereus control DB and exercise TrustCircleService end-to-end — verify Quereus DELETE-with-context syntax for removePeer, and the full issue→redeem→list→remove cycle against the live database.
prereq: cadre-host-trust-circle
files: packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/auth/__tests__/trust-circle.test.ts
---

## Background

The implement+review pass of `cadre-host-trust-circle` left two known gaps that should be closed before the local-UI ticket starts depending on this surface for real traffic:

1. **`SeedBootstrapService.removePeer` was never exercised against a real Quereus control DB.** The DELETE-with-context syntax (`delete from CadreControl.CadrePeer with context AuthorityKey = ?, Signature = ? where PeerId = ?`) was trusted from `quereus/docs/sql.md`. The existing `seed-bootstrap.spec.ts` checks only the "no key" / "no DB" guard rails, mirroring the gap that already exists for `authorizePeer`. If Quereus's actual semantics differ from the docs (e.g. column-name canonicalisation in the WHERE clause, signature scope on DELETE), every `cadre-host trust revoke <peerId>` call silently fails.

2. **`TrustCircleService.redeemInvite` is only tested against a mock `CadreNodeLike`.** The mock satisfies the type signature but doesn't validate that `acceptPhone` actually inserts the row, that the reconstructed sparse `CadreInvite` (`partyId: ''`, `authorityAddrs: []`) is accepted by the real cadre-core validator, or that `list()` picks up the newly-authorized peer from `CadrePeer`.

## What to do

- Add an integration test (probably under `packages/cadre-core/test/`) that starts a real `CadreNode` with an authority key, calls `authorizePeer` then `removePeer`, and reads back from `CadreControl.CadrePeer` via `db.eval` to assert the row is gone. Use the existing pattern from `cadre-node.spec.ts` for control-node bring-up.
- Add an integration test for the trust-circle redemption cycle: spin up two cadre-nodes (host + phone), issue an invite via `TrustCircleService`, redeem from the phone's peerId, and assert (a) `CadrePeer` contains the phone's row, (b) `service.list()` returns a single labelled member, (c) `service.removeMember(phonePeerId)` removes both the `CadrePeer` row and the local label.

These tests probably belong in `packages/cadre-core/test/` (where the libp2p bring-up plumbing already exists), with a thin wrapper that imports `TrustCircleService` from `@serfab/cadre-host`.

## Out of scope

Cross-WAN redemption (`cadre-host-over-P2P`), management-API auth, and friend-side labels are still future work — this ticket is only about replacing the mock with a real one for the v1 surface.
