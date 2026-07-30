description: The rule that a group's admin must also be one of its members is already enforced in code — this ticket adds the tests that prove the payoff, so the rule cannot silently regress.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/src/strand-membership-writer.ts (admitManager at ~1320, addManager at ~1264 — already landed), schemas/strand.qsql (Manager.MemberExists at 379-381, Member.NotAManager at 198-200 — already landed)
difficulty: medium
----

# New tests for `Manager.MemberExists` + `admitManager`

Phase 1 (schema + writer) and the mechanical half of Phase 2 (repairing the existing
tests) are DONE and green. This ticket is ONLY the new tests. The out-of-package call
sites, the docs, and `typecheck`/`lint` are split into
`debt-strand-manager-must-be-member-docs`, which runs after this.

## What already landed (do not redo)

- **`schemas/strand.qsql:379-381` + the mirrored `STRAND_SCHEMA` in
  `packages/quereus-plugin-sereus/src/strand-schema.ts`**: `table Manager` gained
  ```sql
  constraint MemberExists check on insert (
      exists (select 1 from Member M where M.Key = new.MemberKey)
  ),
  ```
  with the full comment block at `schemas/strand.qsql:364-378` (reads the LIVE `Member`
  table so a same-transaction admit-then-promote passes; explicit `on insert` mask; no
  DELETE counterpart because `Member.NotAManager` at `schemas/strand.qsql:198-200` is the
  other half; a `NOTE:` recording that two partitioned nodes can still converge to a
  `Manager` row with no `Member` row). The bootstrap branch of `Manager.Authorized`
  (`schemas/strand.qsql:411-415`) keeps its own `exists (… Member …)` and says in a
  comment that it is belt-and-braces.
  `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` passes (15/15), so the
  two copies are byte-equivalent.
- **`packages/cadre-core/src/strand-membership-writer.ts`**: `admitManager` +
  `AdmitManagerParams` at ~1288-1327 (composes `addMemberByManager` + `addManager` in one
  `inStrandTransaction`), with the doc comment covering why one transaction, that both
  halves are signed by the same manager under different digests, that the promoting
  manager must be a PRE-transaction manager (so `admitManager` cannot be chained), and
  that it is not insert-if-absent. `addManager` (~1264) now documents that it promotes a
  key that is ALREADY a member and points at `admitManager`; its `@throws` names
  `MemberExists`.
- **`packages/cadre-core/src/index.ts`**: both exported alongside `addManager` /
  `removeManager`.
- **`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts`**: every
  previously-failing site repaired (13 failures → 0), **46/46 pass**. The other five
  cadre-core strand specs (`strand-approval-replay`, `strand-membership-invite`,
  `strand-member-revocation`, `strand-membership-writer`, `strand-founder-bootstrap`) were
  already green with no edits.

### Helpers that already exist in `strand-membership-peer-rotation.spec.ts`

Use these rather than re-rolling them (line numbers as of this writing):

| helper | line | what it does |
| --- | --- | --- |
| `openStrand(type)` | 78 | real closed/open strand DB in bootstrap mode + founder bootstrap |
| `freshKeyPair()` | 52 | unrelated ed25519 keypair |
| `tableCount(db, table)` | 60 | `Header`/`Member`/`MemberPeer`/`Manager` row count |
| `managerStamp(db, key)` | 111 | live `Manager.StampId` via scan+JS filter |
| `memberPeerStamp(db, k, p)` | 119 | live `MemberPeer.StampId` |
| `fileTombstone(db, table, stamp, retiree)` | 134 | the `Revocation` row a raw delete needs |
| `addExtraManagers(db, founder, n)` | 604 | n managers via `admitManager` |
| `seatMembers(db, founder, ...kps)` | 625 | plain `Member` rows via `addMemberByManager` |
| `inTransaction(db, fn)` | 632 | explicit begin/commit, rollback on failure |
| `insertManagerRow(db, by, key, generation)` | 657 | raw promotion at a CALLER-chosen generation |
| `managerGeneration(db, key)` | 669 | a manager row's `Generation` |

### Build note

`packages/cadre-core`'s vitest `globalSetup` runs a stale-build guard. It demanded both
`yarn workspace @serfab/quereus-plugin-sereus build` (because `strand-schema.ts` changed)
and a build of `@quereus/quereus` in the sibling `C:\projects\quereus` checkout. Both were
run already. Any FURTHER edit to `strand-schema.ts` needs the plugin rebuilt again before
the cadre-core specs will start — this ticket touches no source, so no rebuild is expected.

## The tests to add

Home is the `Manager.Generation ordering` / `addManager` area of
`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` unless noted.

- **Promotion of a NON-member is rejected at commit**, and the `Manager` count is
  unchanged afterward. `MemberExists` is currently only proven implicitly by the repaired
  tests — no test names it as the expected rejection. Pin `/MemberExists/`.
- **`admitManager` seats BOTH rows, and the promoted manager can then act.** In a LATER
  transaction the new manager must do the three things a member-less manager could not:
  `revokeMember` another member, `removeMemberPeer` another member's peer binding, and
  `removeManager` itself (resign). This is the correctness payoff the whole ticket exists
  for — assert the three operations, not merely that two rows exist. (All three file a
  `Revocation` tombstone, and `Revocation.Authorized` verifies the filer against
  `committed.Member`; that is exactly what the old member-less manager failed.)
- **A rejected `admitManager` leaves NEITHER row** — e.g. `byManagerKeyPair` is not a
  manager. All-or-nothing.
- **`admitManager` cannot be chained.** Inside ONE explicit `inTransaction`, admit+promote
  A and then have A admit+promote B → rejected, because `Member.Authorized`'s direct-admit
  branch reads `committed.Manager`. Contrast with the already-passing accepted
  same-transaction PROMOTION chain rooted at a pre-existing manager (spec line ~1217),
  which must stay green.
- **Founder bootstrap untouched.** `bootstrapFounderMembership` still succeeds (Header →
  Member → Manager, sequential auto-commits so `MemberExists` sees a committed Member), and
  a Manager-FIRST seeding order is still rejected. `strand-founder-bootstrap.spec.ts` is
  the home if not already covered there.
- **Delete half of the invariant.** A member cannot be un-membered while holding a
  `Manager` row, and a single transaction deleting BOTH rows passes (either statement
  order). Likely already covered in `strand-member-revocation.spec.ts` — confirm, and add
  an explicit assertion if it is only implicit, since it is now the stated other half of
  `MemberExists`.

## Edge cases to keep in mind

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

- Add the six tests above.
- Re-run `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
  — the WHOLE suite; only the six strand specs have been run so far. Stream it (the strand
  specs carry 30s timeouts each); never silent-redirect.
- Leave `typecheck`, `lint`, the plugin suite, and the docs to
  `debt-strand-manager-must-be-member-docs`.
