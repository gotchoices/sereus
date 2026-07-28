----
description: Two strangers can seize complete control of a private group in a single step by vouching for each other at the same moment, then kicking out everyone who was legitimately in charge. Close the hole by recording, on each administrator record, how far it sits from the group's founder, and requiring every appointment to come from someone strictly closer.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

# Close same-transaction mutual promotion in `Strand.Manager` with a generation column

## The hole (re-measured this run — it still reproduces)

`Strand.Manager.Authorized`'s existing-manager branch is a deferred CHECK (it contains
subqueries), so it runs once at commit against the rows as they will stand **after** the
transaction. `A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)` stops a row from
vouching for *itself*, but not from vouching for a **sibling row inserted in the same
transaction**.

Reproduced against a real closed strand DB (`connectToStrand` + `MemoryRawStorage`,
bootstrap mode — the same path the component specs use), founder bootstrapped normally:

```
begin
  insert Manager(X)  context ManagerKey = Y, Signature = sign(digest(X), Y_priv)
  insert Manager(Y)  context ManagerKey = X, Signature = sign(digest(Y), X_priv)
  delete Manager where MemberKey = founder
                     context ManagerKey = X, Signature = sign(digest(founder), X_priv)
commit
```

**Commit succeeds.** `Manager` afterwards holds exactly `X` and `Y`; the founder is gone.
`X` and `Y` are fresh keypairs with no `Member` row and no prior relationship to the strand.
The same insert issued as a *lone* statement is correctly rejected with
`CHECK constraint failed: Authorized` — the hole is specifically the same-transaction window.

## The fix: a generation number, validated by prototype

Give `Manager` an integer **`Generation`** column and require that a promotion be signed by a
manager whose generation is **strictly smaller** than the new row's.

- The founding manager is seated at generation `0` (the bootstrap branch, which already
  requires the founding state, additionally requires `new.Generation = 0`).
- Every later manager is seated at `authorizer.Generation + 1`.

