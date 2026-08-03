description: Split an oversized test file covering two unrelated features (device-peer registration and manager rotation) into two smaller, focused test files.
files: packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, docs/architecture.md, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
----

`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (1,517 lines, `wc -l`)
covered two unrelated features behind one file-header comment: `MemberPeer`
registration/removal (a member binding its own network nodes) and `Manager` rotation
(promote/remove/resign). Its own section markers put the actual split at line 541
("Phase 2: Manager rotation") — 540 lines of `MemberPeer` coverage vs. ~840 of `Manager`
coverage, not an even split but each large enough on its own to warrant its own file.

Split into two files along that exact boundary:

- `strand-membership-peer-registration.spec.ts` — `describe('registerMemberPeer', ...)`
  and `describe('removeMemberPeer', ...)`, plus the two helpers only they use
  (`memberPeerStamp`, `fileTombstone`). 514 lines.
- `strand-membership-manager-rotation.spec.ts` — `describe('addManager', ...)`,
  `describe('admitManager', ...)`, `describe('removeManager', ...)`, and
  `describe('Manager.Generation ordering', ...)`, plus the manager-only helpers
  (`rawInsertFoundingManager`, `managerStamp`, `insertManagerRow`, `managerGeneration`,
  `addExtraManagers`, `seatMembers`). 917 lines.

`fileTombstone` is used by both features (peer-binding revocation and manager
revocation share the same `Strand.Revocation` tombstone helper) and is duplicated
verbatim into both new files rather than promoted into the shared
`strand-spec-helpers.ts` module (landed by `debt-strand-spec-helpers-duplicated`) —
that module holds only strand-bootstrap plumbing (`openStrand`, `tableCount`, etc.),
not per-feature signing helpers, and this ticket's scope was file-count, not helper
placement. Each new file keeps its own copy of the shared imports
(`openStrand`, `tableCount`, `freshKeyPair`, `inTransaction`, and — manager file only —
`openRawStrand`/`insertHeader`/`rawInsertMember`) from `strand-spec-helpers.ts` unchanged.

Two stale references to the old filename were updated to point at the correct new
file: `docs/architecture.md`'s "Manager-removal hazards" section (two mentions) now
cites `strand-membership-manager-rotation.spec.ts`, and
`strand-membership-closed-strand-e2e.integration.ts`'s file-header comment now cites
`strand-membership-peer-registration.spec.ts`. Older, already-`complete/` tickets that
mention the old filename were left alone (they're historical records, not live docs).

Verified: `npx eslint` clean on both new files; `yarn vitest run` on both new files —
2 test files, 52 tests, all passed.

## Review findings

None — mechanical split along an existing structural boundary (the file's own
"Phase 1" / "Phase 2" comments), no logic changed, tests re-verified green post-split.
