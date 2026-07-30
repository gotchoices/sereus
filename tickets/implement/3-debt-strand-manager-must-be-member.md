----
description: A group's admin is supposed to be one of its members, but nothing enforces it — an admin can be promoted from a key that never joined the group. Add the missing rule and a one-step "admit and promote" helper.
files: schemas/strand.qsql (Manager table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA — byte-parity enforced by packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts), packages/cadre-core/src/strand-membership-writer.ts (addManager, addMemberByManager, inStrandTransaction), packages/cadre-core/src/index.ts (writer exports), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/strands.md (lines ~163-200, ~241, ~612), docs/architecture.md (~line 612 equivalent: the addManager bullet)
difficulty: medium
----

# `Strand.Manager` requires a matching `Strand.Member`

## What is wrong today

`schemas/strand.qsql` says "A manager is a member that can issue invites, authorize members,
and rotate managers", but only the FOUNDING manager is checked against the `Member` table (the
bootstrap branch of `Manager.Authorized` carries
`exists (select 1 from Member M where M.Key = new.MemberKey)`). Every later promotion is
unchecked: an existing manager can seat a `Manager` row for a key that has no `Member` row.

That is not an escalation — promoting still needs a valid signature from an existing manager —
but since the single-use-approval work landed it IS a correctness problem. Every delete of a
`Member` / `Manager` / `MemberPeer` row must file a `Strand.Revocation` tombstone in the same
transaction, and `Revocation.Authorized` verifies that tombstone against a **committed
`Member` row**. So a manager with no `Member` row is half-functional: it can add members,
issue invites, and promote managers, but it cannot revoke a member, clear a peer binding, or
resign itself — all three file a tombstone and are rejected. It can be removed by another
manager that IS a member, so the state is recoverable, but a member-less manager can strand
itself in a seat it cannot vacate.

## The decision (settled — do not re-open)

The plan ticket left one question open: reject promotion of a non-member outright, or let the
writer admit-then-promote in one transaction? **Both, split by layer:**

- **Schema rejects.** `Manager` gets a `MemberExists` constraint gated to INSERT. It reads the
  LIVE `Member` table (not `committed.Member`), so it is a deferred check that a
  same-transaction admit satisfies — exactly the idiom `ConsumedInvite.MemberExists` already
  uses. Reading `committed.Member` instead would forbid admit-then-promote for no security
  gain, since the sibling `Member` insert is itself authorized at the same commit and a
  failure rolls the whole transaction back.
