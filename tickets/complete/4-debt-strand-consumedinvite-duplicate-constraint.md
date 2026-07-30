description: One of the invitation tables had the same rule written out twice under two different names, which was harmless but misleading to read. The duplicate is gone and the wording that referenced it is fixed.
files: schemas/strand.qsql (ConsumedInvite table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (consumeInvite doc block), docs/architecture.md, packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: easy
----

# `ConsumedInvite` duplicate constraint removed — complete

`Strand.ConsumedInvite` carried two constraints, `MemberExists` and `MemberValid`, with a
character-for-character identical predicate (`exists (select 1 from Member M where M.Key =
new.MemberKey)`) and an identical operation mask (both bare `check`, i.e. all operations).
`MemberValid` removed; `MemberExists` kept, matching the name every other table in the
schema uses for the same check (`Manager.MemberExists`, `MemberPeer.MemberExists`).

No behavior change — one fewer redundant CHECK evaluated per `ConsumedInvite` write.

## Final state

- `schemas/strand.qsql` — `MemberValid` gone from `ConsumedInvite`.
- `packages/quereus-plugin-sereus/src/strand-schema.ts` — same removal in the embedded
  `STRAND_SCHEMA` (kept byte-equivalent; enforced by `test/strand-schema-drift.spec.ts`).
- `packages/cadre-core/src/strand-membership-writer.ts` — `consumeInvite` doc block names
  only `MemberExists`.
- `docs/architecture.md` — invite → join handshake, `consumeInvite` bullet, same fix.
- `packages/cadre-core/test/strand-membership-invite.spec.ts` — comment-only fix.

## Review findings

### Verified (correctness of the premise)

- **The two constraints really were identical.** Read the `ConsumedInvite` table at
  `schemas/strand.qsql:77-103` directly rather than trusting the handoff: kept
  `MemberExists` (line 81) and removed `MemberValid` had the same predicate *and* the same
  bare `check` form (no `on insert` / `on update` qualifier), so the operation masks
  matched too. The "no behavior change" claim holds; removal cannot alter which writes are
  accepted.
- **No stale references remain.** Repo-wide grep for `MemberValid` outside
  `tickets/`: only `schemas/chat.qsql:27` (a *different* schema's own same-named
  constraint on a different table — unrelated, correctly untouched) and a stale
  `packages/cadre-core/dist/strand-membership-writer.d.ts` build artifact, which is
  regenerated and not source.
- **Docs sweep, not assumed current.** Grepped every `ConsumedInvite` mention across
  `docs/` (architecture.md lines 76, 537, 548, 574, 587-589, 594, 600;
  reference-app-rn.md:622). Only line 587 enumerated the constraint pair, and it is
  correctly updated. No other doc lists `ConsumedInvite`'s constraints, so nothing else
  needed touching.
- **Naming consistency.** `MemberExists` is the schema-wide name for this check
  (strand.qsql lines 81, 303, 378) — the retained name is the consistent one.
- **Scanned for the same defect elsewhere.** Compared every `constraint` line in
  `schemas/strand.qsql` for repeats; the only repeated names are the same constraint
  applied to *different* tables (`OnlyClosed`, `NotRevoked`, `Authorized`, …), which is
  intended. No second duplicate-within-one-table case exists.

### Fixed in this pass (minor)

- `packages/cadre-core/test/strand-membership-invite.spec.ts:466-468` — the edit left
  ungrammatical text: a four-item list ("InviteExists, ValidUsage, NotExpired and
  MemberExists") ending in the singular "passes". Reflowed to "all pass".
- `packages/cadre-core/src/strand-membership-writer.ts:472-473` — deleting `/MemberValid`
  left a ragged short line mid-sentence. Reflowed the wrap point.

### Major findings

None. The change is mechanical, its premise verified above, and it touches no executable
logic.

### Tripwires

None recorded. The one conditional noticed — `ConsumedInvite.MemberExists` is a bare
`check` (all operations) while the sibling `MemberExists` constraints at strand.qsql:303
and :378 are `check on insert` — is moot today (`InsertOnly` already rejects update and
delete on this table) *and* would remain correct if `InsertOnly` were ever relaxed, since
requiring the member row to exist is the desired rule on any operation. Nothing to park.

### Test coverage

No new tests. Removing a CHECK whose predicate is identical to a surviving CHECK on the
same table admits no new input, so there is no behavior a new test case could assert.
Existing suites already cover the `ConsumedInvite` write paths and confirm `MemberExists`
alone still enforces the invariant.

### Validation run (all green, this review pass, after the comment fixes)

- `yarn workspace @serfab/quereus-plugin-sereus build` — clean.
- `packages/quereus-plugin-sereus`: `vitest run test/strand-schema-drift.spec.ts
  test/e2e/strand-schema.e2e.spec.ts` → **21 passed**. The drift spec is exact-match, so
  this is what pins `.qsql` ↔ `STRAND_SCHEMA` equivalence.
- `packages/cadre-core`: build, then `vitest run test/strand-membership-invite.spec.ts
  test/strand-membership-peer-rotation.spec.ts test/strand-member-revocation.spec.ts
  test/strand-approval-replay.spec.ts` → **127 passed**.
- `yarn lint` (repo root) → clean, exit 0.
- No pre-existing failures encountered.
