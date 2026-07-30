description: One of the invitation tables had the same rule written out twice under two different names, which was harmless but misleading to read.
files: schemas/strand.qsql (ConsumedInvite table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (consumeInvite doc block), docs/architecture.md, packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: easy
----

# `ConsumedInvite` duplicate constraint removed — verified, ready for review

`Strand.ConsumedInvite` had two constraints with different names (`MemberExists`,
`MemberValid`) and a character-for-character identical predicate (both check that the
member being recorded already has a `Member` row). `MemberValid` removed, `MemberExists`
kept — matches naming used by every other table in the schema for the same check
(`Manager.MemberExists`, `MemberPeer.MemberExists`). No behavior change: both constraints
had identical predicate and operation mask, so this is readability + one fewer redundant
CHECK per insert, nothing else.

Design resolved during planning stage (see git log `4b966b9`), edits landed there. This
implement pass re-verified the edits on a clean checkout rather than redoing them.

## What changed

- `schemas/strand.qsql` — `ConsumedInvite`'s trailing `MemberValid` constraint (was right
  after `NotCancelled`) removed.
- `packages/quereus-plugin-sereus/src/strand-schema.ts` — identical removal in the embedded
  `STRAND_SCHEMA` string (kept byte-for-byte in sync with the `.qsql` file; drift test
  enforces this).
- `packages/cadre-core/src/strand-membership-writer.ts` — `consumeInvite` doc comment
  (~line 472) updated to name only `MemberExists`.
- `docs/architecture.md` — invite → join handshake section, `consumeInvite` bullet
  (~line 587), same wording fix.
- `packages/cadre-core/test/strand-membership-invite.spec.ts` (~line 469) — comment-only
  fix, no assertion changed.

## Verification performed this pass (all green on current checkout)

1. `yarn workspace @serfab/quereus-plugin-sereus build` — clean build (schema source is
   compiled into `dist`, needed before downstream package tests see the change).
2. `packages/quereus-plugin-sereus`: `yarn vitest run test/strand-schema-drift.spec.ts
   test/e2e/strand-schema.e2e.spec.ts` → **21 passed** (15 drift + 6 e2e).
3. `packages/cadre-core`: `yarn vitest run test/strand-membership-invite.spec.ts
   test/strand-membership-peer-rotation.spec.ts test/strand-member-revocation.spec.ts
   test/strand-approval-replay.spec.ts` → **127 passed** (38 invite + 89 rotation/
   revocation/replay).
4. Repo-wide grep for `MemberValid|MemberExists` — confirmed no stray reference to the
   removed constraint anywhere in `schemas/`, `packages/`, or `docs/`. Remaining
   `MemberValid` hits are `schemas/chat.qsql` (a different table's own same-named
   constraint — unrelated) and frozen `tickets/complete/*` history — neither in scope.

## What review should focus on

- This is a mechanical dedup with no behavior change — the main review question is
  whether the doc/comment wording updates (writer.ts, architecture.md, test comment)
  read correctly in context, not the schema edit itself (that part is verified by the
  drift test, which is exact-match).
- No new test coverage was added or needed — removing a redundant CHECK with an identical
  predicate to another CHECK on the same table can't be exercised by a new test case;
  existing suites already exercise `ConsumedInvite` insert/update paths and confirm
  `MemberExists` alone still enforces the invariant.

## Known gaps

- None identified. Scope was narrow and fully mechanical; no follow-on tickets or
  tripwires warranted.

## Review findings

(none yet — pending review pass)