**Why this is airtight even though the writer picks the number.** Take any set of `Manager`
rows inserted in one transaction and pick the one with the smallest `Generation`. Its
authorizer must be a `Manager` row with a strictly smaller `Generation`. That authorizer
cannot be another row from the same insert set (it would contradict minimality), so it must
be a row that already existed before the transaction — and it must have actually signed, with
its own private key, the payload naming the new key. A mutual pair (X vouches for Y, Y vouches
for X) needs `X.Generation < Y.Generation` **and** `Y.Generation < X.Generation`; impossible.
The same argument kills a ring of any length, equal generations, and negative generations
(nothing sits below the founder's `0`, so a chain that ducks underneath has no root).

The generation column also **subsumes** the `<>` self-promotion guard (a row's own generation
is never strictly less than itself), but keep the `<>` in place — it is cheap and states the
intent locally.

### Prototype results

A throwaway spec applied the candidate constraint to a standalone `App.Mgr` table through the
**same** real optimystic bootstrap path (`connectToStrand`, `schema:` option) and ran the
attack shapes against it. Measured:

| case | result |
| --- | --- |
| founder at gen 0, then founder→A (gen 1), then A→B (gen 2) | accepted |
| two-key mutual promotion in one txn (gens 5 and 3) | rejected |
| two-key mutual promotion at equal generations | rejected |
| three-key mutual-vouching ring in one txn | rejected |
| ring using generations below the founder's (−1, −2) | rejected |
| a stranger claiming generation 0 once a manager exists | rejected |
| a manager removing a *different* manager (higher gen removing lower) | accepted |
| self-resignation | accepted |
| removing the last manager (min-one floor) | rejected |
| signature over the joined `MemberKey` + `Generation` payload, replayed at a different generation | rejected |
| the same signature used at its own generation | accepted |
| `Generation integer not null`, insert with null | rejected |

Two engine facts confirmed by the prototype and worth not re-deriving: `new.MemberKey || '|'
|| new.Generation` concatenates the integer to its plain decimal spelling (it matches a
JavaScript-side `` `${key}|${gen}` `` payload byte-for-byte), and `integer not null` on an
optimystic-backed strand table behaves as expected.

## Schema shape to land

Both copies of the schema must stay **byte-equivalent** —
`packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` enforces it. Edit
`schemas/strand.qsql` and the `STRAND_SCHEMA` constant in
`packages/quereus-plugin-sereus/src/strand-schema.ts` together.

`Manager` becomes (comments abbreviated here — keep and update the real ones):

```sql
table Manager (
    MemberKey text primary key,
    -- Lineage ordering. The founding manager is generation 0; every later manager is
    -- seated strictly after (greater than) the manager that appointed it. This is what
    -- makes same-transaction mutual promotion impossible: a deferred CHECK can only see
    -- the post-image, so "did my authorizer exist before this transaction?" is not
    -- directly askable — but the minimum-generation row of any inserted set must find
    -- its authorizer among rows of strictly smaller generation, which can only be a
    -- pre-existing one. Generation is NOT a privilege level: a generation-5 manager has
    -- exactly the same powers as a generation-1 manager.
    Generation integer not null,
    constraint OnlyClosed check (exists (select 1 from Header H where H.Type = 'c')),
    constraint NoUpdate check on update (false),
    constraint MinOneManager check on delete ((select count(1) from Manager) >= 1),
    constraint Authorized check on insert, delete (
        -- Bootstrap: the founding manager, seated at generation 0 with no prior signer.
        (old.MemberKey is null
            and new.Generation = 0
            and (select count(1) from Manager) <= 1
            and (select count(1) from Member) <= 1
            and exists (select 1 from Member M where M.Key = new.MemberKey))

            -- or self-resignation (delete side)
            or (old.MemberKey is not null
                and old.MemberKey = context.ManagerKey
                and verify(digest(old.MemberKey), context.Signature, old.MemberKey, 'ed25519'))

            -- or promotion by an EARLIER-generation manager (insert side)
            or (old.MemberKey is null and exists (
                select 1 from Manager A
                    where A.MemberKey = context.ManagerKey
                        and A.MemberKey <> new.MemberKey
                        and A.Generation < new.Generation
                        and verify(digest(new.MemberKey || '|' || new.Generation),
                                   context.Signature, A.MemberKey, 'ed25519')))

            -- or removal by ANOTHER existing manager (delete side)
            or (new.MemberKey is null and exists (
                select 1 from Manager A
                    where A.MemberKey = context.ManagerKey
                        and A.MemberKey <> old.MemberKey
                        and verify(digest(old.MemberKey), context.Signature, A.MemberKey, 'ed25519')))
    )
) with context (ManagerKey text null, Signature text null);
```

Note the branch split: today's single existing-manager branch used
`coalesce(new.MemberKey, old.MemberKey)` to serve insert **and** delete. The insert payload
now carries the generation, so insert and delete need separate branches. **Delete keeps the
old payload** (`digest(old.MemberKey)`) and gains no generation condition — deliberately.
Deletes are already safe once inserts are: every accepting delete branch requires a row that
exists in the post-image, and no attacker row can get there anymore. Adding a generation
condition to deletes would also break a legitimate case the current specs pin (a
later-generation manager removing an earlier-generation one).

Signing the generation is not strictly required for this ticket's threat model (an
unsigned generation gives an attacker no power it did not already have), but it is cheap,
it is validated above, and it incidentally makes the insert payload differ from the delete
payload — a partial down-payment on `bug-strand-manager-authority-antireplay`, which is about
the fact that one signature over `digest(X)` currently authorizes both adding X and removing
X. Do not try to close that ticket here.

## Writer changes (`packages/cadre-core/src/strand-membership-writer.ts`)

- `insertFounderManagerIfAbsent` — insert the founding manager with `Generation = 0`
  (context still null/null; the bootstrap branch takes it).
- `addManager` — read the authorizing manager's generation first:
  `select Generation from Strand.Manager where MemberKey = ?`, then insert at that value + 1
  and sign `` `${newManagerKey}|${generation}` ``.
  **When the lookup finds nothing** (the signer is not a manager at all, or the strand is
  open and has no `Manager` rows), do **not** throw from the writer — fall back to generation
  `1`, issue the insert anyway, and let the schema reject it. Two existing specs depend on
  this: `rejects an add whose signer is not a manager` and `rejects a manager add on an open
  strand` both expect the *constraint* to be the rejector, and the self-promotion spec pins
  the message as `/Authorized/`.
- `removeManager` — unchanged (payload stays `digest(targetManagerKey)`).
- Update the doc comments on `addManager` / `removeManager`, which currently describe the
  `<>`-only guard as the whole self-promotion story.

## Call sites that write `Manager` rows directly in raw SQL

These pass an explicit column list and will fail against a `not null` `Generation` until
updated:

- `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts:299` (wrong-key signature
  binding) and `:536` (the same-transaction sole-manager swap).
- `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts:179` (accepted founder
  bootstrap), `:202` (founder bootstrap before the reject cases), `:267` (rejected manager
  insert on an open strand). Generation `0` is the right value for all three.

