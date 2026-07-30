description: When a party deletes one of its networks, someone holding an unused invitation can bring that network's entry back by re-creating it under the same name; record the deleted name in the deletion record so no unsigned path can re-create it.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, docs/architecture.md
difficulty: hard
----

<!-- resume-note -->
Second continuation (2026-07-30). Run 1 was recon only. Run 2 (this note) IMPLEMENTED the
schema, all src writers, and the main spec file, then hit the soft token budget. The
working tree carries those edits UNCOMMITTED — do not revert anything. Everything left is
listed under "Remaining TODO"; the design rationale is in the sections below and, more
importantly, now lives as comments in `schemas/control.qsql` itself — read the
`Revocation` table and the `Strand.AuthorizedInsert` consent branch there first.
NOTHING has been validated yet: no test run, no typecheck, no lint. Start with the
remaining test-file edits, then validate.
<!-- /resume-note -->

# Make a network entry's deletion final against the unsigned (consent) path

## The fix (as implemented — matches the plan exactly)

`Revocation` gained `RowKey text not null` (the removed row's primary key: OwnerKey.Key /
ValidationKey.Key / CadrePeer.PeerId / DeviceToken.PeerId / Strand.Id), placed between
`TableName` and `StampId` in both the column list and the `Authorized` digest
(`digest('CadreControl.Revocation', 'remove', new.TableName, new.RowKey, new.StampId)`).
The consent branch of `Strand.AuthorizedInsert` gained a final clause:

```sql
and not exists (
    select 1 from Revocation R
        where R.TableName = 'Strand' and R.RowKey = new.Id
)
```

PK stays `(TableName, StampId)`. Existing once-ever `FormationUsage` clause kept. The
owner-signed branch untouched — re-join stays owner-gated. All the "deliberately NOT
done" decisions from the prior ticket (stamp-only `RowIsGone`, owner-attested `RowKey`,
no invite-derived ids, no redemption-record requirement, `schemas/strand.qsql` untouched)
were followed and are documented as schema comments.

## DONE (uncommitted in working tree)

**Phase 1 — schema (both copies edited identically):**
- `schemas/control.qsql`: `RowKey` column + comment; PK comment (one name may carry
  several tombstones); `RowIsGone` comment (why stamp-only — out-of-order convergence);
  `Authorized` digest now 3-field + comment block (RowKey owner-attested, why not
  `committed.*`-verified, owner pre-foreclose consequence); table header comment mentions
  RowKey; consent branch: RESIDUAL paragraph replaced with the new-rule bullet (once ever
  AND never after any removal; owner branch unaffected; convergence NOTE echoed) and the
  `not exists (Revocation ...)` clause added after the FU2 clause.
- `packages/cadre-core/src/control-schema.ts`: identical edits mirrored (no backticks
  involved). Drift spec should pass — NOT yet run.

**Phase 2 — writers (all done):**
- `peer-authorization.ts`: `revocationDigest(tableName, rowKey, stampId)` — 3-field
  digest, doc comment updated.
- `control-database.ts:deleteGuardedRow`: tombstone signs `[table, keyValue, stampId]`,
  insert is `(TableName, RowKey, StampId)` with `keyValue` as RowKey.
- `seed-bootstrap.ts`: `deleteDeviceToken` and `removePeer` both pass `peerId` as rowKey
  in digest + 3-column insert.
- Grep confirmed: no other `insert into CadreControl.Revocation` in src. Three test
  helpers exist (see Remaining). `control-devicetoken-stamp-constraint.spec.ts` uses its
  own local Probe schema — left untouched per plan.

**Phase 3 — `control-revocation-replay.spec.ts` (done, unvalidated):**
- `revocationMessage(tableName, rowKey, stampId)`; `rawTombstone(...)` + `tombstoneStamp(...)`
  take `rowKey`, 3-column insert; file header updated.
- ALL `tombstoneStamp` / `rawTombstone` call sites updated with the correct row key
  (helper wrappers pass real keys; Authorized-section probes use descriptive constants).
- Transplant test extended with two NEW probes: signature over a DIFFERENT RowKey is
  refused, and a signature over the legacy 2-field digest (omitting RowKey) is refused.