- **Writer offers the atomic pair.** A new `admitManager(db, { byManagerKeyPair, newManagerKey })`
  composes `addMemberByManager` + `addManager` inside one `inStrandTransaction`. `addManager`
  stays promotion-only — it takes a key that is already a member, and lets the schema be the
  rejector when it is not (the existing "enforcement is pinned where it lives" convention in
  that function's doc comment).

Tradeoff accepted: two entry points rather than one auto-admitting `addManager`. An
auto-admitting `addManager` would have cut test churn to almost nothing, but a call named
"promote to manager" that silently widens the member set hides the very invariant this ticket
establishes. The explicit pair keeps "who is in the group" a decision a caller makes on purpose.

## Why the invariant becomes total, not just insert-side

`Member.NotAManager` already refuses to un-member a key that still holds a `Manager` row
(deferred, so a single transaction deleting both rows passes). Adding `MemberExists` on the
Manager insert closes the other direction. Together they mean no dangling `Manager` row can
ever be created or left behind — so **no `check on delete` is needed on `Manager`**, and none
should be added.

Local-visibility caveat, same class as the existing `MinOneMember` / `MinOneManager` /
`NotRevoked` notes: `MemberExists` is a per-transaction check against locally visible rows. Two
partitioned nodes — one promoting X, one removing X's `Member` + `Manager` rows — can each pass
locally and merge into a `Manager` row with no `Member` row. State this as a `NOTE:` on the new
constraint; a cross-node guard is out of scope.

## Schema change

In BOTH `schemas/strand.qsql` and the mirrored `STRAND_SCHEMA` in
`packages/quereus-plugin-sereus/src/strand-schema.ts` (the two bodies must stay byte-equivalent —
`packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` fails the build otherwise),
add to `table Manager`:

```sql
    -- A manager IS a member: the table comment has always said so, and since the
    -- single-use-approval work it is load-bearing — Revocation.Authorized verifies a
    -- delete's tombstone against a committed Member row, so a manager with no Member
    -- row cannot revoke, clear a peer binding, or even resign. Reads the LIVE Member
    -- table, not committed.Member, so an admit-then-promote in ONE transaction passes
    -- (the same shape ConsumedInvite.MemberExists allows for the invite join); the
    -- sibling Member insert is authorized at that same commit, so nothing is waived.
    -- Mask is explicit: a bare check defaults to insert|update, and update is
    -- forbidden outright by NoUpdate below. Nothing is needed on DELETE — the other
    -- half of the invariant is Member.NotAManager, which refuses to un-member a key
    -- that still holds a Manager row.
    -- NOTE: a per-transaction check against locally visible rows. Two partitioned nodes
    -- — one promoting X, one removing X's Member and Manager rows — can each pass
    -- locally and converge to a Manager row with no Member row. Same convergence class
    -- as the MinOneMember / MinOneManager / NotRevoked notes; not solved here.
    constraint MemberExists check on insert (
        exists (select 1 from Member M where M.Key = new.MemberKey)
    ),
```

Keep the bootstrap branch's existing `exists (select 1 from Member M where M.Key = new.MemberKey)`
inside `Manager.Authorized`. It is now redundant with `MemberExists`, but it is what makes the
branch's own claim ("at most one Member, and this manager IS that member") readable in place —
add a short comment saying `MemberExists` now enforces it for every insert, so the branch-local
copy is belt-and-braces.

## Writer change

`packages/cadre-core/src/strand-membership-writer.ts`, in the manager-rotation section beside
`addManager`:

```ts
/** Parameters for {@link admitManager} — the same shape as {@link AddManagerParams}. */
export type AdmitManagerParams = AddManagerParams;

export async function admitManager(db: Database, params: AdmitManagerParams): Promise<void> {
  const { byManagerKeyPair, newManagerKey } = params;
  await inStrandTransaction(db, async () => {
    await addMemberByManager(db, { managerKeyPair: byManagerKeyPair, memberKey: newManagerKey });
    await addManager(db, { byManagerKeyPair, newManagerKey });
  });
}
```

Doc comment must cover: why one transaction (`Manager.MemberExists` is deferred, so the pair
lands at one commit and neither row survives a rejection); that both halves are signed by the
SAME manager under different digests (`'Strand.Member','add',…` and
`'Strand.Manager','add',…`), so no new authority is introduced; that the promoting manager must
be a PRE-transaction manager (`Member.Authorized`'s direct-admit branch reads
`committed.Manager`), so `admitManager` cannot be chained off a manager seated in the same
transaction; and that it is NOT insert-if-absent — a repeat call fails on the `Member` primary
key, matching `addMemberByManager`'s unguarded shape. Point `addManager`'s own doc at it
("promotes a key that is ALREADY a member — use `admitManager` to admit and promote atomically").

Export `admitManager` (and `AdmitManagerParams`) from `packages/cadre-core/src/index.ts`
alongside `addManager` / `removeManager`.

## Test surface

`addManager` call sites that promote a fresh keypair with no `Member` row will now fail. Two
mechanical fixes: swap `addManager` → `admitManager`, or add an explicit
`addMemberByManager` line first (prefer the explicit form where the test's POINT is the
promotion branch, so the promoted key's membership is visibly separate from its promotion).

Watch the **rejection-reason pins**. Several negative tests assert `rejects.toThrow(/Authorized/)`.
If the promoted key is not a member, `MemberExists` now fires too and the pin can break — worse,
the test stops proving what it claims. Every attacker key that must REACH `Manager.Authorized`
has to be seated as a `Member` first; that also makes those tests stronger (a real member
trying to self-promote, rather than a stranger).

Sites known to need attention (verify each — the list is from a grep, not an exhaustive read):

- `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` — `addExtraManagers` (line ~603)
  already seats the `Member` first; collapse it to `admitManager`. Then: line ~575 (`climber` is
  already a member — no change), ~665 (`second` is not), ~680/~722/~736 (attacker keys behind
  `/Authorized/` pins), the `insertManagerRow` mutual-promotion / ring tests (~994, ~1015,
  ~1045, ~1059, ~1075, ~1181), the ACCEPT cases at ~1108 (`skipAhead` seated at generation 5)
  and ~1145 (the replayed-signature positive control), and the chains at ~1160/~1243.
- `packages/cadre-core/test/strand-approval-replay.spec.ts` — seven `addManager` sites (~244,
  ~303, ~336, ~345, ~357, ~386, ~396) plus a raw insert at ~325.
- `packages/cadre-core/test/strand-membership-invite.spec.ts` (~528, ~542),
  `packages/cadre-core/test/strand-member-revocation.spec.ts` (~751 — ~700/~719 already seat the
  member), `packages/cadre-core/test/strand-membership-writer.spec.ts` (~243/~258 already seat
  members; confirm only).
- `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts` — the closed-strand cases
  (~188, ~212) already seat `Member 'm1'` first, so they pass unchanged. The OPEN-strand
  `OnlyClosed` case (~278) still rejects, but now for two reasons (`OnlyClosed` AND
  `MemberExists`, since the sibling `Member` insert was also rejected). Update that comment's
  "would otherwise satisfy its bootstrap branch" claim rather than leaving it wrong.
- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
  — ~324 promotes the joiner, who IS a member (no change); ~333's negative case promotes a fresh
  key and still rejects, but check whether its assertion names a reason.

New tests to add (in `strand-membership-peer-rotation.spec.ts`'s manager-rotation describe unless
noted):

- Promotion of a non-member is REJECTED at commit, and the `Manager` count is unchanged
  afterward (the deferred-rejection rollback the sibling specs already guard).
- `admitManager` seats both rows and the promoted manager can immediately (in a LATER
  transaction) do the three things a member-less manager could not: `revokeMember` another
  member, `removeMemberPeer` another member's binding, and `removeManager` itself (resign).
  This is the correctness payoff — assert it, don't just assert the two rows exist.
- A rejected `admitManager` (e.g. signed by a non-manager) leaves NEITHER a `Member` nor a
  `Manager` row — the transaction is all-or-nothing.
- `admitManager` cannot be chained: inside one explicit transaction, seat manager A via
  `admitManager` and then have A `admitManager` B — rejected, because `Member.Authorized`'s
  direct-admit branch reads `committed.Manager`. (Contrast with the existing accepted
  same-transaction PROMOTION chain rooted at a pre-existing manager, which must keep passing.)
- The founder bootstrap path is untouched: `bootstrapFounderMembership` still succeeds
  (Header → Member → Manager, sequential auto-commits), and a Manager-first seeding order is
  still rejected — `packages/cadre-core/test/strand-founder-bootstrap.spec.ts` is the home for
  this if it is not already covered there.
- A member cannot be un-membered while holding a `Manager` row, and the same transaction
  deleting BOTH passes — likely already covered in `strand-member-revocation.spec.ts`; assert
  it explicitly if not, since it is now the delete half of a stated invariant.

## Edge cases & interactions

- **Same-transaction admit + promote** — must PASS (`MemberExists` reads live `Member`). This is
  the case a `committed.Member` reading would have broken; pin it.
- **Founder bootstrap ordering** — Header → Member → Manager, each its own auto-commit. Member is
  committed before the Manager insert, so `MemberExists` passes. Manager-first must still be
  rejected (it already is, by the bootstrap branch's own `exists`).
- **Open strand (`Type='o'`)** — `OnlyClosed` rejects Member and Manager inserts alike;
  `MemberExists` also cannot be satisfied (no members exist). Rejection is over-determined, which
  is fine, but any test comment claiming a single reason must be corrected.
- **Delete direction** — `Member.NotAManager` (deferred) covers it; a transaction deleting Manager
  + Member together passes, either statement order. Confirm no test regresses on ordering.
- **Retired stamps / replay** — a promotion approval is bound to `(MemberKey, Generation, StampId)`,
  and the stamp is retired into `Revocation` on removal, so `Manager.NotRevoked` already kills a
  replay. `MemberExists` adds a second gate on a re-promotion after un-membering, but is not the
  anti-replay mechanism — do not describe it as one.
- **Generation ordering must not regress** — the mutual-promotion / ring / non-adjacent-generation
  tests are the hardening this ticket sits on top of. Seating `Member` rows for those keys must not
  turn any REJECT case into an ACCEPT; re-read each assertion, don't just make it compile.
- **Cross-node partition** — documented as a `NOTE:` on the constraint, not fixed.
- **`MemberPeer` orphans** — unchanged by this ticket. `MemberPeer.MemberExists` is still
  insert-only and peer rows still outlive their member; do not "fix" that here.

## Docs

- `docs/strands.md` line ~612 carries an explicit parenthetical: "(The `Manager` table has **no**
  `MemberExists` constraint, so a manager key need not also be a `Member` row — tracked as
  `debt-strand-manager-must-be-member`.)" — delete it and state the enforced rule plus the
  `admitManager` writer. Also check ~163-200 (the managers/administrators section and the
  Header → Member → Manager bootstrap order) and ~241 (the `NotAManager` sentence — pair it with
  the new insert-side half so the invariant reads as total).
- `docs/architecture.md`'s `addManager` bullet in the strand-writers list needs the same
  correction plus an `admitManager` entry.

## TODO

Phase 1 — schema + writer

- Add the `MemberExists` constraint to `table Manager` in `schemas/strand.qsql`, with the comment
  block above (live-`Member` rationale, insert-only mask, no delete counterpart, partition NOTE).
- Mirror it byte-for-byte into `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts`.
- Annotate the bootstrap branch's now-redundant `exists (… Member …)` as belt-and-braces.
- Add `admitManager` + `AdmitManagerParams` to `strand-membership-writer.ts`; cross-link
  `addManager`'s doc comment.
- Export both from `packages/cadre-core/src/index.ts`.
- Run `yarn workspace @serfab/quereus-plugin-sereus test 2>&1 | tee /tmp/plugin-test.log` — the
  drift spec is the fastest proof the two schema copies still match.

Phase 2 — tests

- Fix every failing `addManager` / raw-`insert into Strand.Manager` site per the list above,
  preferring `admitManager` for setup and an explicit `addMemberByManager` where the promotion
  branch is the subject.
- Re-read every `/Authorized/`-pinned negative assertion: the target key must be a member so the
  pin still names the check the test claims to exercise.
- Add the new tests listed under **Test surface**.
- Collapse `addExtraManagers` onto `admitManager`.

Phase 3 — validate + docs

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` (stream it — the
  strand specs carry 30s timeouts each; never silent-redirect).
- `yarn workspace @serfab/quereus-plugin-sereus test` and `yarn typecheck` + `yarn lint`.
- `packages/integration-tests` real-network scenarios are not agent-runnable in the idle-timeout
  window — update the strand-membership scenario source and note the deferral in the review
  handoff rather than running it.
- Update `docs/strands.md` and `docs/architecture.md` as above.
