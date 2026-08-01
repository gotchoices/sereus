description: A new automated test checking that a group manager can run administrative actions from a second computer was reviewed, tidied, and strengthened; it cannot be proven green right now because the shared storage layer it depends on is broken outside this project.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md, docs/STATUS.md, tickets/blocked/strand-unique-index-sync-stale-revision.md
difficulty: medium
----

## What landed

The implement stage (`f487e37`) added a fifth test to the closed-strand end-to-end
scenario file: a member seated on the **second** node is promoted to manager by the
founder, and from there every manager writer (`issueInvite`, `addMemberByManager`,
`addManager`, `revokeMember`, the manager arm of `removeMemberPeer`) runs against the
second node's own database, each resolving the founder-authored `Strand.Manager` row
over the network. It covers both flavours of manager-list read the schema uses — the
live `Manager` table and the pre-transaction `committed.Manager` snapshot — and asserts
they agree. A follow-up stage ran it for the first time and reported the platform
failure it hits.

This review pass changed the test file and two docs. No behaviour outside tests changed.

## Review findings

### Checked and clean

- **Writer API shapes** — `addMemberByManager`, `addManager`, `revokeMember`,
  `removeMemberPeer`'s manager branch all match their call sites in
  `packages/cadre-core/src/strand-membership-writer.ts`.
- **Generation arithmetic** — the founder is seated at generation 0 (schema branch,
  `schemas/strand.qsql:411`) and `addManager` seats a successor at authorizer + 1, so
  the test's `toBe(1)` for the founder's promotee and `toBe(2)` for that promotee's own
  promotee are correct, and they pin the strict-ordering rule end-to-end across two
  nodes.
- **Step ordering** — presence gates precede the mutations whose absence they later
  gate, and each quiet-no-op writer (`revokeMember`, `removeMemberPeer`) is preceded by
  a local assertion that its target is visible, so a step that never ran cannot report
  success. Verified against the writers' actual early-return conditions.
- **Rejection floor** — no count or enumeration assertion follows a rejected write.
- **Resource cleanup** — teardown is in `finally`; `for await` closes the row iterator
  on abrupt exit.
- **`docs/strands.md` → "Who May Administer a Closed Strand"** — re-read; it states
  behavioural rules and makes no test-coverage claims, so the implement stage was right
  to skip it. Left alone.

### Fixed in this pass

- **Two scan helpers were byte-identical.** `memberKeys` and the new `inviteKeys`
  differed only in table and column name, and `managerKeys` was a third copy of the same
  loop. Replaced by one `scanColumn(db, table, column)` primitive carrying the
  scan-don't-seek rationale once, with the three named helpers as one-liners over it.
  The table argument is now the same union type `strandCount` already used, rather than
  a bare `string`.
- **A pair-returning helper became a two-scan positional match, briefly.** While
  collapsing the helpers the generation lookup was first written as two separate scans
  matched by array index — which the storage layer never promises to keep aligned.
  Caught before it settled; the shipped `managerGeneration` reads both columns in a
  single scan.
- **Stale count in the file header.** The visibility-vs-replication paragraph was
  updated to "the four database-driven tests" but still closed with "it is what those
  three assert". Now four. The same edit had also left one comment line running well
  past the file's width; reflowed.
- **The joiner-side rejection only tested a stranger.** Step 11 refused an invite
  issuance by a freshly generated key that holds neither a `Member` nor a `Manager` row.
  Nothing in this file — nor in `cadre-core/test/strand-membership-invite.spec.ts`,
  which also uses a fresh key — ever refused a *seated member* who simply is not a
  manager. That is the only case distinguishing `Invite.InviteValid`'s `Manager` lookup
  from a membership check. Added: the member admitted off the second node's invite is
  gated visible on the second node, then refused. The stranger case is kept alongside
  it, since the two fail for different reasons.