- RESIDUAL test flipped: renamed to `'Strand: an id seated ONLY owner-signed, then
  removed, can never be consent-seated'`, expects
  `expectConstraintFailure(db.redeemInvitation(...), 'AuthorizedInsert')`, asserts strand
  row stays undefined, then exercises the carve-out: `seatStrand(id, 'o', null)` succeeds
  despite the tombstone + bound invite `recordFormationUsage` returns 1.
- `deleteStrand` end-to-end test now asserts the tombstone's `RowKey` equals the strand id.

## Remaining TODO

**Finish Phase 3 — other test files (recon pointers, line numbers from HEAD 8e2d1c8):**

- Sanity-grep `control-revocation-replay.spec.ts` for any missed 2-arg
  `revocationMessage(`/`tombstoneStamp(` call (IDE diagnostics were lagging during the
  run; believed complete but unverified — typecheck will tell).
- `control-authorization-domain-separation.spec.ts`: helper at 101-113 builds the 2-field
  revocation digest via `buildAuthorizationMessage` and does a 2-column insert; typed
  `tableName: 'OwnerKey' | 'CadrePeer' | 'DeviceToken'`. Add a rowKey param (digest order:
  tableName, rowKey, stampId; insert `(TableName, RowKey, StampId)`). Call sites 192, 343,
  360, 380 — row keys in scope near each (peer ids / owner keys / `row.peerId`); read
  ~15 surrounding lines per site.
- `control-ownerkey-self-authorization.spec.ts`: `tombstoneOwnerKeyStamp(stampId)` at
  125-136 → add the owner-key param (it IS the RowKey). Call sites with the key to pass:
  267 `second.publicKey`, 343 `second.publicKey`, 359 `founder.publicKey`,
  389 `second.publicKey`, 390 `founder.publicKey`, 410 `second.publicKey`,
  435 `founder.publicKey`, 457 `second.publicKey`.
- `control-authorization-binding.spec.ts`: `revocationRow` at 106-111 selects
  `TableName, StampId` → also select `RowKey`. Add assertions: 613-623
  (`deleteValidationKey` → RowKey = `key`), 625-635 (`deleteStrand` → RowKey =
  `strandId`). Reads at 693/707 stay presence-checks. Re-form tests 681-708 use
  owner-signed inserts and MUST keep passing (they prove the owner branch ignores the
  tombstone).
- `seed-bootstrap.spec.ts`: only a comment references `Revocation` — verify it still
  reads true; no code edit expected.
- CAUTION — door-2 in `control-revocation-replay.spec.ts` (test `'Strand: a redemption
  record cannot re-seat the strand it formed after a tombstoned removal'`, insert of the
  ORIGINAL stamp pinned to `NotRevoked`): post-fix the consent branch is ALSO false
  (tombstone names the id), so the reported constraint may be `AuthorizedInsert` instead.
  Run it, check the actual failure, and if needed widen ONLY that one pinned name to
  accept either constraint (both prove the block). Do not loosen anything else.

**Phase 4 — docs + validation (none started):**

- `docs/architecture.md:41` — `Revocation` row description: signature binds
  `(TableName, RowKey, StampId)`; tombstone records which row was retired.
- `docs/architecture.md:533-535` — replace the "Residual — removal does not yet stick
  for owner-only ids" paragraph with the new rule (consent-seat once ever AND never after
  any removal of the id); keep the re-join-is-owner-gated sentence in the 534 paragraph.
- Check `docs/STATUS.md:237-243` (DeviceToken registry: Revocation as stamp retirement)
  still reads true — expected no edit.
- Validate, in `packages/cadre-core`:
  `yarn vitest run test/control-revocation-replay.spec.ts test/control-schema-drift.spec.ts
  test/control-authorization-domain-separation.spec.ts
  test/control-ownerkey-self-authorization.spec.ts test/control-authorization-binding.spec.ts
  test/seed-bootstrap.spec.ts test/device-token-registry.spec.ts 2>&1 | tee /tmp/rev.log`,
  then the whole `@serfab/cadre-core` suite, then `yarn typecheck` + `yarn lint` at root.
  Integration tests build against `dist` — `yarn build` first if running those.
- Then write the review/ handoff ticket (honest about gaps) and delete this one.
