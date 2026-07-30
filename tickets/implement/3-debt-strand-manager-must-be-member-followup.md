description: The rule that a group's admin must also be one of its members is now enforced in code, plus a one-step "admit and promote" helper — this ticket finishes the remaining new tests, the other packages' checks, and the documentation updates.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (seatMembers helper + "Manager rotation" / "Manager.Generation ordering" describes), packages/cadre-core/test/strand-founder-bootstrap.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/src/strand-membership-writer.ts (admitManager — already landed), schemas/strand.qsql (Manager.MemberExists — already landed), packages/quereus-plugin-sereus/src/strand-schema.ts (mirror — already landed), packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts (~line 278 OnlyClosed comment), packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts (~324, ~333), docs/strands.md (~163-200, ~241, ~612), docs/architecture.md (addManager bullet in the strand-writers list)
difficulty: medium
----

# Finish `debt-strand-manager-must-be-member`

Phase 1 (schema + writer) and the mechanical half of Phase 2 (repairing the existing
tests) are DONE and green. This ticket is the remainder: the new tests that assert the
correctness payoff, the two out-of-package call sites, and the docs.

The parent ticket `tickets/complete`-bound design rationale is not repeated here; the
settled decisions are restated inline below so this ticket stands alone.

## What already landed (do not redo)

- **`schemas/strand.qsql` + the mirrored `STRAND_SCHEMA` in
  `packages/quereus-plugin-sereus/src/strand-schema.ts`**: `table Manager` gained
  ```sql
  constraint MemberExists check on insert (
      exists (select 1 from Member M where M.Key = new.MemberKey)
  ),
  ```
  with the full comment block (reads the LIVE `Member` table so a same-transaction
  admit-then-promote passes; explicit `on insert` mask; no DELETE counterpart because
  `Member.NotAManager` is the other half; a `NOTE:` recording that two partitioned nodes
  can still converge to a `Manager` row with no `Member` row). The bootstrap branch of
  `Manager.Authorized` keeps its own `exists (… Member …)` and now says in a comment that
  it is belt-and-braces. `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`
  passes (15/15), so the two copies are byte-equivalent.
- **`packages/cadre-core/src/strand-membership-writer.ts`**: `admitManager` +
  `AdmitManagerParams` (composes `addMemberByManager` + `addManager` in one
  `inStrandTransaction`), with the doc comment covering why one transaction, that both
  halves are signed by the same manager under different digests, that the promoting
  manager must be a PRE-transaction manager (so `admitManager` cannot be chained), and
  that it is not insert-if-absent. `addManager`'s doc now says it promotes a key that is
  ALREADY a member and points at `admitManager`; its `@throws` names `MemberExists`.
- **`packages/cadre-core/src/index.ts`**: both exported alongside `addManager` /
  `removeManager`.
- **`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`**: `addExtraManagers`
  collapsed onto `admitManager`; a new `seatMembers(db, founder, ...keys)` helper seats
  plain `Member` rows via `addMemberByManager`; every previously-failing site repaired
  (13 failures → 0). Two negative assertions were TIGHTENED from bare `.rejects.toThrow()`
  to `/Authorized/` now that their targets are real members ("signer is not a manager",
  "signature over the wrong key"). The full-takeover test's comment was corrected: with X
  and Y seated as members, `Revocation.Authorized` no longer fires, so the promotion
  ordering inside `Manager.Authorized` is the sole rejector. **46/46 pass** in that file,
  and the other five cadre-core strand specs
  (`strand-approval-replay`, `strand-membership-invite`, `strand-member-revocation`,
  `strand-membership-writer`, `strand-founder-bootstrap`) were already green with no edits —
  the parent ticket's grep-derived list over-predicted the blast radius.

### Build note for whoever picks this up

`packages/cadre-core`'s vitest `globalSetup` runs a stale-build guard. It demanded both
`yarn workspace @serfab/quereus-plugin-sereus build` (because `strand-schema.ts` changed)
and a build of `@quereus/quereus` in the sibling `C:\projects\quereus` checkout. Both were
run. Any further edit to `strand-schema.ts` needs the plugin rebuilt again before the
cadre-core specs will start.

## Remaining work

### New tests (Phase 2 tail)

