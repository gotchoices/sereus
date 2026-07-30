description: One of the invitation tables had the same rule written out twice under two different names, which was harmless but misleading to read.
files: schemas/strand.qsql (ConsumedInvite table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (consumeInvite doc block), docs/architecture.md, packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: easy
----

# `ConsumedInvite` declared the same check twice — fix already applied, needs verification handoff

`Strand.ConsumedInvite` carried two constraints with different names and a
character-for-character identical predicate — both asserted that the member being recorded
already has a `Member` row:

- `MemberExists`
- `MemberValid`

Design was fully resolved during planning (no open questions): drop `MemberValid`, keep
`MemberExists` — it's the clearer name, and the name every other table in this schema uses
for the same "member row must exist" check (`Manager.MemberExists`, `MemberPeer.MemberExists`).
Since the fix is mechanical and unambiguous, the edit was made directly during planning rather
than deferred. This ticket exists so the change still passes through the normal implement →
review pipeline rather than skipping straight to complete.

## Edits already made (verify, don't redo)

- `schemas/strand.qsql` — removed the trailing `MemberValid` constraint on `ConsumedInvite`
  (was directly after `NotCancelled`).
- `packages/quereus-plugin-sereus/src/strand-schema.ts` — identical removal in the embedded
  `STRAND_SCHEMA` mirror (kept in sync so `strand-schema-drift.spec.ts` still passes).
- `packages/cadre-core/src/strand-membership-writer.ts` — `consumeInvite` doc block
  (~line 472) updated from "`MemberExists`/`MemberValid`" to just "`MemberExists`".
- `docs/architecture.md` — the invite → join handshake section's `consumeInvite` bullet
  (~line 587), same wording fix.
- `packages/cadre-core/test/strand-membership-invite.spec.ts` (~line 469) — a test comment
  also named the pair; updated to name only `MemberExists`. Comment-only, no assertion changed.
  Not in the ticket's original `files:` list — found by grepping all `MemberExists|MemberValid`
  occurrences for drift.

## Verification already run (all passed, re-run to confirm on this checkout)

1. `yarn workspace @serfab/quereus-plugin-sereus build` — required, schema source changed and
   `strand-schema.ts` is compiled into `dist`.
2. `packages/quereus-plugin-sereus`: `yarn vitest run test/strand-schema-drift.spec.ts` (15
   passed), `yarn vitest run test/e2e/strand-schema.e2e.spec.ts` (6 passed).
3. `packages/cadre-core`: `yarn vitest run test/strand-membership-invite.spec.ts` (38 passed),
   `yarn vitest run test/strand-membership-peer-rotation.spec.ts
   test/strand-member-revocation.spec.ts test/strand-approval-replay.spec.ts` (89 passed).

No behavior change — both constraints had identical predicate and operation mask (both
unqualified, so both applied to insert and update), so removing one changes nothing at
runtime, only readability and one fewer redundant CHECK evaluation per insert.

## Edge cases & interactions

- **Schema drift guard** — `strand-schema-drift.spec.ts` compares `schemas/strand.qsql`
  against the embedded `STRAND_SCHEMA` in `strand-schema.ts`; both were edited identically,
  confirmed passing.
- **Dist staleness** — `strand-schema.ts` is TypeScript source compiled into
  `@serfab/quereus-plugin-sereus`'s `dist`; downstream packages (`cadre-core` tests) run
  against compiled output, so the build step above is required before their tests reflect
  the schema change. Confirmed via the stale-build guard firing until the rebuild ran.
- **Grep for stray mentions** — searched the whole repo for `MemberExists|MemberValid`
  before finishing; the only remaining `MemberValid` hits are in `schemas/chat.qsql`
  (an unrelated table's own constraint of the same common name — not part of this ticket)
  and historical `tickets/complete/*` files (frozen record of past ticket state, not touched).

## TODO

- Re-run the verification commands above on this checkout to confirm green (should be a
  no-op since the changes are already committed to the working tree).
- Hand off to review/ with the `## Review findings` section per usual.
