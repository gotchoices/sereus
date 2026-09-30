description: Five strand test files each kept their own copy of the same few short test helpers; they now share one copy of each in the shared test-helper file.
files: packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-seal.spec.ts
difficulty: easy
----

# One home for the strand signing/lookup test helpers

## What changed

Test-only relocation; no file under `src/` was touched.

`packages/cadre-core/test/strand-spec-helpers.ts` now exports, placed just above `inTransaction`:

- `StampedTable` — `'Member' | 'Manager' | 'MemberPeer'`, the tables whose rows carry a `StampId` that a `Strand.Revocation` row can retire.
- `memberStamp(db, key)`, `managerStamp(db, key)`, `memberPeerStamp(db, memberKey, peerId)` — read the live `StampId` of one row.
- `seatMember(db, founder)` — admit a fresh member and return its keypair.
- `fileTombstoneNamingAnyTable(db, tableName: string, stampId, retiree)` — holds the only copy of the signing vector and the `insert into Strand.Revocation` statement.
- `fileTombstone(db, tableName: StampedTable, stampId, retiree)` — a one-line call to the function above, with the table name restricted to the three real ones. Its doc comment carries the merged explanation from the per-file comments.

The module gained two imports from `../src/strand-membership-writer.js`: `addMemberByManager` and `signStrandApproval`.

Per spec file:

- `strand-approval-replay.spec.ts` — local `memberStamp`, `memberPeerStamp`, `fileTombstone`, `seatMember` removed and imported. `managerRow`, `isMember`, `isManager` stay local. The shared `managerStamp` is deliberately not imported, because a test in this file declares a local `const managerStamp`. The `Ed25519KeyPair` type import became unused and was removed.
- `strand-member-revocation.spec.ts` — local `memberStampId` and `fileTombstone` removed. Every `memberStampId(` call renamed to `memberStamp(`. All eight `fileTombstone(db, stamp, retiree)` calls rewritten to `fileTombstone(db, 'Member', stamp, retiree)`. The one call that passed `'Bogus'` now calls `fileTombstoneNamingAnyTable(db, 'Bogus', generateStrandStampId(), founder)`.
- `strand-membership-peer-registration.spec.ts` — local `memberPeerStamp`, `fileTombstone` removed and imported. The `Database` and `Ed25519KeyPair` type imports became unused and were removed.
- `strand-membership-manager-rotation.spec.ts` — local `managerStamp`, `fileTombstone` removed and imported. `seatMembers` (plural, a different helper) stays.
- `strand-seal.spec.ts` — local `managerStamp`, `fileTombstone`, `seatMember` removed and imported. The local `hasRevocation` parameter is now typed `StampedTable`.

## Validation run (all from the repo root, 2026-09-30)

- `yarn workspace @serfab/cadre-core typecheck` — passed.
- `yarn lint` — passed (after removing the three unused imports it reported).
- `yarn workspace @serfab/cadre-core vitest run` on the five spec files — 5 files, 108 tests passed.
- `grep -n "^async function \(fileTombstone\|memberPeerStamp\|managerStamp\|seatMember\|memberStamp\|memberStampId\)" packages/cadre-core/test/*.spec.ts` prints one line, `seatMembers` in `strand-membership-manager-rotation.spec.ts`. That is a prefix match on the plural helper that the ticket says to keep, not a leftover copy.

No tests were added: the helper bodies moved unchanged, and the existing suites are the check.

## What a reviewer should look at

- **Helper bodies are unchanged.** Compare the new exports against the deleted local copies in the diff. The doc comments on the three stamp readers were unified to one wording ("via unfiltered scan + JS filter (the writer's scan-not-seek idiom)").
- **The `'Bogus'` test** in `strand-member-revocation.spec.ts` ("rejects a tombstone naming a table outside the three guarded ones") still rejects with `/RowIsGone/`; it passed in the run above.
- **Argument order in `strand-member-revocation.spec.ts`.** The old local helper took `(db, stampId, retiree, tableName = 'Member')`. The call sites were rewritten with a line-scoped `sed`; a missed one would fail typecheck, which passed.
- **Merged doc comment on `fileTombstone`.** The per-file comments said slightly different things (one explained the approval-replay pin discipline, two explained that an attacker-signed tombstone fails `Revocation.Authorized`). The merged comment keeps the two general reasons. The approval-replay file's header comment still explains its own pin discipline, so nothing was lost there, but check the merged wording reads correctly.

## Known gaps

- The full cadre-core test suite was not run, only the five affected spec files. Other `strand-*.spec.ts` files import `strand-spec-helpers.ts` and were covered by typecheck and lint but not executed.
- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts` still has its own `memberPeerStamp` and `managerGeneration`. Left alone on purpose: it is a different package with no test-helper module shared with cadre-core.
