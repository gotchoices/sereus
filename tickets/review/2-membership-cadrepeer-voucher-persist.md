----
description: Persisted the vouching authority (key + signature) onto each CadrePeer membership row, so a reader can later prove which authority approved a peer. No enforcement yet — ticket 4 consumes it.
prereq: membership-authorized-surface-split
files:
  - packages/cadre-core/src/control-schema.ts (CadrePeer: +VouchAuthority/+VouchSig, AuthorizedInsert binding, AuthorizedUpdate immutability)
  - schemas/control.qsql (mirror of the above — kept byte-aligned; control-schema-drift guards it)
  - packages/cadre-core/src/seed-bootstrap.ts (insertCadrePeerRow writes the voucher == context pair)
  - packages/cadre-core/src/control-database.ts (queryCadrePeers surfaces vouchAuthority/vouchSig)
  - packages/cadre-core/test/control-cadrepeer-voucher-constraint.spec.ts (new crypto-free predicate spec)
difficulty: medium
----

# Review: persist the vouching authority on each CadrePeer row

Step 2 of the Option-B chain. No migration path (dev-only stores, per the maintainer) —
fresh schema, fail-closed on any null voucher downstream.

## What was built

- **Schema (both synced copies):** `CadrePeer` gains `VouchAuthority text null` +
  `VouchSig text null`. `AuthorizedInsert` now additionally requires
  `new.PeerId is null or (new.VouchAuthority = context.AuthorityKey and new.VouchSig =
  context.Signature)` — so the stored voucher MUST equal the (authority, signature) pair
  the existing `verify` branch already validated; a writer cannot store a voucher it has
  no signature for. The `new.PeerId is null` guard keeps the shared insert/**delete**
  constraint delete-safe (delete carries no `new` row). `AuthorizedUpdate` self-branch
  adds `new.VouchAuthority = old.VouchAuthority and new.VouchSig = old.VouchSig`
  (voucher immutable on self-refresh); the authority-rotation branch re-binds the voucher
  to the re-authorizing authority.
- **Write path:** `insertCadrePeerRow` (the single shared insert behind `authorizePeer`
  and `insertSelfPeerRecord`) writes `VouchAuthority`/`VouchSig` = `this.authorityPublicKey`
  / the `digest(peerId)` signature — identical to the context pair.
- **Read path:** `queryCadrePeers()` now returns `{ peerId, multiaddr, vouchAuthority,
  vouchSig }`. Widening is additive; existing callers (`listMembers`/`listAuthorizedMembers`
  typed `{peerId,multiaddr}`) still compile via structural subtyping and ignore the extra
  fields — ticket 4 widens those return types to actually consume the voucher.

## Verification run

- New `control-cadrepeer-voucher-constraint.spec.ts` (crypto-free Probe, mirroring
  `control-member-key-constraint.spec.ts`): **6/6** — stores voucher on match; rejects
  mismatched `VouchAuthority`; rejects mismatched `VouchSig`; admits delete; rejects a
  self-update that rewrites the voucher; admits an untouched self-update.
- `control-schema-drift` + `control-member-key-constraint` + `cadre-node-control-replication`
  + `cadre-node-control-cohort` + `peer-authorization` + `authority-key`: **54/54**.
- Integration (REAL authorizePeer insert through the new constraint, cross-node read):
  `cadre-host-authority-node` + `control-db-two-node-convergence`: **10/10**. This is the
  end-to-end proof that `insertCadrePeerRow` supplies a constraint-valid voucher and it
  replicates + reads back.
- `yarn typecheck` (cadre-core) clean; `yarn lint` 0/0.

## Known gaps / what the reviewer must scrutinize

- **No enforcement here.** Membership is still "row present (minus self)" — the voucher is
  written and readable but not yet checked. Ticket 4 (`membership-authorized-predicate-and-gates`)
  is what checks `vouchAuthority` against the node-local anchor. Do not expect the
  non-member wake hole to close in this diff.
- **Crypto-free coverage boundary.** The voucher *binding* is pure equality and is tested
  directly; the `verify(digest(...))` crypto branch of `AuthorizedInsert/Update` is
  unchanged and covered only by the real-crypto integration path above. Confirm the drift
  guard still pins both constraint texts byte-for-byte (it passed).
- **Strict `=` on the immutability check.** `new.VouchAuthority = old.VouchAuthority`
  is NULL-unsafe by design: with no migration, every inserted row has a non-null voucher,
  so `old` is never null. If a null-voucher row ever existed (it shouldn't), its
  self-update would fail closed — acceptable, but worth a reviewer's eye if any non-insert
  path could create a voucher-less row.
- **`queryPeerRecord` unchanged** — it still returns the `PeerAddressRecord` shape (no
  voucher). That is correct (address resolution doesn't need the voucher), but confirm no
  membership decision reads through `queryPeerRecord` expecting a voucher.

## Not covered / deferred

- Widening `listMembers`/`listAuthorizedMembers` return types to carry the voucher is
  ticket 4's job (it needs them for the predicate). Left intentionally.
