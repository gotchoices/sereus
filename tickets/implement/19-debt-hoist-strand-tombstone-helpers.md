description: Five strand test files each keep their own copy of the same few short test helpers; move them into the shared test-helper file so there is one copy of each.
files: packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-seal.spec.ts
difficulty: easy
----

# One home for the strand signing/lookup test helpers

## What is duplicated

`packages/cadre-core/test/strand-spec-helpers.ts` holds the shared setup for the `strand-*.spec.ts` suites (`openStrand`, `openRawStrand`, `tableCount`, `freshKeyPair`, `insertHeader`, `rawInsertMember`, `inTransaction`). Five helpers that belong beside them are instead copied per spec file. Line numbers measured 2026-09-30 with `grep -n "^\(async \)\?function " packages/cadre-core/test/strand-*.ts`:

| Helper | Copies | Where |
| --- | --- | --- |
| `fileTombstone` | 5 | `strand-approval-replay.spec.ts:108`, `strand-member-revocation.spec.ts:66`, `strand-membership-peer-registration.spec.ts:51`, `strand-membership-manager-rotation.spec.ts:65`, `strand-seal.spec.ts:103` |
| `memberPeerStamp` | 2 | `strand-approval-replay.spec.ts:86`, `strand-membership-peer-registration.spec.ts:36` |
| `managerStamp` | 2 | `strand-membership-manager-rotation.spec.ts:50`, `strand-seal.spec.ts:77` |
| `seatMember` | 2 | `strand-approval-replay.spec.ts:124`, `strand-seal.spec.ts:140` |
| `memberStamp` / `memberStampId` | 2 | `strand-approval-replay.spec.ts:72` (`memberStamp`), `strand-member-revocation.spec.ts:49` (`memberStampId`) — same body, two names |

`fileTombstone` inserts the `Strand.Revocation` row that retires a stamp, signed by the retiring party. Four of its five bodies are identical. The copy in `strand-member-revocation.spec.ts` has a different signature: `(db, stampId, retiree, tableName = 'Member')` with `tableName` typed `string`, against `(db, tableName, stampId, retiree)` with `tableName` typed `'Member' | 'Manager' | 'MemberPeer'` everywhere else. It is `string` there because one test (`strand-member-revocation.spec.ts:709`, "rejects a tombstone naming a table outside the three guarded ones") passes the literal `'Bogus'`.

## Design (settled)

Add the following to `strand-spec-helpers.ts`. Bodies are the existing ones, moved unchanged.

```ts
/** The three tables whose rows carry a single-use `StampId` that `Strand.Revocation` can retire. */
export type StampedTable = 'Member' | 'Manager' | 'MemberPeer';

export async function memberStamp(db: Database, key: string): Promise<string>;
export async function managerStamp(db: Database, key: string): Promise<string>;
export async function memberPeerStamp(db: Database, memberKey: string, peerId: string): Promise<string>;

/** Seat a fresh member (admitted by `founder`) and return its keypair. */
export async function seatMember(db: Database, founder: Ed25519KeyPair): Promise<Ed25519KeyPair>;

export async function fileTombstone(
  db: Database, tableName: StampedTable, stampId: string, retiree: Ed25519KeyPair,
): Promise<void>;

/** Same insert as `fileTombstone`, but `tableName` is any string — only for tests of how the schema confines that column. */
export async function fileTombstoneNamingAnyTable(
  db: Database, tableName: string, stampId: string, retiree: Ed25519KeyPair,
): Promise<void>;
```

`fileTombstoneNamingAnyTable` holds the body (sign `['Strand.Revocation', 'retire', tableName, stampId]`, then the `insert into Strand.Revocation ... with context MemberKey = ?, Signature = ?`). `fileTombstone` is a one-line call to it, so the signing vector and the SQL exist once.

Why this shape for the `'Bogus'` case:

- Widening the shared parameter to `string` was rejected: every other call site would lose the compile-time check that the table name is one of the three real ones, and the argument next to it (`stampId`) is also a string, so a swapped pair would typecheck.
- Having the one negative test issue its own `insert` inline was rejected: it would re-create a second copy of the signing vector and SQL, which is the thing this ticket removes.
- A separately named function keeps the union on the normal path and makes the one deliberate out-of-range call visible by name at its call site.

`StampedTable` is a new, narrower type rather than the existing exported `StrandTable`, because `StrandTable` also includes `Header`, `Invite`, `ConsumedInvite`, `CancelledInvite` and `Revocation`, none of which a tombstone can name.

The doc comment on the shared `fileTombstone` should carry the reason the helper exists, merged from the per-file comments: a raw delete that pins `/Authorized/` must file a tombstone in the same transaction, otherwise `RevocationRecorded` fires too and the reported constraint depends on engine evaluation order; and `Strand.Revocation` has its own constraint named `Authorized`, so a retiree that is not a committed member fails with that same name. Drop the "duplicated here" sentences.

