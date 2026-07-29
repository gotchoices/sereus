----
description: A phone's push-token row is authorized by the same reusable signature style we just hardened for member rows; give it the same single-use, action-scoped treatment so a captured authorization can't be replayed.
files:
  - packages/cadre-core/src/control-schema.ts + schemas/control.qsql (DeviceToken table)
  - packages/cadre-core/src/seed-bootstrap.ts (insertSelfDeviceToken, clearDeviceToken — both sign peerAuthorizationDigest(peerId))
  - packages/cadre-core/src/peer-authorization.ts (add DeviceToken-scoped digests, mirroring cadrePeerVoucherDigest/cadrePeerRemoveDigest)
----

# DeviceToken authority actions should be single-use + action-scoped

Follow-up from `membership-cadrepeer-authority-antireplay`. The `CadrePeer` fix gave member
rows a single-use `StampId` nonce and distinct insert-vs-delete signed payloads, so a captured
authority signature can't be replayed for a different action. `DeviceToken` was left out of that
ticket's scope: its `AuthorizedInsert check on insert, delete` still verifies a signature over the
single-field `digest(coalesce(new.PeerId, old.PeerId))`, and `insertSelfDeviceToken` /
`clearDeviceToken` both sign `peerAuthorizationDigest(peerId)`.

`DeviceToken` does NOT store the authority signature on the row, so it lacks the *stored-voucher*
replay exposure that made `CadrePeer` urgent — but it still has no anti-replay nonce (a
network-captured `digest(peerId)` authority signature could be replayed to re-insert or delete a
token row) and its insert/delete share one signed payload. This is defense-in-depth, not a live
hole, hence backlog rather than fix.

Bring it in line with `CadrePeer`: add a single-use `StampId` (unique), split the insert/delete
authorization into distinct action-scoped digests (e.g. `deviceTokenVoucherDigest(peerId, stampId)`
/ `deviceTokenRemoveDigest(peerId, stampId)`), and thread the nonce through the two write paths.
Keep `control-schema.ts` and `schemas/control.qsql` byte-aligned (the `control-schema-drift` spec
enforces it). Cover it with the crypto-free constraint-spec pattern used for `CadrePeer`
(`control-cadrepeer-voucher-constraint.spec.ts`) plus the real-crypto device-token integration path.
