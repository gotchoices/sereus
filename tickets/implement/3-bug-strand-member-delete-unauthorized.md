----
description: Anyone at all can remove members from a private group — including removing everyone, which locks the group's own owner out. Removal needs to require permission, and a removed person must not be able to walk back in.
files: schemas/strand.qsql (Member table, ~lines 93-116), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA, ~lines 104-128), packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/src/strand-member-registry.ts, schemas/control.qsql (OwnerKey — the idiom to copy), packages/cadre-core/src/control-authorization.ts, docs/strands.md
difficulty: hard
----

# Authorize `Strand.Member` removal, and stop revoked members re-admitting themselves

<!-- resume-note -->
## Resume note (THIRD run hit soft token budget — still NO code changes made)

Three prior runs, all discovery/spike only; working tree has zero modifications.
Run 1: discovery. Run 2: Phase 1 spike (passed). Run 3: re-read every touch-point,
resolved two design ambiguities, drafted the exact schema (below), found one more file
needing edits. Next run: START WRITING CODE IMMEDIATELY — no further investigation is
needed; every question below is answered.

### Run 3 additions — design decisions (binding, do not re-derive)

- **INVITE-BRANCH AS LITERALLY WRITTEN IN THE DESIGN SECTION IS WRONG — use this
  corrected clause.** The design says "no `committed.ConsumedInvite` row names
  `new.Key`", but a revoked member's stale committed row names the SAME MemberKey, so
  that clause would also reject a legitimate **fresh** invite for a returning member —
  contradicting the design's own "a fresh invite … passes" and the Phase 4 test. The
  correct rule is "the ConsumedInvite that admits this member must be same-transaction
  fresh", keyed on InviteKey (the PK):

  ```sql
  or (old.Key is null and exists (
      select 1 from ConsumedInvite CI
          where CI.MemberKey = new.Key
              and not exists (select 1 from committed.ConsumedInvite CC where CC.InviteKey = CI.InviteKey)
  ))
  ```

  Stale row: its InviteKey IS committed → excluded. Fresh invite: new (InviteKey,
  MemberKey) row is same-txn, not committed → passes. Single-use is untouched
  (ConsumedInvite PK on InviteKey blocks re-consuming). An attacker cannot mint a
  passing row: `InviteExists` + `ValidUsage` require a real manager-issued Invite and
  its private key.
