----
description: Anyone can currently make themselves an admin of a strand, and anyone can delete its admins — including the last one, which freezes the group forever. Tighten the membership rules so only real admins can add or remove admins, and so the last admin can never be removed.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, docs/strands.md
difficulty: medium
----

# Manager authorization hardening (strand RBAC)

A closed strand's admins are rows in the `Strand.Manager` table. Every way of admitting
someone (issuing an invite, adding a member directly, promoting another admin) requires an
existing `Manager` row, so who is in that table *is* the strand's entire access-control story.

The table's `Authorized` CHECK is currently open in both directions. This was measured, not
inferred — a throwaway spec was run against a real closed strand (bootstrap-mode
`connectToStrand` + `MemoryRawStorage`, the same path the existing rotation spec uses) during
planning, and all three holes below reproduced. The same spec, re-run against the replacement
schema in this ticket, rejected all three while every legitimate path still worked.

## Root cause

Constraints containing subqueries are **deferred**: they are evaluated at COMMIT, against the
POST-mutation row set. Three consequences, all currently exploitable:

1. **Self-promotion.** The "authorized by another existing manager" branch is
   `exists (select 1 from Manager A where A.MemberKey = context.ManagerKey and verify(...))`.
   At commit the row *being inserted* is already in `Manager`, so an arbitrary key that inserts
   **itself** and signs **its own key** matches its own new row. Measured: a stranger with no
   prior relationship to the strand went from `Manager` count 1 → 2, unrejected.
2. **Unsigned delete near the floor.** The bootstrap branch `(select count(1) from Manager) <= 1`
   exists so the FIRST manager can be seated with no prior signer, but it is not restricted to
   inserts — so it is also true for any DELETE that drops the count to ≤ 1. Measured: a stranger
   removed the second-to-last manager (2 → 1) with a signature from an unrelated key.
3. **Last-manager removal.** Same branch, count 0. Measured: a stranger removed the sole
   founding manager (1 → 0). The strand is then permanently frozen — no `addManager`,
   `issueInvite`, or `addMemberByManager` can ever succeed again, because all three require a
   `Manager` row.

There is also a fourth, narrower path that the fix closes: `Manager` has no `NoUpdate`
constraint, and the former-manager branch verifies a signature over `old.MemberKey` only. So an
UPDATE could re-point an existing manager row at an attacker-chosen key while presenting a
signature that only proves the *old* key resigned. No writer issues `Manager` updates, so
forbidding them outright costs nothing.

## Replacement schema (validated)

Apply verbatim, replacing the whole `Manager` table declaration. The body of
`schemas/strand.qsql` and the `STRAND_SCHEMA` constant in
`packages/quereus-plugin-sereus/src/strand-schema.ts` must stay **byte-equivalent** — paste the
identical text in both. `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`
enforces this; run it.

```sql
    -- A manager is a member that can issue invites, authorize members, and rotate managers
    table Manager (
        MemberKey text primary key,
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        -- Rotation is insert + delete only. An update would let a resignation signature
        -- (which proves only that old.MemberKey consented) double as a hand-off: the
        -- former-manager branch would accept re-pointing the row at any new key.
        constraint NoUpdate check on update (false),
        -- A closed strand must never lose its last manager. Every admit path (Invite,
        -- addMemberByManager, addManager) requires an existing Manager row, so an
        -- admin-less strand can never admit anyone again. Deferred (subquery), so the
        -- count it sees is the POST-delete count.
        -- NOTE: this is a per-transaction check against locally visible rows. Two nodes
        -- that concurrently remove different managers can each see a surviving one and
        -- still converge to zero; if partitioned rotation ever becomes a real workflow,
        -- the floor needs a cross-node guard, not a local count.
        constraint MinOneManager check on delete (
            (select count(1) from Manager) >= 1
        ),
        constraint Authorized check on insert, delete (
            -- Bootstrap: the founding manager is seated with no prior signer. Gated to
            -- INSERT (old.MemberKey is null) AND to the founding state — at most one
            -- Member, and this manager IS that member. Deferred checks see post-image
            -- state, so an ungated count test is also true for a DELETE that drops the
            -- count to <= 1, and for the INSERT half of a same-transaction swap of the
            -- sole manager.
            (old.MemberKey is null
                and (select count(1) from Manager) <= 1
                and (select count(1) from Member) <= 1
                and exists (select 1 from Member M where M.Key = new.MemberKey))

                -- or authorized by this former manager (self-resignation)
                or (
                    old.MemberKey is not null
                        and old.MemberKey = context.ManagerKey
                        and verify(digest(old.MemberKey), context.Signature, old.MemberKey, 'ed25519')
                )

                -- or authorized by ANOTHER existing manager. The `<>` is load-bearing:
                -- this subquery runs at commit against the post-insert row set, so
                -- without it the row being inserted is its own authorizer and any key
                -- could self-promote by signing its own key.
                or exists (
                    select 1 from Manager A
                        where A.MemberKey = context.ManagerKey
                            and A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)
                            and verify(digest(coalesce(new.MemberKey, old.MemberKey)), context.Signature, A.MemberKey, 'ed25519')
                )
        )
    ) with context (ManagerKey text null, Signature text null);
```

