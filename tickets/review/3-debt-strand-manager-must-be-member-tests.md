description: Tests were added proving that a group's admin must also be one of its members, so the rule cannot silently break in future.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, schemas/strand.qsql
difficulty: medium
----

# Review: tests for `Manager.MemberExists` + `admitManager`

Test-only ticket. No source, no schema, no docs changed — the schema constraint and the
`admitManager` writer landed in the two prior tickets and were already green.
`typecheck`, `lint`, the out-of-package call sites, and the docs belong to
`debt-strand-manager-must-be-member-docs` (sequence 4), which runs next.

## The invariant under test

A `Strand.Manager` row must always have a `Strand.Member` row behind it. Two constraints
hold the two halves:

- **insert half** — `Manager.MemberExists` (`schemas/strand.qsql:379-381`) refuses a
  promotion of a key with no `Member` row. It reads the LIVE `Member` table, so an
  admit-then-promote inside ONE transaction passes.
- **delete half** — `Member.NotAManager` (`schemas/strand.qsql:198-200`) refuses to
  un-member a key that still holds a `Manager` row. It is deferred, so it sees the
  post-image: a transaction deleting BOTH rows passes.

Why it matters: every delete a manager performs files a `Strand.Revocation` tombstone,
and `Revocation.Authorized` verifies the filer against `committed.Member`. A manager with
no `Member` row therefore holds admin rights it can never exercise — it cannot revoke a
member, cannot clear a peer binding, cannot even resign.

## What was added

### `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (46 → 51 tests)

Four new test-local helpers next to `openStrand` — `openRawStrand`, `insertHeader`,
`rawInsertMember`, `rawInsertFoundingManager`. Only the founding-order test uses them.
They duplicate equivalents in `strand-member-revocation.spec.ts`; that duplication is the
existing convention in these specs (each is self-contained — `freshKeyPair`,
`tableCount`, `openStrand`, `fileTombstone`, `inTransaction` are all already duplicated
between them). **Worth a reviewer opinion**: `4-debt-share-transaction-rollback-helper`
in `plan/` is already about consolidating one of these; whether the raw-seed helpers
should join that consolidation is a judgement call this ticket did not make.

In `describe('addManager')`:

- **`rejects promoting a key that holds no Member row (Manager.MemberExists)`** — the
  gap the ticket existed to close. `MemberExists` was previously only proven implicitly.
  Deliberately no `seatMembers` call: the promotion is otherwise well-formed (founder is
  a committed manager at generation 0 signing the add-tagged digest for generation 1), so
  `Authorized` passes and `MemberExists` is the sole rejector — pinned by name.
- **`the founding Manager still needs its Member row first (seeding order survives)`** —
  two strands. The bootstrapped one asserts `bootstrapFounderMembership` still seats
  Member=1/Manager=1 (its sequential auto-commits give `MemberExists` a COMMITTED Member).
  The raw one hand-seeds Header then a founding Manager with no Member: rejected. That
  rejection is **over-determined by design** (`MemberExists` plus the bootstrap branch of
  `Manager.Authorized`, which carries its own belt-and-braces Member-exists test), so only
  `/CHECK constraint failed/` is pinned, not a name. A positive control follows: the same
  founding insert after `rawInsertMember` is accepted.

New `describe('admitManager')`:

- **`seats Member + Manager in ONE transaction, and the new manager can then act`** — the
  correctness payoff. Beyond asserting both rows exist (and generation 1), the promoted
  manager then does, in LATER transactions, the three things a member-less manager could
  not: `revokeMember` another member, `removeMemberPeer` another member's peer binding,
  and `removeManager` itself. Also pins the same-transaction admit+promote ACCEPT (the
  live-`Member` read) and that resigning drops only the `Manager` row.
- **`a rejected admission leaves NEITHER row (all-or-nothing)`** — a stranger with no
  `Manager` row admits+promotes. Rejected by `Member.Authorized` (bootstrap branch off
  because `committed.Member` is 1, no `ConsumedInvite`, no `committed.Manager` for the
  stranger). `MemberExists` is NOT the rejector — the sibling Member insert is live.
  Both counts unchanged.
