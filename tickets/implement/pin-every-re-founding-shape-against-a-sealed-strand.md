----
description: Freezing a private strand's membership is meant to be permanent. We proved one way of trying to undo it gets refused; there are two more ways to try, and neither has ever been aimed at a frozen strand.
prereq:
files: packages/cadre-core/test/strand-seal.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/quereus-plugin-sereus/src/strand-schema.ts, schemas/strand.qsql
difficulty: easy
----

# Re-founding a sealed strand is pinned at exactly one shape

## Why this is worth pinning

`sealStrand` freezes a closed strand's membership permanently, and permanence is the whole
product promise — members accept that no future manager can admit a party who would then read
the strand's entire history. Irreversibility is enforced by one schema clause: the founding
branch of `Manager.Authorized` re-seats a generation-0 manager **only when no `Manager` stamp
has ever been retired into `Strand.Revocation`**.

`strand-seal.spec.ts` proves that with a single attack: *refuses to re-found a SEALED strand
even with one member left*, which re-inserts a generation-0 `Manager` row carrying a **null**
approval context. Its own review recorded the gap:

> **Irreversibility is pinned at one shape.** The re-founding case covers a lone survivor
> re-inserting a generation-0 row with a null context. Other re-founding shapes (a signed
> insert, a non-zero generation) are refused by branches the rotation spec already covers, but
> are not re-pinned against the sealed state specifically.

Those other branches are tested — on a *live* strand. Nothing pins their behaviour when the
`Manager` table is empty and a stamp has been retired, which is a different row of the
constraint's truth table. That is a cheap gap to close and an expensive one to discover later.

## What to add

Extend the existing `describe('Manager.Authorized seal branch', ...)` block (or the
`describe('a sealed strand', ...)` block, whichever reads better beside its neighbours) in
`packages/cadre-core/test/strand-seal.spec.ts`. Reuse the fixtures already in the file —
do not build new helpers, and do not copy `fileTombstone` / `managerStamp` / `seatMember` again
(`debt-hoist-strand-tombstone-helpers` in `backlog/` already tracks that duplication; adding a
sixth copy makes it worse).

Each case seals a strand, then attempts one re-founding shape and asserts the schema rejects it
and the `Manager` table is still empty afterward:

1. **A signed generation-0 insert.** The surviving member signs a proper approval for its own
   `Manager` row rather than presenting a null context. The founding branch is gated to
   `old.MemberKey is null` at `Generation = 0`; confirm a *well-formed* founding attempt is
   refused purely on the retired-stamp condition, not incidentally on a malformed one. This is
   the case that matters most — the null-context version could pass for a rejection that has
   nothing to do with the seal.
2. **A non-zero-generation insert with no authorizer.** Re-seating at `Generation = 1` or
   higher takes the promotion branch, which needs a live manager above it. With the table
   empty there is none. Assert the rejection names the promotion branch's condition, so a
   future change that accidentally lets the founding branch answer for a non-zero generation
   shows up as a changed error rather than a silent pass.
3. **Assert on the constraint, not just on failure.** Each case should show *which* rule
   refused it. A test that only says "this threw" will keep passing after the seal gate is
   removed, because some other clause would still throw.

## Edge cases & interactions

- **Do not weaken an assertion to get green.** If any shape is *accepted*, that is a live
  security defect in an irreversibility guarantee: stop, and file a `fix/` ticket with the
  exact row it seated. Do not adjust the test to match.
- **Open strands are unaffected** — they hold no `Manager` rows at all, and
  `isStrandSealed` already returns false for them. No new coverage needed there.
- **Local transactor is the right level.** These are schema-constraint truths;
  `strand-membership-network-transactor-parity.spec.ts` already carries one seal case over the
  network transactor and does not need three more.
- **Schema stays untouched.** If a case fails, the fix is a ticket, not an edit to
  `schemas/strand.qsql` — and note that file is kept byte-equivalent with `STRAND_SCHEMA` in
  `packages/quereus-plugin-sereus/src/strand-schema.ts`, guarded by
  `strand-schema-drift.spec.ts`. Touching one without the other breaks that guard.

## TODO

- [ ] Add the signed-generation-0 case.
- [ ] Add the non-zero-generation case.
- [ ] Assert the refusing constraint by name in both, and in the existing null-context case if
      it does not already.
- [ ] Run `yarn workspace @serfab/cadre-core test` (expect 1700 passing + 1 pre-existing skip
      before your additions) and `yarn lint`.