## Regression coverage to add

Alongside the existing rotation specs in
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (which already has
`openStrand` / `freshKeyPair` / `addExtraManagers` / `tableCount` and a same-transaction
swap test to model the transaction helper on):

- Two keys signing each other's promotion in one transaction → rejected, `Manager` unchanged.
- The same, plus a delete of the founder in that transaction → rejected, founder still present.
- Three keys forming a mutual-vouching ring in one transaction → rejected.
- A mutual pair at equal generations → rejected.
- A mutual pair using generations below the founder's `0` → rejected.
- A stranger inserting itself at generation `0` on a bootstrapped strand → rejected
  (`/Authorized/`).
- A manager-signed promotion carrying a generation that is *not* the authorizer's + 1 but is
  still greater → accepted, and one that is **less than or equal** to the authorizer's →
  rejected. (Pins that the ordering, not an exact successor value, is what is enforced.)

Everything already pinned must stay green: founder bootstrap (`Header` → `Member` →
`Manager`), a manager promoting another key, a manager removing another manager,
self-resignation, `MinOneManager`, `NoUpdate`, and the same-transaction sole-manager swap
rejection.

## Docs to update (do not add new files)

- [`docs/strands.md`](../../docs/strands.md) → **Who May Administer a Closed Strand**. The
  "Two keys can promote each other in one transaction and take the strand over" bullet in the
  *Known gaps* list goes away. Replace the "must be a *different* manager" invariant with the
  generation rule, in plain terms: *every manager is seated one step further from the founder
  than the manager who appointed it, and an appointment is only valid from someone strictly
  closer to the founder — so two strangers cannot appoint each other, in one transaction or
  otherwise.* Say explicitly that generation is a lineage marker, not a privilege level.
  Leave the two remaining gap bullets (cross-node `MinOneManager`, add/remove signature
  replay) intact.
- [`docs/architecture.md`](../../docs/architecture.md) → the `addManager` / `removeManager`
  writer bullets and the **Manager-removal hazards** paragraph (~lines 549–553), which
  currently ends with "⚠️ **Still open:** two keys that sign *each other's* promotion…".
  Drop that clause and describe the generation rule and the new insert payload; keep the
  concurrent-removal caveat.
- Remove the `OPEN HOLE:` comment block at the constraint in **both** schema copies.

## Related

- `bug-control-ownerkey-self-authorization` (in `fix/`) is the same self-authorization family
  in `CadreControl.OwnerKey`. **Out of scope here** — but that ticket's agent should know the
  generation mechanism above is the validated answer if `OwnerKey` turns out to admit the same
  same-transaction mutual authorization.
- `bug-strand-manager-authority-antireplay` (backlog) — one signature over `digest(X)`
  authorizes both adding and removing X. Partially narrowed by the payload split above; not
  closed.
- `bug-strand-member-delete-unauthorized` (backlog) — `Member` rows have no delete
  authorization. Worth being aware of while working here: the bootstrap branch's
  `count(Member) <= 1` gate is one of the things standing between an attacker and a
  self-seated "founding" manager, and unauthorized member deletion is what could make that
  count reachable. Not a reason to change scope; the manager-delete signature requirement
  independently blocks the takeover today.

## TODO

Phase 1 — schema
- Add `Generation integer not null` to `Manager` and restructure `Authorized` into the four
  branches above, in `schemas/strand.qsql`.
- Mirror byte-for-byte into `STRAND_SCHEMA` in
  `packages/quereus-plugin-sereus/src/strand-schema.ts`; remove the `OPEN HOLE` comment from
  both.
- Run `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` to confirm the mirror.

Phase 2 — writers
- Seat the founding manager at generation 0 in `insertFounderManagerIfAbsent`.
- Look up the authorizer's generation in `addManager`, insert at +1, sign
  `` `${newManagerKey}|${generation}` ``, fall back to generation 1 (no writer-thrown error)
  when the authorizer has no row.
- Refresh the `addManager` / `removeManager` doc comments.

Phase 3 — call sites and coverage
- Add `Generation` to the raw-SQL `Manager` inserts listed above.
- Add the regression tests listed above to `strand-membership-peer-rotation.spec.ts`.

Phase 4 — validate and document
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
- `yarn workspace @serfab/quereus-plugin-sereus test 2>&1 | tee /tmp/plugin-test.log`
- `yarn lint` and the workspace typechecks.
- Update `docs/strands.md` and `docs/architecture.md` as described.