Confirmed during planning: Quereus parses `<>`, honours `old.MemberKey is null` as an
insert discriminator, and evaluates `check on delete` for both the new `MinOneManager` and the
narrowed `Authorized`. The four existing strand specs (`strand-membership-peer-rotation`,
`strand-founder-bootstrap`, `strand-membership-invite`, `strand-membership-writer`, 56 tests)
all pass unchanged against this schema.

## Behavior after the change

| Operation | Outcome |
|---|---|
| Founder bootstrap (Header → Member → Manager) | allowed (bootstrap branch) |
| Existing manager promotes another key | allowed (other-manager branch) |
| Any key promotes **itself** | rejected |
| Manager removes a different manager, ≥ 1 remains | allowed |
| Manager resigns itself, ≥ 1 other remains | allowed |
| Sole manager resigns | rejected (`MinOneManager`) |
| Stranger removes any manager | rejected (`Authorized`) |
| Any `update` on `Manager` | rejected (`NoUpdate`) |
| Same-transaction delete-sole + insert-successor | rejected — a hand-off must be add-then-remove, in that order |

## Writer doc updates (`strand-membership-writer.ts`)

No behavior change to `addManager` / `removeManager` — only their doc comments, which currently
assert the opposite of the new rules:

- `removeManager`'s "KNOWN SCHEMA HAZARD (not guarded here)" paragraph (~line 648) must be
  replaced: the hazard is now closed by the schema. State instead that the sole manager cannot
  be removed and that a hand-off is add-successor-then-resign, in that order (a same-transaction
  swap is rejected).
- `addManager`'s "Once the founder manager exists, the schema's `count(Manager) <= 1` bootstrap
  shortcut no longer applies" paragraph (~line 588) should note the `<>` self-authorization
  guard — a key can no longer authorize its own promotion.
- `insertFounderManagerIfAbsent` (~line 169) should note the new ordering dependency: the
  bootstrap branch now requires the founding `Member` row to already exist, so the
  Header → Member → Manager order in `bootstrapFounderMembership` is now load-bearing, not
  merely convenient.

## Edge cases & interactions

The reviewer will check these; write them as tests where marked.

- **Bootstrap ordering.** The bootstrap branch requires `exists (select 1 from Member M where
  M.Key = new.MemberKey)`. Grep for every site that seats a `Manager` row (writers, specs,
  fixtures, `packages/integration-tests`) and confirm none inserts a Manager before its Member.
  A Manager-first seeding path is now rejected.
- **Founder restart / re-`addStrand`.** `insertFounderManagerIfAbsent` short-circuits on the
  count guard, so the bootstrap branch is not re-entered. Confirm the existing founder-bootstrap
  spec still covers a second `bootstrapFounderMembership` call.
- **Open strands.** No `Manager` rows ever exist (`OnlyClosed`); `MinOneManager` only fires on
  delete, which cannot happen. Existing open-strand rejection tests must stay green.
- **Non-member managers remain allowed.** Only the *founding* manager must also be a `Member`;
  `addManager` can still promote a key that has no `Member` row, and existing tests
  (`addExtraManagers` uses fresh unrelated keypairs) depend on that. Do not add a blanket
  `MemberExists` to `Manager` — that is tracked separately as
  `debt-strand-manager-must-be-member`.