New imports needed in `strand-spec-helpers.ts`: `signStrandApproval` and `addMemberByManager` from `../src/strand-membership-writer.js` (the module already imports `bootstrapFounderMembership` and `generateStrandStampId` from there). The file header comment says the module holds "small raw-write/read helpers"; that still describes it, no rewording needed beyond what reads naturally.

## Per-file changes

- `strand-approval-replay.spec.ts`: delete local `memberStamp`, `memberPeerStamp`, `fileTombstone`, `seatMember`; import them. Keep `managerRow`, `isMember`, `isManager` local (single copies, or one-line seeks whose only sibling has a different name and no drift in behaviour). Note line 157 declares a local `const managerStamp` — this file must not import the shared `managerStamp`, or that `const` shadows it (lint may flag shadowing).
- `strand-member-revocation.spec.ts`: delete local `memberStampId` and `fileTombstone`; import `memberStamp`, `fileTombstone`, `fileTombstoneNamingAnyTable`. Rename every `memberStampId(` call to `memberStamp(`. Rewrite every `fileTombstone(db, stamp, retiree)` call to `fileTombstone(db, 'Member', stamp, retiree)` (lines 108, 203, 204, 657, 670, 678, 691, 717). Line 709 becomes `fileTombstoneNamingAnyTable(db, 'Bogus', generateStrandStampId(), founder)`.
- `strand-membership-peer-registration.spec.ts`: delete local `memberPeerStamp`, `fileTombstone`; import them.
- `strand-membership-manager-rotation.spec.ts`: delete local `managerStamp`, `fileTombstone`; import them. `seatMembers` (plural, takes existing keypairs) is a different helper and stays.
- `strand-seal.spec.ts`: delete local `managerStamp`, `fileTombstone`, `seatMember`; import them. Retype the local `hasRevocation` parameter as `StampedTable`. `hasRevocation` and `rawSelfDeleteManager` stay local (one copy each); the `{@link fileTombstone}` in `rawSelfDeleteManager`'s comment still resolves through the import.

After the move, remove imports that a spec file no longer uses (`signStrandApproval`, `addMemberByManager`, `Ed25519KeyPair`, `Database`, `freshKeyPair`) only where nothing else in that file uses them — most files still do; `yarn lint` reports the unused ones.

## Edge cases & interactions

- **Argument order in `strand-member-revocation.spec.ts`.** The old order was `(db, stampId, retiree)`. A missed call site fails `yarn typecheck`, because a keypair object is not assignable to `stampId: string` and a stamp string is not assignable to `StampedTable`. Verified by typecheck, no new test.
- **The `'Bogus'` test must still reject with `/RowIsGone/`**, not pass or reject with a different constraint. Verified by the existing test.
- **Name collision with the local `const managerStamp`** at `strand-approval-replay.spec.ts:157` — covered above; verified by lint/typecheck.
- **Module side effect.** `strand-spec-helpers.ts` registers a file-level `afterEach` on import. All five files already import it, so nothing changes. Verified by inspection.
- **No behaviour change.** The helper bodies move unchanged, so any test that flips from pass to fail is a regression in the move, not something to adjust the test for.
- **No new tests.** This is a relocation; the existing suites are the check.

## Out of scope

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts` has its own `memberPeerStamp` and `managerGeneration`. It is a different package with no test-helper module shared with cadre-core; leave it.

## Validation

From the repo root (foreground, no redirection):

- `yarn workspace @serfab/cadre-core typecheck`
- `yarn lint`
- `yarn workspace @serfab/cadre-core vitest run test/strand-approval-replay.spec.ts test/strand-member-revocation.spec.ts test/strand-membership-peer-registration.spec.ts test/strand-membership-manager-rotation.spec.ts test/strand-seal.spec.ts`

If the stale-build guard reports a sibling repository's `dist` is stale, stop and record that in the ticket; do not build the sibling (see `tickets/rules/sibling-repos.md`).

## TODO

- Add `StampedTable`, `memberStamp`, `managerStamp`, `memberPeerStamp`, `seatMember`, `fileTombstoneNamingAnyTable`, `fileTombstone` to `strand-spec-helpers.ts` with the merged doc comment
- Replace the local copies in the five spec files with imports, per "Per-file changes"
- Reorder the `fileTombstone` call sites in `strand-member-revocation.spec.ts` and switch the `'Bogus'` call to `fileTombstoneNamingAnyTable`
- Confirm no local copies remain: `grep -n "^async function \(fileTombstone\|memberPeerStamp\|managerStamp\|seatMember\|memberStamp\|memberStampId\)" packages/cadre-core/test/*.spec.ts` prints nothing
- Run typecheck, lint, and the five suites