- **Self-departure branch: one new context field only (`MemberSignature`), no
  `context.MemberKey`.** The design bullet's `old.Key = context.MemberKey` is redundant
  — verify against `old.Key` already pins the signer:

  ```sql
  or (new.Key is null
      and verify(digest('Strand.Member', 'remove', old.Key), context.MemberSignature, old.Key, 'ed25519'))
  ```

  Context list becomes `with context (ManagerKey text null, ManagerSignature text null,
  MemberSignature text null)`. Matches the Phase 2 TODO ("add MemberSignature to the
  with context list" — singular).
- **Bind ALL context fields at every Strand.Member write site** (every existing write in
  the repo binds the full declared list; do not rely on partial binding being allowed).
  Sites needing `MemberSignature = null` added: `strand-membership-writer.ts` lines ~152
  (`insertFounderMemberIfAbsent`), ~396 (`consumeInvite`'s Member insert), ~455
  (`addMemberByManager`); plus the raw inserts in the e2e spec below.
- **EXTRA FILE FOUND — `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`**
  does raw `insert into Strand.Member … with context ManagerKey = null, ManagerSignature
  = null` at lines ~134, ~170, ~196, ~219, ~257, ~302. Add `MemberSignature = null` to
  each. Its assertions survive the semantics change unmodified: first-member inserts are
  auto-commit with committed count 0 (bootstrap branch passes), the unauthorized second
  member at ~219 still rejects (committed count 1, no signature), the open-strand
  rejections are OnlyClosed. Also refresh its two comments citing the old
  `count(Member) <= 1` branch (~line 168, ~194).
- **`strand-member-registry.ts` needs NO changes** — it writes only through
  `consumeInvite`/`addMemberByManager` and reads via `select count(1)`.
- **Manager table is untouched.** Its own bootstrap branch reads live
  `count(1) from Member) <= 1` — leave as is; only the Member table changes.

### Run 3 additions — the target Member table (drop-in, both schema copies)

```sql
    -- A party in the closed strand network
    table Member (
        Key text primary key,
        constraint NoUpdate check on update (false),
        constraint OnlyClosed check on insert, update, delete (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        constraint MinOneMember check on delete (
            (select count(1) from Member) >= 1
        ),
        constraint NotAManager check on delete (
            not exists (select 1 from Manager A where A.MemberKey = old.Key)
        ),
        constraint Authorized check on insert, delete (
            (old.Key is null and (select count(1) from committed.Member) = 0)

                or (old.Key is null and exists (
                    select 1 from committed.Manager A
                        where A.MemberKey = context.ManagerKey
                            and verify(digest('Strand.Member', 'add', new.Key), context.ManagerSignature, A.MemberKey, 'ed25519')
                ))

                or (old.Key is null and exists (
                    select 1 from ConsumedInvite CI
                        where CI.MemberKey = new.Key
                            and not exists (select 1 from committed.ConsumedInvite CC where CC.InviteKey = CI.InviteKey)
                ))

                or (new.Key is null and exists (
                    select 1 from committed.Manager A
                        where A.MemberKey = context.ManagerKey
                            and verify(digest('Strand.Member', 'remove', old.Key), context.ManagerSignature, A.MemberKey, 'ed25519')
                ))

                or (new.Key is null
                    and verify(digest('Strand.Member', 'remove', old.Key), context.MemberSignature, old.Key, 'ed25519'))
        ),
    ) with context (ManagerKey text null, ManagerSignature text null, MemberSignature text null);
```

Add explanatory comments per branch when landing (mirror the tone of
`control.qsql`'s `OwnerKey.Authorized`), carry the `MinOneManager` cross-node NOTE onto
`MinOneMember`, and note on `NotAManager` that it is deferred (post-image), so a single
transaction deleting both the Manager and Member rows passes. Keep both schema copies
byte-identical.

TS signer to add beside `signStrandPayload` (same raw-digest-bytes signing path):

```ts
export type StrandMemberAction = 'add' | 'remove';
export function signStrandMemberAction(action: StrandMemberAction, memberKey: string, privateKeyB64: string): string {
  const hashBytes = digest(['Strand.Member', action, memberKey], 'sha256', 'bytes') as Uint8Array;
  return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}
```

Parity with SQL literal tags is already pinned generically by
`digest-variadic-parity.spec.ts` case (d); an extra case there is optional.

### Prior-run findings (still valid)

- **PHASE 1 SPIKE DONE — PASSED. Skip Phase 1 entirely; build on `committed.*` as designed.**
  A throwaway spec (`packages/cadre-core/test/zz-spike-committed.spec.ts`, since deleted)
  opened a real strand via `connectToStrand({mode:'bootstrap'})` (local transactor,
  MemoryRawStorage) and applied a spike schema table with
  `check on insert, delete ((old.Id is null and (select count(1) from committed.T) = 0) or ...)`.
  All three behaviors confirmed under the LOCAL transactor:
  1. bootstrap insert into empty committed set → accepted;
  2. second insert (committed count 1) → rejected, error message names the constraint
     (`/Boot/` matched, so `rejects.toThrow(/ConstraintName/)` pinning works);
  3. same-transaction wipe-then-seat (delete sole row + insert new row in one explicit
     txn) → rejected at commit, pre-existing row survives rollback.
  Note the spike table was declared via plain `db.exec('declare schema Spike {...} apply
  schema Spike;')` AFTER connectToStrand — same engine, default vtab optimystic/local —
  the same path `composeStrand` step 6 uses for `Strand`. No fallback needed; delete the
  ticket's fallback paragraph consideration when writing the schema.
- **All named files were read; line refs confirmed.** `Member` table: `schemas/strand.qsql`
  lines 93–116; mirrored byte-identically in
  `packages/quereus-plugin-sereus/src/strand-schema.ts` lines 104–127. The two copies are
  currently in sync — keep them so.
- **Payload-collision check done:** `Manager.Authorized`'s delete branch signs bare
  `digest(old.MemberKey)`; the planned `digest('Strand.Member', 'add'|'remove', key)`
  variadic form is disjoint from every existing strand payload (all current ones are
  single joined strings). Safe to add as specified.
- **Test scaffolding to reuse:** `strand-membership-peer-rotation.spec.ts` has
  `openStrand`, `freshKeyPair`, `inTransaction`, `tableCount`, and the
  `rejects.toThrow(/ConstraintName/)` pinning convention. The variadic TS↔SQL parity spec
  (`test/digest-variadic-parity.spec.ts`) case (d) already pins literal-tag parity
  generically; add a strand-member-tagged case there only if the new signer's shape
  differs from `buildAuthorizationMessage` (it shouldn't — model it on
  `controlAuthorizationFields`, sign the raw digest bytes like `signStrandPayload` does).
- **Writer touch-points confirmed:** `index.ts` export block for the membership writer is
  lines ~105–125 of `packages/cadre-core/src/index.ts`. When the bootstrap branch moves to
  `(select count(1) from committed.Member) = 0`, update the now-stale doc comment on
  `insertFounderMemberIfAbsent` (`strand-membership-writer.ts:139-145`), which cites the
  old `count(1) from Member <= 1` branch. `consumeInvite` (Member + ConsumedInvite in one
  txn) passes the new invite-branch clause by construction — the committed snapshot has no
  `ConsumedInvite` row for a genuine join.
- **Docs anchor:** `docs/strands.md` "Who May Administer a Closed Strand" starts at
  line 142; the known-gaps list (lines 182–193) is where the member-revocation subsection's
  cross-references land. The "Closed-Strand Member Key Handling" section referenced by
  Phase 5 is at line 95.
- **Out-of-scope reminder held:** `registerMemberPeer`'s doc block
  (`strand-membership-writer.ts:499-503`) wrongly claims `MemberPeer` deletes are rejected
  (finding 4) — that correction belongs to `strand-memberpeer-revocation-cleanup`, not here.
<!-- /resume-note -->

## Reproduced

A throwaway spec (`packages/cadre-core/test/zz-repro-member-delete.spec.ts`, run against a real
closed strand via `connectToStrand` in bootstrap mode, then deleted) confirmed all of the
following. Re-create these as real tests during implementation — see TODO.

| # | Attempt | Result |
|---|---------|--------|
| 1 | `delete from Strand.Member where Key = <victim>` with `ManagerKey = null, ManagerSignature = null` | **Accepted.** Victim evicted by a party holding no key at all. |
| 2 | `delete from Strand.Member` (no `where`) with null context | **Accepted.** Every member, founder included, evicted in one statement. |
| 3 | Invited member evicted, then re-inserts its own `Member` row with null context | **Accepted.** Unsigned self re-admission. |
| 4 | Evicted member's `MemberPeer` rows after eviction | **Survive.** But a self-signed `delete from Strand.MemberPeer` **succeeds** — contradicting the schema comment and `registerMemberPeer`'s doc, which both claim peer deletes are rejected. |
| 5 | Founder's `Member` row deleted | `Manager` row **survives** — the strand keeps an administrator with no membership. |

## Root cause

The ticket's original premise was that a `Member` delete is "gated by nothing but `OnlyClosed`".
That understates it. Per Quereus (`../quereus/docs/sql-ddl.md` line 303):

> `check (expr)` is enforced on INSERT and UPDATE by default; `check on {insert | update | delete}[,...]` restricts the operations.

`Member.OnlyClosed` is written as a bare `check (...)`, so it carries the default `insert|update`
mask and **never runs on DELETE**. `NoUpdate` is `on update`; `Authorized` is `on insert`. So a
`Strand.Member` DELETE passes through **zero** constraints.

The same default-mask reading explains finding 4: `MemberPeer.MemberExists` is a bare `check`, so
it does not run on delete either — the `new.MemberKey is null on delete` reasoning recorded in the
schema comment and in `registerMemberPeer`'s doc block never gets a chance to fire. Those comments
are wrong and must be corrected (see `strand-memberpeer-revocation-cleanup`).

Finding 3 is a **separate, independently-fixable defect** and the more dangerous one: it makes any
delete gate we add pointless. `Member.Authorized`'s invite branch asks only

```sql
exists (select 1 from ConsumedInvite CI where CI.MemberKey = new.Key)
```

`ConsumedInvite` is insert-only and is never cleaned up, so that row outlives the membership it
admitted. Once a member is removed, its stale `ConsumedInvite` row still satisfies the branch and
the member re-inserts itself with no signature from anybody. **Both defects must land together** —
fixing removal without fixing re-admission ships a revocation that any revoked party can undo.

## Impact

`Strand.Member` is the read gate for a closed strand: `StrandMemberRegistry.isMember`
(`packages/cadre-core/src/strand-member-registry.ts:164`) resolves authorization by a
`select ... from Strand.Member where Key = ?`. So an unauthorized delete strips a party's access,
and a bare `delete from Strand.Member` is a total denial of service against the strand — an
admin-less, member-less strand can never re-admit anyone. Constraint context values travel with a
write to the strand's peers, so this needs no privileged network position.

## Design

Adopt the shape `schemas/control.qsql`'s `OwnerKey` table already uses (read it before starting —
it is the reference implementation of every idea below), narrowed to what `Member` needs.

### 1. `Member.Authorized` covers DELETE, and every authorizer is read pre-transaction

Change the constraint to `check on insert, delete (...)` and resolve authorizers from
`committed.Manager` rather than `Manager`. `committed.*` is the pre-transaction snapshot; it states
directly that the authorizer must have existed **before** this transaction, so a manager seated in
the same transaction cannot authorize a removal. This is strictly simpler than the generation
ordering `Manager.Authorized` uses, and does not disturb it.

**Verify `committed.*` resolves inside `declare schema Strand { ... }` before building on it.** It is
proven in `CadreControl`, but the strand schema has never used it and the strand runs the same
engine through a different composition path (`composeStrand`). Spike this first. If it does not
resolve, fall back to gating each branch on `old.Key is null` / `new.Key is null` plus explicit
post-image reasoning, and record the divergence in the ticket handoff.

Branches:

- **Founding member** — insert only, and only when the pre-transaction member set is empty:
  `old.Key is null and (select count(1) from committed.Member) = 0`. Gating on the *committed*
  count (not the post-image `count(1) from Member <= 1` the current schema uses) is load-bearing:
  the existing ungated form is also true of a DELETE that drops the count to zero, and of the
  insert half of a same-transaction wipe-then-seat-self. Mirrors `OwnerKey`'s bootstrap branch.
- **Direct manager add** — `old.Key is null` and a `committed.Manager` row matching
  `context.ManagerKey` signed the add-tagged digest over `new.Key`.
- **Invite add** — `old.Key is null`, a `ConsumedInvite` row names `new.Key`, **and no
  `committed.ConsumedInvite` row does**. The second clause is the fix for finding 3: `consumeInvite`
  inserts `Member` + `ConsumedInvite` in one transaction, so the committed snapshot has no such row
  and a genuine join passes; a revoked member's stale row *is* committed, so re-admission fails.
  Single-use is untouched — `ConsumedInvite` rows are never deleted. Re-admission after revocation
  is still possible, but only through a manager action: `addMemberByManager`, or a **fresh** invite
  (new invite key → new `ConsumedInvite` row → passes).
- **Manager-authorized removal** — `new.Key is null` and a `committed.Manager` row matching
  `context.ManagerKey` signed the **remove**-tagged digest over `old.Key`.
- **Self-departure (leaving)** — `new.Key is null`, `old.Key = context.MemberKey`, and `old.Key`
  signed the remove-tagged digest over itself. Needs a new `MemberSignature` context field.
  Mirrors manager self-resignation. If the team would rather members not leave unilaterally, drop
  this branch — it is the one genuinely optional piece here.

### 2. Domain/action tags on the signed payload

Today `Member` insert signs `digest(new.Key)` — a bare key. A delete payload of the same shape
would make an "add X" approval a valid "remove X" approval, the exact defect
`bug-strand-manager-authority-antireplay` describes. So the payloads must be action-scoped from the
start. Use the variadic tagged form `CadreControl` already uses:

```sql
verify(digest('Strand.Member', 'add',    new.Key), context.ManagerSignature, A.MemberKey, 'ed25519')
verify(digest('Strand.Member', 'remove', old.Key), context.ManagerSignature, A.MemberKey, 'ed25519')
```

matched by a new TS signer alongside `signStrandPayload` (model it on
`controlAuthorizationFields` in `packages/cadre-core/src/control-authorization.ts`; variadic-digest
parity between SQL and TS is already pinned by `test/digest-variadic-parity.spec.ts`).

Scope the tag change to `Member` only. `bug-strand-manager-authority-antireplay` (sequence 3.5,
which already lists this ticket as a prereq) will retrofit the remaining tables and add a
single-use stamp; leaving `Member` in the tagged form means that ticket only has to add the stamp
field. Do **not** pre-empt it by adding a nonce here — a partial nonce is worse than none.

### 3. Two floors

- `MinOneMember check on delete ((select count(1) from Member) >= 1)` — mirrors
  `Manager.MinOneManager`. Deferred, so it sees the post-delete count.
- `NotAManager check on delete (not exists (select 1 from Manager A where A.MemberKey = old.Key))`
  — closes finding 5. A member that still holds a `Manager` row must resign first; a single
  transaction that deletes both rows still passes, since the deferred check reads the post-image.
  Note that this is deliberately the *opposite* direction from
  `debt-strand-manager-must-be-member` (which asks whether a manager must be a member on the way
  in) — this only says a member cannot be un-membered while holding admin.

Also fix `OnlyClosed` to `check on insert, update, delete (...)` so the mask is explicit rather
than accidental. Not security-relevant on its own (Header type never changes), but the bare-`check`
default is exactly what caused this bug and should not be left ambiguous anywhere in the table.

The cross-node caveat recorded next to `Manager.MinOneManager` applies verbatim to `MinOneMember`:
it counts locally-visible rows, so two partitioned nodes removing different members can both see a
survivor. Carry the same NOTE comment across rather than restating it.

### 4. Writers

Add to `packages/cadre-core/src/strand-membership-writer.ts`:

- `revokeMember(db, { managerKeyPair, memberKey })` — manager-authorized removal.
- `leaveStrand(db, { memberKeyPair })` — self-departure (only if branch 5 is kept).

Both bind the tagged remove payload. Export from `packages/cadre-core/src/index.ts`.

### Schema mirror

`schemas/strand.qsql` and the embedded `STRAND_SCHEMA` in
`packages/quereus-plugin-sereus/src/strand-schema.ts` must stay byte-equivalent — the file header
says so and `control-schema-drift.spec.ts` shows the drift-test pattern. Edit both.

## TODO

### Phase 1 — de-risk

- ~~Spike whether `committed.<Table>` resolves inside `declare schema Strand { ... }` as applied by
  `composeStrand`.~~ **DONE — passed (see resume note). No fallback needed; use `committed.*`.**

### Phase 2 — schema

- Add the tagged-payload signer to `strand-membership-writer.ts` (variadic digest, mirroring
  `controlAuthorizationFields`).
- Rewrite `Member` in `schemas/strand.qsql`: `Authorized` → `on insert, delete` with the five
  branches above; add `MinOneMember` and `NotAManager`; widen `OnlyClosed`'s mask; add
  `MemberSignature` to the `with context` list; delete the `-- TODO: handle member revocation
  constraint` comment it replaces.
- Mirror byte-for-byte into `packages/quereus-plugin-sereus/src/strand-schema.ts`.

### Phase 3 — writers

- Update `addMemberByManager` to the new add-tagged payload.
- Add `revokeMember` and (if kept) `leaveStrand`; export both from `index.ts`.
- Confirm `bootstrapFounderMembership` and `consumeInvite` still pass under the
  `committed.Member` bootstrap gate and the new invite-branch clause — both are exercised by
  `strand-founder-bootstrap.spec.ts` and `strand-membership-invite.spec.ts`.

### Phase 4 — tests

Extend `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (or a sibling spec) with
the five reproduced attacks, each now asserting rejection, plus:

- stranger-signed removal rejected; unsigned removal rejected; mass `delete from Strand.Member`
  rejected
- manager-signed removal accepted, removing only the targeted row
- self-departure accepted (if kept); another member cannot depart on someone's behalf
- an "add X" signature replayed as "remove X" rejected, and the converse — mirroring the existing
  `an "add X" signature cannot be replayed as "remove X"` test for `Manager`
- revoked invite-member cannot re-insert itself; a manager CAN re-admit it via
  `addMemberByManager`; a **fresh** invite also re-admits it (proves the new clause did not break
  legitimate joins)
- removing the last member rejected (`MinOneMember`)
- removing a member that still holds a `Manager` row rejected (`NotAManager`); the same removal
  succeeds once the manager resigns, including both deletes in one transaction
- a manager seated in the same transaction cannot authorize a removal (the `committed.*` claim)

Pin constraint names in `rejects.toThrow(/.../)` where exactly one constraint can fire, matching
the existing spec's convention.

### Phase 5 — validation + docs

- `yarn build`, `yarn lint`, and the `cadre-core` vitest suite. Stream output with `tee`.
- `docs/strands.md` → "Who May Administer a Closed Strand": add a member-revocation subsection
  stating who may remove a member, that a removed member cannot re-admit itself without a fresh
  manager action, and that a manager must resign before losing membership. Note the residual: a
  revoked member keeps whatever strand data it already replicated — revocation is forward-looking,
  and rotating the read gate still means re-forming the strand (per the existing "Closed-Strand
  Member Key Handling" section).