Home is the manager-rotation / generation-ordering area of
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` unless noted. Use the
existing `seatMembers` / `admitManager` / `inTransaction` / `fileTombstone` helpers.

- Promotion of a NON-member is rejected at commit, and the `Manager` count is unchanged
  afterward. (`MemberExists` is currently only proven by the tests that had to be
  repaired — there is no test that names it as the expected rejection.) Pin
  `/MemberExists/`.
- `admitManager` seats BOTH rows, and the promoted manager can then — in a LATER
  transaction — do the three things a member-less manager could not: `revokeMember`
  another member, `removeMemberPeer` another member's peer binding, and `removeManager`
  itself (resign). This is the correctness payoff the whole ticket exists for; assert the
  three operations, not merely that two rows exist.
- A rejected `admitManager` (e.g. `byManagerKeyPair` is not a manager) leaves NEITHER a
  `Member` nor a `Manager` row — all-or-nothing.
- `admitManager` cannot be chained: inside ONE explicit `inTransaction`, admit+promote A
  and then have A admit+promote B → rejected, because `Member.Authorized`'s direct-admit
  branch reads `committed.Manager`. Contrast with the already-passing accepted
  same-transaction PROMOTION chain rooted at a pre-existing manager, which must stay
  green.
- Founder bootstrap untouched: `bootstrapFounderMembership` still succeeds (Header →
  Member → Manager, sequential auto-commits so `MemberExists` sees a committed Member),
  and a Manager-FIRST seeding order is still rejected. `strand-founder-bootstrap.spec.ts`
  is the home if not already covered there.
- Delete half of the invariant: a member cannot be un-membered while holding a `Manager`
  row, and a single transaction deleting BOTH rows passes (either statement order).
  Likely already covered in `strand-member-revocation.spec.ts` — confirm, and add an
  explicit assertion if it is only implicit, since it is now the stated other half of
  `MemberExists`.

### Other packages

- `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`: the closed-strand
  cases (~188, ~212) seat `Member 'm1'` first and should pass unchanged. The OPEN-strand
  `OnlyClosed` case (~278) still rejects, but now for two reasons (`OnlyClosed` AND
  `MemberExists`, since the sibling `Member` insert is rejected too) — its comment claims
  the insert "would otherwise satisfy its bootstrap branch", which is now wrong. Fix the
  comment. **This spec has not been run since the schema change** — run
  `yarn workspace @serfab/quereus-plugin-sereus test 2>&1 | tee /tmp/plugin-test.log`.
- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`:
  ~324 promotes the joiner (already a member — expected no change); ~333's negative case
  promotes a fresh key and still rejects, but check whether its assertion names a reason
  and correct it if so. These are real-network scenarios and are NOT agent-runnable inside
  the 10-minute idle-timeout window — update the source and note the deferral in the
  review handoff rather than running them.

### Validation still owed

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` — only the
  six strand specs have been run, not the whole cadre-core suite.
- `yarn workspace @serfab/quereus-plugin-sereus test` — only the drift spec has been run.
- `yarn typecheck` and `yarn lint` — NEITHER has been run against these changes.

### Docs

- `docs/strands.md` ~612 carries an explicit parenthetical: "(The `Manager` table has
  **no** `MemberExists` constraint, so a manager key need not also be a `Member` row —
  tracked as `debt-strand-manager-must-be-member`.)" Delete it; state the enforced rule
  and the `admitManager` writer instead. Also check ~163-200 (the
  managers/administrators section and the Header → Member → Manager bootstrap order) and
  ~241 (the `NotAManager` sentence — pair it with the new insert-side half so the
  invariant reads as total).
- `docs/architecture.md`'s `addManager` bullet in the strand-writers list needs the same
  correction plus an `admitManager` entry.

## Edge cases to keep in mind (unchanged from the parent ticket)

- Same-transaction admit + promote must PASS — `MemberExists` reads the LIVE `Member`
  table. Pin it.
- Open strand (`Type='o'`): rejection of a Manager insert is over-determined
  (`OnlyClosed` + `MemberExists`); do not write a test comment claiming a single reason.
- `MemberExists` is NOT the anti-replay mechanism — `Manager.NotRevoked` plus the
  stamp-bound digests are. Do not describe it as one.
- `MemberPeer` orphans are out of scope: `MemberPeer.MemberExists` stays insert-only and
  peer rows still outlive their member. Do not "fix" that here.
- Cross-node partition convergence is documented as a `NOTE:` on the new constraint, not
  fixed.

## TODO

Phase A — new tests

- Add the six new tests listed under **New tests** above.
- Re-run `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
  (stream it — the strand specs carry 30s timeouts each; never silent-redirect).

Phase B — other packages

- Fix the `OnlyClosed` comment in the plugin e2e spec; run the plugin test suite.
- Update the integration-tests strand-membership scenario source; do NOT run it (idle
  timeout) — note the deferral in the review handoff.

Phase C — validate + docs

- `yarn typecheck` and `yarn lint`.
- Update `docs/strands.md` and `docs/architecture.md`.