- **`cannot be chained: a manager admitted in THIS transaction cannot admit the next`** —
  founder admits A, then A admits B, in one explicit `inTransaction`. Rejected, because
  `Member.Authorized`'s direct-admit branch reads `committed.Manager`. Everything rolls
  back, A included. The contrasting ACCEPT — a same-transaction promotion chain rooted at
  a pre-existing manager — is the pre-existing test at the end of the file and stays green.

### `packages/cadre-core/test/strand-member-revocation.spec.ts` (+1 test)

The delete half was already explicitly covered by two pre-existing tests
(`rejects revoking a member that still holds a Manager row (NotAManager)`, pinning the
name, and `accepts resign + revoke in ONE transaction`). Only the "either statement
order" claim was missing, so one test was added:

- **`accepts revoke + resign in one transaction too (statement order is irrelevant)`** —
  the Member delete issued FIRST, while the Manager row is still live. Passes; the
  deferred check sees the post-image either way.

## Validation performed

| command | result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` (WHOLE suite) | 71 files, **1093 passed, 1 skipped** |
| `yarn workspace @serfab/cadre-core run typecheck` | exit 0, silent |

The one skip is `key-store.spec.ts:231`, an `it.skipIf(process.platform === 'win32')`
that predates this ticket. Nothing was skipped, loosened, or disabled here.

## Known gaps — treat the tests as a floor

- **No `lint` run, no plugin suite, no repo-wide `typecheck`.** Split to
  `debt-strand-manager-must-be-member-docs` by the implement ticket. If the reviewer wants
  those green before this closes, they are the next ticket, not a finding here.
- **`MemberExists` is untested on the networked (non-bootstrap) path.** Every test here
  runs `connectToStrand` in `mode: 'bootstrap'` against `MemoryRawStorage`, like the rest
  of these specs. Cross-node behavior is explicitly NOT covered — the schema records a
  `NOTE:` that two partitioned nodes can still converge to a `Manager` row with no
  `Member` row. Same convergence class as the `MinOneManager` / `MinOneMember` notes.
- **The over-determined founding-order rejection is a loose pin.** `/CHECK constraint
  failed/` would also pass if `MemberExists` were deleted and only the `Authorized`
  bootstrap branch remained. That is unavoidable in the founding state (both tests are
  the same predicate); the tight `MemberExists` pin lives in the non-founding test above
  it. A reviewer may judge the loose test not worth its two node bring-ups.
- **`MemberPeer` orphans remain out of scope.** `MemberPeer.MemberExists` is still
  insert-only and peer rows still outlive their member (`schemas/strand.qsql` carries the
  `NOTE:`). Nothing here changes or tests that.
- **`admitManager` is still not insert-if-absent** — a repeat call for an existing member
  fails on the `Member` primary key. Documented on the writer, not covered by a test.
- **The three "can then act" operations are asserted by outcome, not by constraint name.**
  If `Revocation.Authorized` were relaxed, they would still pass. Adding a negative
  (member-less manager attempts a revoke) would need a raw Manager insert that
  `MemberExists` now forbids — i.e. the state is no longer constructible through the
  schema, which is the point.

## Suggested review focus

- Are the two `/Authorized/` pins in the `admitManager` describe truthful? Both halves of
  `admitManager` can reject under that one name, so the pin does not distinguish them.
  The reasoning for which branch fires is in the test comments — verify it.
- Is `describe('admitManager')` placed sensibly (between `addManager` and
  `removeManager`), and does the seeding-order test belong in this spec at all rather than
  in `strand-founder-bootstrap.spec.ts`? That spec drives `StrandInstanceManager` and has
  no `Database`-level helpers, which is why the test landed here instead.
- Whether the four duplicated raw-seed helpers should be hoisted to a shared test util.
