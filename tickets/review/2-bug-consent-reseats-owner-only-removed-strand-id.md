description: When a party deletes one of its networks, someone holding an unused invitation could bring that network's entry back under the same name; the deletion record now names the deleted entry, and the invitation path refuses any name that was ever deleted. Review the implementation.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, docs/architecture.md
difficulty: medium
----

# Review: network-entry deletion now final against the unsigned (consent) path

## What was built

The bug: a `CadreControl.Strand` row seated purely owner-signed writes no
`FormationUsage` record, so the consent branch's "once per id, ever" rule (which keys
off a surviving usage row) could not foreclose it — after a legitimate owner-signed
removal, a spare unbound invite use could re-seat the same strand id unsigned.

The fix, in two parts:

1. **`Revocation` gained `RowKey text not null`** — the removed row's primary key
   (OwnerKey.Key / ValidationKey.Key / CadrePeer.PeerId / DeviceToken.PeerId /
   Strand.Id), placed between `TableName` and `StampId` in the column list and in the
   owner-signed `Authorized` digest, which is now
   `digest('CadreControl.Revocation', 'remove', TableName, RowKey, StampId)`.
   Primary key stays `(TableName, StampId)` — one name may carry several tombstones
   across seat/remove cycles.
2. **`Strand.AuthorizedInsert`'s consent branch gained a final clause**:
   `not exists (select 1 from Revocation R where R.TableName = 'Strand' and R.RowKey = new.Id)`
   — a strand id may be consent-seated once ever AND never after any removal of that
   id, however it was seated. The owner-signed branch is untouched: re-join stays
   owner-gated (fresh stamp + signature seats a tombstoned id fine).

Schema edited in both copies (`schemas/control.qsql` and the inlined duplicate in
`packages/cadre-core/src/control-schema.ts`); the drift spec pins they match. Design
rationale lives as constraint comments in the schema itself — read the `Revocation`
table and the `Strand.AuthorizedInsert` consent branch there first.

Writers updated: `peer-authorization.ts` `revocationDigest(tableName, rowKey, stampId)`;
`control-database.ts:deleteGuardedRow` signs and inserts the 3-field shape;
`seed-bootstrap.ts` `deleteDeviceToken` / `removePeer` pass the peer id. Test helpers in
four spec files converted to the 3-field shape with real row keys at every call site.

## Deliberate design decisions (verify the reasoning, not just the code)

- **`RowKey` is owner-attested, not schema-verified.** The `Authorized` digest binds it
  under the owner's signature, but no constraint checks it equals the deleted row's
  actual key (`committed.*` cross-checks were rejected — rationale in the schema
  comment). Consequence: an owner can file a tombstone naming an id that never existed
  and pre-foreclose consent-seating of it — owner-only, and the owner already controls
  invite issuance, so judged no escalation. Reviewer should sanity-check that argument.
- **Convergence caveat**: like `NotRevoked`, the new clause is a write-time check
  against locally visible rows — a node that has not yet synced the tombstone still
  accepts the re-seat. Fails safe: after merge the tombstone and resurrected row
  coexist, same class as the pre-existing StampId note. Echoed in schema comments.
- **`schemas/strand.qsql` untouched** — `Strand.Revocation` (per-strand RBAC layer)
  keeps its 2-field shape; different layer, different threat model.
  `strand-membership-writer.ts` and three strand specs still insert 2-column there
  intentionally.
- **`control-devicetoken-stamp-constraint.spec.ts` untouched** — it uses its own local
  crypto-free `Probe` schema with a 2-column Revocation; it exercises stamp mechanics,
  not the digest.
- **No migration** — repo has no backwards-compat requirement yet; old-shape databases
  are not handled.

## Test coverage (floor, not ceiling)

- `control-revocation-replay.spec.ts` — the heart:
  - `'Strand: an id seated ONLY owner-signed, then removed, can never be
    consent-seated'` — the exact reported bug: expects `AuthorizedInsert` failure on
    `redeemInvitation`, row stays absent, then proves the carve-out: owner-signed
    re-seat of the same id succeeds despite the tombstone, and a bound invite still
    records usage against it.
  - Transplant test: signature over a DIFFERENT RowKey refused; signature over the
    legacy 2-field digest (no RowKey) refused.
  - `deleteStrand` end-to-end asserts the tombstone's `RowKey` equals the strand id.
- `control-authorization-binding.spec.ts` — `deleteValidationKey` / `deleteStrand`
  tombstones assert `RowKey` equals the deleted key/id; re-form tests
  (add → remove → re-add owner-signed) still pass, proving the owner branch ignores
  the tombstone.
- `control-authorization-domain-separation.spec.ts`, `control-ownerkey-self-authorization.spec.ts`
  — helpers converted; all cross-domain replay pins still hold under the 3-field digest.
- `docs/architecture.md` — Strand + Revocation table rows and the Strand Membership
  Bootstrap section updated; the "Residual — removal does not yet stick for owner-only
  ids" paragraph replaced with the new rule.

## Validation run

- Targeted: 7 spec files (revocation-replay, schema-drift, domain-separation,
  ownerkey-self-auth, authorization-binding, seed-bootstrap, device-token-registry) —
  170 tests pass.
- Full `@serfab/cadre-core` suite: 67 files, 1028 pass, 1 skip (pre-existing
  win32-conditional in `key-store.spec.ts`, unrelated).
- `yarn typecheck` and `yarn lint` at root: clean.

## Known gaps for the reviewer

- **`integration-tests` package not run** (cross-package real-network; builds against
  `dist`, long wall clock). If any integration test hand-builds a
  `CadreControl.Revocation` insert or the revocation digest, it will break — grep for
  `Revocation` there before signing off.
- No test pins the exact `RowKey` value convention per table beyond Strand and
  ValidationKey (e.g. no assertion that an OwnerKey tombstone's RowKey is the key, not
  the stamp) — writers do it correctly and the digest binds whatever was passed, but a
  wrong-key writer regression elsewhere would only surface behaviorally for Strand.
- Consent-branch clause matches on `R.TableName = 'Strand'` only; a tombstone for
  another table naming a colliding id does not foreclose a strand id (ids are 128
  random bytes, so collision is theoretical) — judged fine, worth a second opinion.