- **Replicated writes on a joining node.** A second node syncing an existing strand replays
  membership rows. Confirm the new constraints do not reject a legitimate replay (e.g. a strand
  arriving with several managers, or a manager removal replicated from the authorizing node).
  The full two-node e2e for this is in `tickets/.pre-existing-known.md` as blocked on
  `control-db-convergence-optimystic-p2p`; cover what is coverable in-process and say plainly in
  the handoff what could not be exercised.
- **Concurrent removals across nodes** can still drive the count to zero (see the `NOTE:` in the
  schema). Not fixed here — a local count cannot see another node's in-flight delete.
- **Signature reuse across add/remove.** A manager's signature over `digest(X)` authorizes both
  adding X and removing X (same payload, no nonce), so a captured add-authorization can be
  replayed as a removal. Out of scope; tracked as
  `bug-strand-manager-authority-antireplay`. Do not attempt a partial nonce here.

## Tests

Add to `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (extend the existing
`addManager` / `removeManager` describes; reuse `openStrand`, `freshKeyPair`,
`addExtraManagers`, `tableCount`). Every assertion must check BOTH that the call rejects and
that the row set is unchanged.

- `addManager`: a stranger cannot promote **itself** — `addManager({ byManagerKeyPair: attacker,
  newManagerKey: attacker.publicKeyB64 })` rejects; `Manager` count stays 1.
- `removeManager`: the sole manager cannot resign — founder self-removal on a fresh strand
  rejects; the founder row remains.
- `removeManager`: a stranger cannot remove the last manager — rejects; count stays 1.
- `removeManager`: second-to-last removal still requires a valid signature — with 2 managers, a
  stranger-signed removal rejects (count stays 2), and the same removal signed by the other
  manager succeeds (count 1). This is the no-bootstrap-bypass pin.
- `Manager` update is rejected: a raw `update Strand.Manager set MemberKey = <attacker> where
  MemberKey = <founder>` (with a valid founder self-signature as context) rejects and the
  founder row is unchanged.
- Same-transaction swap: on a strand with 2+ members, an explicit transaction that deletes the
  sole manager (validly self-signed) and inserts an unsigned successor rejects at commit;
  `Manager` count stays 1 and still holds the founder.

Validation commands (run from the package, streamed):

```
cd packages/quereus-plugin-sereus && yarn build && yarn vitest run test/strand-schema-drift.spec.ts 2>&1 | tee /tmp/drift.log
cd packages/cadre-core && yarn vitest run test/strand-membership-peer-rotation.spec.ts test/strand-founder-bootstrap.spec.ts test/strand-membership-invite.spec.ts test/strand-membership-writer.spec.ts 2>&1 | tee /tmp/strand.log
```

`quereus-plugin-sereus` must be rebuilt before the cadre-core run — cadre-core's tests import the
plugin's built `dist`, so an unbuilt schema edit silently tests the OLD schema. Also run
`yarn lint` and the package `typecheck`s.

## Docs

`docs/strands.md` has no section on who may administer a strand. Add a short subsection (near
"Closed-Strand Member Key Handling") stating the invariants in plain terms: managers are added
and removed only by other managers; a manager may resign; the last manager can never be removed;
the founding manager is the sole unsigned seat and only in the founding state; and the known
gaps (cross-node concurrent removal, add/remove signature reuse) with their ticket slugs.

## TODO

- Replace the `Manager` table declaration in `schemas/strand.qsql` with the validated block above.
- Mirror the identical text into `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts`.
- Rebuild `quereus-plugin-sereus`; run the drift spec.
- Grep for Manager-seeding sites and confirm none inserts a Manager before its Member.
- Update the `removeManager`, `addManager`, and `insertFounderManagerIfAbsent` doc comments.
- Add the six tests above to `strand-membership-peer-rotation.spec.ts`.
- Run the four strand specs, lint, and typecheck; report anything not covered (notably the
  two-node replay path) honestly in the review handoff.
- Add the manager-administration subsection to `docs/strands.md`.
