----
description: A key may be able to make itself an owner of a party's control database by signing its own record, because the rule that checks "is the signer already an owner" appears to see the record being added as if it were already established. Reproduce, then close it if confirmed.
files: schemas/control.qsql (OwnerKey table, ~lines 4-17), packages/cadre-core/src/control-schema.ts (mirrored CONTROL_SCHEMA), packages/cadre-core/src/control-database.ts (insertOwnerKey ~line 543), packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts
difficulty: medium
----

# Suspected: any key can authorize its own `OwnerKey` insert

An owner key is the top of a party's control-database authority: owner signatures gate strand
creation, peer vouching, and validation keys. `CadreControl.OwnerKey.Authorized` accepts a write
when the signer is already an owner:

```sql
or exists (select 1 from OwnerKey A where A.Key = context.OwnerKey
    and verify(digest(new.Key, new.StampId), context.Signature, A.Key, 'ed25519'))
```

## Why this is suspect

The identical shape in the strand schema (`Strand.Manager.Authorized`) was **measured** to be
self-satisfying during planning of `strand-manager-authorization-hardening`: because a CHECK
containing a subquery is deferred to COMMIT and evaluated against the POST-mutation row set, the
row being inserted is already visible to the subquery, so a key that inserts **itself** and signs
**its own row** matches its own new row and is accepted. A stranger promoted itself to
`Strand.Manager` in a real strand with no prior relationship to it.

`OwnerKey` has the same structure, so the same self-authorization is expected here — but it has
not been reproduced, which is this ticket's first job.

Two related questions to settle in the same pass:

- **Bootstrap branch on delete.** `(select count(1) from OwnerKey) <= 1` is not restricted to
  inserts. If deletes reach this constraint, the branch is true for any delete that drops the
  owner count to ≤ 1 — an unsigned removal of the second-to-last and last owner keys. (In the
  strand schema this was measured to be exactly what happened.)
- **Is there a min-one-owner floor?** A control database with zero owner keys can authorize
  nothing further. Check whether removing the last owner key is possible and whether it should be.

## Severity qualifier — do not overstate

Control-database writes arrive over the party's own control network from its cadre peers, so an
attacker also needs write access to that collection; this is not equivalent to an anonymous
internet-facing write. Establish what an attacker actually needs before framing the fix. Note
that mesh-level write authentication is itself an open item in the optimystic workspace
(`debt-mesh-client-signature-enforcement`), so "the network layer stops it" should be verified,
not assumed.

## Expected behavior

- A key that is not already an owner cannot become one by signing its own row.
- The no-prior-signer bootstrap path stays available for the genuinely first owner key
  (`insertOwnerKey` relies on it).
- Removing owner keys, if permitted at all, requires a signature from a *different* existing
  owner and cannot empty the table.

## Reproduce first

Write a spec that attempts the self-insert against a real control database (mirror the harness in
`control-authorization-binding.spec.ts`). Report the measured result before changing the schema —
if it turns out `OwnerKey` is already safe, say so and close the ticket rather than editing the
constraint.

If it reproduces, the shape of the fix is the one validated for `Strand.Manager`: exclude the row
being written from its own authorizer set (`and A.Key <> coalesce(new.Key, old.Key)`) and gate the
bootstrap branch to inserts (`old.Key is null and ...`). `schemas/control.qsql` and
`CONTROL_SCHEMA` in `packages/cadre-core/src/control-schema.ts` must stay byte-equivalent —
`control-schema-drift.spec.ts` enforces that.

**Also probe same-transaction MUTUAL authorization** (two keys inserted in one transaction, each
signing the other's row): the `<>` exclusion alone does not stop it, because the deferred check
sees sibling rows from the same transaction as "existing" owners. `Strand.Manager` measured
exactly that takeover and closed it (`strand-manager-same-txn-mutual-promotion`, complete) with a
`Generation integer not null` column: the founder sits at generation 0, every later row must be
signed by an authorizer of *strictly smaller* generation, and the generation is part of the signed
payload. The minimum-generation row of any inserted set then cannot be vouched for by a sibling,
which kills mutual pairs and rings of any length — see the `Manager` table in
`schemas/strand.qsql` and the `Manager.Generation ordering` suite in
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` for the validated constraint
shape and attack-shape tests. If `OwnerKey` admits the mutual variant, port that mechanism rather
than inventing a new one.
