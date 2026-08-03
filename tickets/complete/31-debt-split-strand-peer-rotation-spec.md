description: Split an oversized test file covering two unrelated features (device-peer registration and manager rotation) into two smaller, focused test files.
files: packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, docs/architecture.md, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
----

`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` covered two unrelated
features behind one file-header comment: `MemberPeer` registration/removal (a member
binding its own network nodes) and `Manager` rotation (promote/remove/resign). Its own
section markers put the split at line 541 ("Phase 2: Manager rotation") — 540 lines of
`MemberPeer` coverage vs. 841 of `Manager` coverage, not an even split but each large
enough on its own to warrant its own file.

The file measured **1,381 lines** immediately before the split
(`git show 2d65004^:packages/cadre-core/test/strand-membership-peer-rotation.spec.ts | wc -l`).
The 1,517 figure carried in the original backlog ticket — and restated in the implement
handoff — was measured *before* `debt-strand-spec-helpers-duplicated` hoisted this file's
duplicated setup helpers out of it; that hoist removed ~136 lines. Neither number changes
the decision, but the review-stage restatement was stale.

Split into two files along that exact boundary:

- `strand-membership-peer-registration.spec.ts` — `describe('registerMemberPeer', ...)`
  and `describe('removeMemberPeer', ...)`, plus the two helpers only they use
  (`memberPeerStamp`, `fileTombstone`). 514 lines.
- `strand-membership-manager-rotation.spec.ts` — `describe('addManager', ...)`,
  `describe('admitManager', ...)`, `describe('removeManager', ...)`, and
  `describe('Manager.Generation ordering', ...)`, plus the manager-only helpers
  (`rawInsertFoundingManager`, `managerStamp`, `insertManagerRow`, `managerGeneration`,
  `addExtraManagers`, `seatMembers`). 917 lines.

`fileTombstone` is used by both features (peer-binding revocation and manager revocation
share the same `Strand.Revocation` tombstone helper) and is duplicated verbatim into both
new files rather than promoted into the shared `strand-spec-helpers.ts` module — that
module holds only strand-bootstrap plumbing (`openStrand`, `tableCount`, etc.), not
per-feature signing helpers, and this ticket's scope was file-count, not helper placement.
Review filed `debt-hoist-strand-tombstone-helpers` to close that out (see findings below).
Each new file keeps its own copy of the shared imports (`openStrand`, `tableCount`,
`freshKeyPair`, `inTransaction`, and — manager file only —
`openRawStrand`/`insertHeader`/`rawInsertMember`) from `strand-spec-helpers.ts` unchanged.

Two stale references to the old filename were updated to point at the correct new file:
`docs/architecture.md`'s "Manager-removal hazards" section (two mentions) now cites
`strand-membership-manager-rotation.spec.ts`, and
`strand-membership-closed-strand-e2e.integration.ts`'s file-header comment now cites
`strand-membership-peer-registration.spec.ts`. Older, already-`complete/` tickets that
mention the old filename were left alone (they're historical records, not live docs).

## Review findings

### Verification performed

**Nothing was lost or silently rewritten in the split.** Extracted every `describe(`/`it(`
title from the pre-split file and from the two new files concatenated, sorted both, and
diffed: 58 titles each side, identical, zero drift. A full `diff` of the pre-split file
against the two new files concatenated shows *only* header comments, import lists, helper
relocation/duplication, and the reworded `Phase 1 / 1b / 2 / 3` section markers — not one
line inside any test body changed.

**No dead imports either side.** Checked every imported symbol in both new files for at
least one use. The peer file correctly dropped `admitManager`, `removeManager`,
`openRawStrand`, `insertHeader`, `rawInsertMember`; the manager file correctly dropped
`listMemberPeers`. The manager file's retained `registerMemberPeer`/`removeMemberPeer`/
`revokeMember` imports are genuinely used, by the `admitManager` test at line 279 that
proves a newly-admitted manager can exercise real authority — a manager-rotation test that
happens to touch `MemberPeer`, correctly placed.

**No dangling cross-references.** The only "the rejection above" style comments in the peer
file (lines 336, 489) point within their own test. No comment in either file refers to a
test that now lives in the sibling file.

**No stale filename references left in live code or docs.** Repo-wide grep for
`strand-membership-peer-rotation` outside `tickets/complete/` and `tickets/.logs/` returns
one hit, in `packages/integration-tests/dist/` — a build artifact, regenerated on next
build, correctly not hand-edited.

**Gates.** `yarn lint` (repo-wide) exit 0. `yarn typecheck` in `cadre-core` exit 0.
`npx vitest run` on the two new files: 2 files, 52 tests, all passed. Also ran the four
sibling suites that share `strand-spec-helpers.ts` (`strand-approval-replay`,
`strand-member-revocation`, `strand-membership-invite`, `strand-membership-writer`) to
catch any cross-file helper drift: 4 files, 86 tests, all passed. One incidental blocker:
the stale-build guard rejected the first run because the linked `../quereus` workspace's
`dist` was older than its `src`; rebuilt it (`yarn workspace @quereus/quereus build`,
exit 0) and the runs above are post-rebuild. Nothing in this repo caused that staleness.

### Minor — fixed in this pass

The stale **1,517-line** measurement, corrected above to the actual pre-split 1,381 with
the command that produced it and the reason the two differ. Only a documentation
inaccuracy, but it is the number the whole "is a split warranted" argument rests on.

### Major — filed as a ticket

**`tickets/backlog/debt-hoist-strand-tombstone-helpers.md`.** The split created a fourth
verbatim copy of `fileTombstone` (now in `strand-approval-replay.spec.ts`,
`strand-member-revocation.spec.ts`, and both new files) and a second copy of
`memberPeerStamp`. The handoff flagged the duplication as deliberate and out of scope,
which is a defensible call for this ticket — but it leaves a real DRY defect standing, and
the `strand-member-revocation.spec.ts` copy has already drifted to a different parameter
order, which is exactly how duplicated helpers turn into a reading hazard.

Not fixed inline for two reasons. It is not mechanical: `strand-member-revocation.spec.ts`
passes the literal `'Bogus'` as a table name (a negative test), which the closed union type
the other three copies use forbids, so merging the signatures needs a type decision, not a
find-and-replace. And two of the four affected files sit outside this ticket's diff, which
this stage should not be rewriting. Root cause is one site — `strand-spec-helpers.ts` has
no home for per-feature signing helpers — so it is one ticket, not two. Confirmed no open
ticket in `backlog/ fix/ plan/ implement/ review/ blocked/` already claims those paths.

### Conditional concerns (tripwires)

None recorded. The one candidate — `strand-membership-manager-rotation.spec.ts` at 917
lines still being on the large side — is not conditional: it is a single cohesive feature
(promote / admit / remove / resign, plus the `Generation` ordering that gates all four),
its four `describe` blocks all read the same `Strand.Manager` constraints, and there is no
internal boundary to split on the way the pre-split file had one. It should stay one file.
No lint rule caps file length in this repo, so nothing is being suppressed by saying so.

### Test coverage

Deliberately unchanged, and verified unchanged by the title diff above. This ticket moved
code between files and altered no behaviour, so new tests would be scope creep, not rigour.
The coverage that exists — happy path, self-signature rejection, replay across action tags,
same-transaction authority, `NoUpdate`, idempotent re-register/re-remove, open-strand
rejection — was reviewed as it passed through and is genuinely thorough for these writers.
