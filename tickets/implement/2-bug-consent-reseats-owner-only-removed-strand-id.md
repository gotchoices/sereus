description: When a party deletes one of its networks, someone holding an unused invitation can bring that network's entry back by re-creating it under the same name; record the deleted name in the deletion record so no unsigned path can re-create it.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, docs/architecture.md
difficulty: hard
----

# Make a network entry's deletion final against the unsigned (consent) path

## The defect, reproduced

`packages/cadre-core/test/control-revocation-replay.spec.ts` →
`'Strand: RESIDUAL — an id seated ONLY owner-signed, then removed, is still consent-seatable'`
passes at HEAD (verified 2026-07-30, `yarn vitest run test/control-revocation-replay.spec.ts -t "RESIDUAL"`
in `packages/cadre-core`, 1 passed). It asserts the gap: owner seats strand id X signed
(closed, with a member key), owner removes it signed + tombstoned, then a single unbound
invite redemption re-seats X — open and keyless, no signature.

Why: `Strand.AuthorizedInsert`'s consent branch (`schemas/control.qsql`, the `or (...)`
block) authorizes an unsigned insert purely from a `FormationUsage` row naming
`(new.Id, new.StampId)`, and its once-ever guard is `not exists (FormationUsage FU2 where
FU2.StrandId = new.Id and FU2.StrandStampId <> new.StampId)`. An owner-signed seat writes
no `FormationUsage` row, so an id that only ever existed owner-signed leaves nothing behind
when it is deleted, and the guard has nothing to see. The redeeming transaction writes both
the usage row and the strand row; both CHECKs defer, so the branch matches at commit.

`Revocation` — the append-only deletion record — survives, but records only the deleted
row's one-off `StampId`, never its name, so it cannot answer "was this name ever deleted?".

## The fix

Record the removed row's key in the tombstone, and make the consent branch refuse any id
that has ever been tombstoned. The owner-signed branch is a separate `or` arm and is left
untouched, so the re-join route the previous ticket established (owner re-seats signed,
returning party records consent against the live row via a bound invite) still works. The
carve-out the fix ticket anticipated is therefore free: put the new clause **inside the
consent branch**, not in `NotRevoked` (which covers every insert).

`Revocation` gains one column, uniformly for all five guarded tables (not Strand-only:
a nullable column populated by one writer makes the consent check silently depend on
that writer, and every other digest in this schema binds the whole row):

```sql
table Revocation (
    TableName text,             -- 'OwnerKey' | 'CadrePeer' | 'ValidationKey' | 'Strand' | 'DeviceToken'
    RowKey text not null,       -- primary key of the removed row: OwnerKey.Key / ValidationKey.Key /
                                -- CadrePeer.PeerId / DeviceToken.PeerId / Strand.Id
    StampId text,               -- the retired nonce
    primary key (TableName, StampId),
    ...
    constraint Authorized check on insert (
        exists (select 1 from OwnerKey A where A.Key = context.OwnerKey and verify(
            digest('CadreControl.Revocation', 'remove', new.TableName, new.RowKey, new.StampId),
            context.Signature, A.Key, 'ed25519'))
    )
)
```

and the consent branch of `Strand.AuthorizedInsert` gains a final clause:

```sql
and not exists (
    select 1 from Revocation R
        where R.TableName = 'Strand' and R.RowKey = new.Id
)
```

Keep the existing once-ever `FormationUsage` clause as well. With every delete recording
its name it is arguably subsumed (a usage row implies the strand row existed —
`FormationUsage.StrandExists` — and its later removal must file a tombstone —
`Strand.RevocationRecorded`), but it does not depend on `RowKey` being populated
correctly, and the schema's stated style is to state both rather than lean on a sibling
constraint staying as it is.

The primary key stays `(TableName, StampId)`: stamps are unique per row incarnation, the
`NotRevoked` / `RevocationRecorded` lookups are unchanged, and one name may legitimately
carry several tombstones over its life (seat → delete → owner re-seat → delete). Precedent
for the new subquery shape exists — the consent branch already filters `FormationUsage` on
two non-key columns.

## Deliberately NOT done, with reasons (do not "tighten" these later without a new reason)

- **`RowIsGone` is left keyed on the stamp only.** Adding `and not exists (select 1 from
  Strand S where S.Id = new.RowKey)` looks like a free integrity win but breaks under
  out-of-order convergence: peer P removed (tombstone names P, stamp1) then re-admitted
  (stamp2); a node that converges on the re-add first would then reject the tombstone
  insert for stamp1 and never learn that stamp1 is retired. The stamp-only form passes
  there (stamp1 is not live), which is why it is written that way.
- **`RowKey` is not positively bound to the retired row.** The tempting form —
  `exists (select 1 from committed.Strand S where S.Id = new.RowKey and S.StampId =
  new.StampId)`, which would prove the pair existed pre-transaction — rejects any tombstone
  insert replayed in a *later* transaction, which is exactly what the delete-while-alone
  re-issue path in `docs/architecture.md` ("Delete-while-alone durability") plans to do, and
  rejects it outright on a node that never converged on the strand row. So `RowKey` is
  owner-attested, not schema-verified. Consequence to document in the constraint comment: an
  owner can file a tombstone naming an id that never existed and thereby permanently
  foreclose *consent*-seating of that id. That is owner-only, the owner already controls
  invite issuance, and unbound ids are 128 random bytes minted at redemption — no
  escalation, and the same reasoning the existing pre-plant note already uses.
