description: Five strand test files each kept their own copy of the same few short test helpers; they now share one copy of each in the shared test-helper file.
files: packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-seal.spec.ts
difficulty: easy
----

# One home for the strand signing/lookup test helpers

Test-only relocation; no file under `src/` was touched.

`packages/cadre-core/test/strand-spec-helpers.ts` exports:

- `StampedTable` — `'Member' | 'Manager' | 'MemberPeer'`, the tables whose rows carry a `StampId` that a `Strand.Revocation` row can retire.
- `memberStamp(db, key)`, `managerStamp(db, key)`, `memberPeerStamp(db, memberKey, peerId)` — read the live `StampId` of one row.
- `seatMember(db, founder)` — admit a fresh member and return its keypair.
- `fileTombstoneNamingAnyTable(db, tableName: string, stampId, retiree)` — the only test-side copy of the signing vector and the `insert into Strand.Revocation` statement.
- `fileTombstone(db, tableName: StampedTable, stampId, retiree)` — a one-line call to the function above, with the table name restricted to the three real ones.

The five spec files listed in `files:` import these instead of declaring their own. `strand-approval-replay.spec.ts` deliberately does not import the shared `managerStamp`, because one of its tests declares a local `const managerStamp`. `strand-member-revocation.spec.ts` uses `fileTombstoneNamingAnyTable` for its single test that names a table outside the three real ones.

## Review findings

Reviewed the diff of `ticket(implement): debt-hoist-strand-tombstone-helpers` before reading the handoff.

**Checked**

- Helper bodies against each deleted local copy, statement by statement: the three stamp readers, `seatMember`, and the tombstone insert (signing vector `['Strand.Revocation', 'retire', tableName, stampId]`, SQL text, parameter order) are identical to what was removed. No behaviour change.
- Argument order at every rewritten call in `strand-member-revocation.spec.ts` (old shape `(db, stampId, retiree, tableName = 'Member')`, new shape `(db, 'Member', stampId, retiree)`): all nine calls read correctly in the diff, and a swapped argument would not typecheck because `stampId` is a string and `retiree` a keypair.
- The out-of-range-table test still passes `'Bogus'` and still expects `/RowIsGone/`.
- Leftover duplicates: searched `packages/` for `insert into Strand.Revocation`, the three stamp-reading `select` statements, and the helper function names. Within cadre-core tests the only remaining definitions are in `strand-spec-helpers.ts`.
- Stale comments: the removed doc comments were the only ones that spoke of the helpers being duplicated per file or named this ticket's slug; none remain. The "Live-row readers" section headings left in `strand-approval-replay.spec.ts` and `strand-seal.spec.ts` still head real local helpers (`managerRow`, `hasRevocation`).
- Merged doc comment on `fileTombstone`: reads correctly and keeps both general reasons (pair the tombstone with the delete in one transaction; `Strand.Revocation` has its own `Authorized` constraint). The approval-replay specific sentence it dropped is still covered by that file's header comment.
- Docs: nothing under `docs/`, `AGENTS.md` or the package READMEs mentions these helpers or `strand-spec-helpers.ts`, so none needed updating.
- Tests: none were added by the implementer and none are warranted — moved helpers are exercised by the existing suites.

**Validation (repo root, 2026-09-30)**

- `yarn workspace @serfab/cadre-core typecheck` — passed.
- `yarn lint` — passed.
- `yarn workspace @serfab/cadre-core test` (the full suite, which the implement stage had not run) — 147 files, 2379 passed, 1 skipped. The skip is the existing `it.skipIf(process.platform === 'win32')` in `key-store.spec.ts`, unrelated to this change.

**Found**

- Minor: nothing to fix inline.
- Major: none.
- Tripwire / declined: `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts` keeps its own `memberPeerStamp`, `managerStamp` and a tombstone insert. Left as is: it is a separate package, and cadre-core's `test/` directory is not an importable module for it. Sharing would mean publishing test helpers from cadre-core for one consumer; not worth a ticket or a code comment unless a second integration scenario needs the same helpers.
