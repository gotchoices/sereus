description: Two strangers can seize complete control of a private group in a single step by vouching for each other at the same moment, then kicking out everyone who was legitimately in charge.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

# Mutual self-promotion: two keys can appoint each other and take over a closed strand

## What is wrong

A closed strand's administrators are the rows of the `Strand.Manager` table. The rule the
schema tries to enforce is *"a new manager must be signed for by a different manager that
already exists"* — the `Authorized` constraint's third branch:

```sql
or exists (
    select 1 from Manager A
        where A.MemberKey = context.ManagerKey
            and A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)
            and verify(digest(coalesce(new.MemberKey, old.MemberKey)), context.Signature, A.MemberKey, 'ed25519')
)
```

That constraint is **deferred**: it contains subqueries, so the engine evaluates it once at
commit, against the rows as they will stand *after* the transaction. The `<>` excludes the
row being inserted from vouching for itself — but it excludes only *that one row*, not the
other rows inserted alongside it.

So two keys inserted in the **same transaction**, each signing the other's key, both pass:
at commit time each one is already sitting in `Manager`, so each is the other's
"pre-existing" manager. Neither ever had any prior relationship to the strand.

Worse, the same transaction can go on to delete the real managers. By the time the deferred
check runs, the two attacker rows are managers in the post-image, so their signatures
authorize the deletions, and `MinOneManager` is satisfied because they themselves are the
two surviving rows.

## Reproduction (measured, not theoretical)

Against a real closed strand DB in bootstrap mode (`connectToStrand` + `MemoryRawStorage`,
the same path the component specs use), founder bootstrapped normally:

```
begin
  insert Manager(X)  with context ManagerKey = Y, Signature = sign(digest(X), Y_private)
  insert Manager(Y)  with context ManagerKey = X, Signature = sign(digest(Y), X_private)
  delete Manager where MemberKey = founder
                     with context ManagerKey = X, Signature = sign(digest(founder), X_private)
commit
```

Result: **commit succeeds.** `Manager` afterwards holds exactly `X` and `Y`; the founder is
gone. `X` and `Y` are freshly generated keypairs with no `Member` row and no prior
connection to the strand.

The two-insert form on its own (without the delete) also succeeds, leaving three managers.

The control: the *same* insert issued as a lone statement — `insert Manager(X)` signed by
a `Y` that is not a manager — is correctly rejected with
`ConstraintError: CHECK constraint failed: Authorized`. The hole is specifically the
same-transaction window.

## Why this matters

Managers are the whole access-control story for a closed strand. Every admit path — issuing
an invite, adding a member directly, promoting a manager — requires the writer to hold a
`Manager` row. A party that manufactures two manager rows can admit anyone, evict everyone,
and issue invites. All the other rules recently added (`MinOneManager`, `NoUpdate`, the
insert-gated bootstrap branch, the `<>` self-promotion guard) are intact and correct; they
simply all rest on "the authorizer already existed", which this defeats.

Reachability depends on who can submit a transaction against the strand DB. The schema
constraints are the enforcement boundary — there is no separate gate in front of DML — so
this should be treated as reachable by anything that can write to the strand.

## What needs to be worked out

The core difficulty is that a `CHECK` expression can only see the **post-image**. There is
no way, from inside the constraint, to ask "did this authorizer row exist *before* this
transaction?" — which is exactly the question the rule needs answered. The `<>` trick works
for the single-row case only because the one excluded key is nameable from `new`/`old`.

Directions worth evaluating (none validated yet):

- **Limit `Manager` mutations to one row per transaction.** Mutual promotion strictly
  requires two inserts in one transaction — sequential transactions are already rejected
  (the control case above). If the engine can express or enforce a per-transaction
  single-row rule for a table, the hole closes without changing the authorization model.
  Needs research into whether Quereus can express this at all, or whether it belongs in the
  optimystic transaction validator rather than the schema.
- **Chain each manager row back to the founder** — e.g. record the authorizing key on the
  row and require an acyclic chain rooted at the founding manager. A mutually-signed pair
  forms a cycle with no root, so it would be rejected. Costs a schema column and a
  recursive reachability check the engine may not support.
- **Move the authorization decision out of the deferred `CHECK`** into whatever layer can
  see pre-transaction state (the transaction validator).

Whichever direction is taken, the fix must not break the paths already pinned by tests:
founder bootstrap (Header → Member → Manager), a manager promoting another key, a manager
removing another manager, self-resignation, the min-one-manager floor, the `NoUpdate` rule,
and the rejection of a same-transaction sole-manager swap.

## Expected behavior once fixed

- Two keys signing each other's promotion in one transaction: **rejected**, whether or not
  the transaction also removes existing managers.
- N keys forming a longer mutual-vouching ring in one transaction: **rejected**.
- Everything currently accepted stays accepted (see the list above).

Add regression coverage alongside the existing rotation specs in
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`, which already has the
`openStrand` / `freshKeyPair` / `addExtraManagers` / `tableCount` helpers and the
same-transaction swap test to model the shape on.

## Related

- The same self-authorization family in the control schema is `bug-control-ownerkey-self-authorization`
  (already in `fix/`). Whatever mechanism closes this one should be checked against
  `CadreControl`'s owner-key branch too — if two owner keys can mutually authorize in one
  transaction there, it is the same defect in a different table.
- `bug-strand-manager-authority-antireplay` (backlog) — a separate weakness in the same
  signature scheme: one signature over `digest(X)` authorizes both adding X and removing X.
- The current state, including this gap, is documented in
  [`docs/strands.md` → Who May Administer a Closed Strand](../../docs/strands.md) and marked
  with an `OPEN HOLE` comment at the constraint itself in both schema copies.