- **`docs/architecture.md` pointed at a ticket that no longer exists.** Its
  "End-to-end coverage" section said proving physical replication "is parked as
  `backlog/debt-strand-replication-vs-visibility-proof`" — that ticket was consumed when
  the fourth test landed, and physical replication is now proven by that test. Rewritten
  to point at the fourth test and at the real surviving backlog item
  (`debt-strand-no-backfill-of-pre-membership-blocks`), which is where
  `docs/cadre-consistency.md` already sends readers.
- **`docs/architecture.md` had no paragraph for the fifth test.** Every earlier test in
  this file got one when it landed; this one did not. Added, in the same shape as its
  siblings, including the explicit statement that `removeManager`, `cancelInvite`,
  `admitManager` and `leaveStrand` remain founder-side only.
- **`docs/STATUS.md` claimed the file is "3/3".** Now says five tests, and says plainly
  that four of them are intermittent on the platform fault below.

### Found, deliberately not filed

- **Four of the five tests in this file fail intermittently, including the new one.**
  Every failure is in the sibling `../optimystic` checkout, not in this repo. It is
  already tracked as `blocked/strand-unique-index-sync-stale-revision` and all four test
  names are already listed in `tickets/.pre-existing-known.md` against that slug, so per
  the workflow rules it was not re-reported. This pass is aware of and blocked on it.
- **`removeManager`, `cancelInvite`, `admitManager`, `leaveStrand` have no
  second-node coverage.** Real, but it is the same shape of work the ticket that
  produced this test already did once, and the reads those writers perform are the same
  two flavours the fifth test now covers. Recorded in `docs/architecture.md` as a stated
  limit rather than filed as a ticket, on the grounds that a new coverage ticket for a
  currently-unrunnable suite would sit unworkable behind the platform fault.

### Tripwires (conditional; parked in code, not filed)

- `strand-membership-closed-strand-e2e.integration.ts` — the existing `NOTE:` beside the
  generation assertions is left in place: those assertions pin the *writer's* successor
  policy (authorizer generation + 1), not the schema's, which enforces only strict
  ordering. If `addManager` ever seats successors at some other larger value, relax them
  to `toBeGreaterThan(0)` — nothing would be wrong in that case. Still accurate after
  the helper rewrite.
- No new tripwire was added. Nothing else in the diff was of the "fine now, only matters
  if X later" shape.

### Gates

| gate | result |
| --- | --- |
| `yarn lint` (repo root, full flat config) | **exit 0** |
| `yarn typecheck` (`packages/integration-tests`) | **exit 0** |
| `yarn vitest run … -t "manager promoted on the second node"` | **failed** — `Timeout waiting for founder bootstrap rows replicate to joiner after 15000ms` |
| same command, re-run for a second data point | **could not run** — build guard tripped |

The test failure lands in `bringUpClosedStrand`, before step 1 of the test body, so it
is upstream of every line this pass touched and of every claim the test makes. It is the
repo-wide cross-node strand-replication breakage already recorded under
`strand-unique-index-sync-stale-revision`.

The re-run could not start at all: the freshness guard reported
`@optimystic/db-p2p: dist is stale — src was edited after the last build`. The sibling
repo was being edited by its own runner during this window. Building it was not
attempted — its source is mid-edit, and a build launched into that state could leave a
half-written `dist` in a repository this ticket does not own.

### Honest gaps carried forward

- **Nothing in this pass was observed green at runtime.** Lint and typecheck pass; the
  test did not reach its own body. The two behavioural changes here — the added
  member-not-manager rejection and its enabling visibility gate — are unexecuted. The
  gate is placed after roughly six prior convergence gates, so it should be satisfied on
  its first probe, but that is reasoning, not a measurement.
- The helper collapse is covered by typecheck and by the untouched call site at the
  file's earlier test, not by a green run.
- Whether the intermittent failure is literally the defect in
  `strand-unique-index-sync-stale-revision` or a relative of it is still unsettled; that
  question belongs to the triage of that blocked ticket, and this pass did not reopen it.