- **Deriving the consent-seated id from the invite** (e.g. requiring `new.Id =
  digest(FU.Token, FU.UseNumber)`) also closes the hole with no schema column, but it makes
  every unbound strand id predictable from the token and changes the formation protocol,
  the id format, and the docs around it. Rejected as far broader than the defect.
- **Requiring a redemption record for every creation** (the fix ticket's second option) —
  rejected: it changes the owner-signed path's shape and its authorization message for no
  gain over the above.
- `schemas/strand.qsql` has its own same-shaped `Strand.Revocation` tombstone table. Out of
  scope here — its guarded tables have no unsigned insert branch of this kind. Do not
  touch it in this ticket.

## Convergence caveat (record as a comment, not a ticket)

The new clause is a write-time CHECK against locally visible rows, so a node that has not
yet converged on the `Revocation` row still accepts the re-seat — the same documented gap
`NotRevoked` and `Strand.StampId`'s note already carry, and it fails in the safe direction
(the tombstone wins after merge for the *stamp*; the resurrected row can coexist). State
this in the branch comment alongside the existing convergence notes rather than filing
anything.

## TODO

**Phase 1 — schema (both copies must stay byte-identical; `control-schema-drift.spec.ts` enforces it)**

- Add `RowKey text not null` to `Revocation` in `schemas/control.qsql` (table at the end of
  the schema) with a column comment naming the per-table key, and bind it into the
  `Authorized` digest between `TableName` and `StampId`.
- Add the `not exists (Revocation R where R.TableName = 'Strand' and R.RowKey = new.Id)`
  clause to the consent branch of `Strand.AuthorizedInsert`.
- Rewrite the `RESIDUAL:` paragraph in that branch's comment (currently
  `schemas/control.qsql:194-198`) into a statement of the new rule: a strand id may be
  consent-seated once ever AND never after any removal of that id, whichever way it was
  seated; note that the owner-signed branch is deliberately unaffected, so re-join stays
  owner-gated. Keep the `RowKey`-is-owner-attested note and the convergence note above.
- Mirror every edit into `packages/cadre-core/src/control-schema.ts` (escape backticks).

**Phase 2 — writers**

- `peer-authorization.ts:revocationDigest(tableName, stampId)` → take `rowKey` and emit
  `taggedDigest('CadreControl.Revocation', 'remove', [tableName, rowKey, stampId])`. Update
  its doc comment.
- `control-database.ts:deleteGuardedRow` (~805/815): sign `[table, keyValue, stampId]` via
  `buildAuthorizationMessage` and insert `(TableName, RowKey, StampId)`. Field order must
  match the schema digest exactly — the two signers (`buildAuthorizationMessage` here,
  `taggedDigest` in `peer-authorization.ts`) must agree.
- `seed-bootstrap.ts:deleteDeviceToken` (~428/439) and `removePeer` (~527/540): pass
  `peerId` as the row key in both the digest and the insert column list.
- Grep for any other `insert into CadreControl.Revocation` outside tests before finishing.

**Phase 3 — tests**

- Flip `control-revocation-replay.spec.ts:823` (`'Strand: RESIDUAL — …'`) to expect
  `expectConstraintFailure(..., 'AuthorizedInsert')` and rename it to state the rule
  (drop "RESIDUAL"); drop the `tickets/backlog/...` pointer from its comment.
- Add coverage in the same file that the tombstone does **not** block the legitimate
  owner-gated re-join of an owner-only id: owner seat → signed removal → owner re-seat
  signed with a fresh stamp succeeds, and a bound invite records consent against it.
- Add an assertion that a tombstone filed by `deleteStrand` carries the strand id in
  `RowKey` (and that a tombstone whose digest omits/misstates `RowKey` is rejected by
  `Revocation.Authorized`).
- Update the raw tombstone helpers so they supply `RowKey` and sign the 3-field digest:
  `control-revocation-replay.spec.ts:318` (`tombstoneStamp`),
  `control-authorization-domain-separation.spec.ts:103`,
  `control-ownerkey-self-authorization.spec.ts:127`; and the `Revocation` reads in
  `control-authorization-binding.spec.ts:102-108`. `seed-bootstrap.spec.ts` only references
  the table in a comment — check it still reads true.

**Phase 4 — docs + validation**

- `docs/architecture.md:41` — `Revocation` row description: the tombstone binds
  `(TableName, RowKey, StampId)` and records which row was retired.
- `docs/architecture.md:533-535` — replace the "Residual — removal does not yet stick for
  owner-only ids" paragraph with the new rule; keep the re-join-is-owner-gated sentence.
- Check `docs/STATUS.md:237-243` still reads true.
- Run in `packages/cadre-core`: `yarn vitest run test/control-revocation-replay.spec.ts
  test/control-schema-drift.spec.ts test/control-authorization-domain-separation.spec.ts
  test/control-ownerkey-self-authorization.spec.ts test/control-authorization-binding.spec.ts
  test/seed-bootstrap.spec.ts test/device-token-registry.spec.ts 2>&1 | tee /tmp/rev.log`,
  then the whole `@serfab/cadre-core` suite, plus `yarn typecheck` and `yarn lint` at the
  root. Integration tests build against `dist`, so `yarn build` before any integration run.
