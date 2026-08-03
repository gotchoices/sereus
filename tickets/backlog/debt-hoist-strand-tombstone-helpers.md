description: Four strand test files each keep their own copy of the same short helper that writes a "this row was retired" record; move it into the shared test-helper file so there is one copy.
files: packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts
difficulty: easy
----

# One home for the per-feature strand signing/lookup test helpers

## The duplication

`packages/cadre-core/test/strand-spec-helpers.ts` (landed by `debt-strand-spec-helpers-duplicated`)
took the *bootstrap* plumbing — `openStrand`, `openRawStrand`, `tableCount`, `freshKeyPair`,
`insertHeader`, `rawInsertMember`, `inTransaction`. It deliberately took nothing that signs, so
the per-feature signing and stamp-lookup helpers stayed local to each spec file and are now
copied around:

| Helper | Copies | Where |
| --- | --- | --- |
| `fileTombstone` | 4 | `strand-approval-replay.spec.ts:100`, `strand-member-revocation.spec.ts:66`, `strand-membership-peer-registration.spec.ts:51`, `strand-membership-manager-rotation.spec.ts:64` |
| `memberPeerStamp` | 2 | `strand-approval-replay.spec.ts:78`, `strand-membership-peer-registration.spec.ts:36` |

Counted with `grep -rn "async function fileTombstone\|function memberPeerStamp" packages/cadre-core/test`.
Three of the four `fileTombstone` bodies are byte-identical; the fourth
(`strand-member-revocation.spec.ts`) has drifted — its parameter order is
`(db, stampId, retiree, tableName = 'Member')` rather than `(db, tableName, stampId, retiree)`.
That drift is the cost this ticket is really about: the same helper now reads two different
ways depending on which file you opened.

`fileTombstone` writes the `Strand.Revocation` row that retires a stamp, signed by the retiring
party. Every raw `DELETE` test that wants its assertion pinned to the `Authorized` constraint
must file one in the same transaction, otherwise `RevocationRecorded` fires too and which
constraint gets reported becomes engine evaluation order. So it is genuinely shared vocabulary
across every strand-membership suite, not a per-file convenience.

## What makes this more than a copy-paste

The two signatures cannot merge mechanically. `strand-member-revocation.spec.ts:709` passes the
literal `'Bogus'` as the table name — a negative test that a tombstone naming a table that does
not exist is rejected. The other three copies type the parameter as the closed union
`'Member' | 'Manager' | 'MemberPeer'`, which forbids that. Whoever picks this up has to choose:
widen the shared parameter to `string` (loses the typo protection the union gives the other 23
call sites), keep the union and let the one negative test issue its `insert` inline, or add an
explicitly-named escape hatch. That decision — not the move itself — is the work.

Note the shared module already exports `StrandTable`, a union of the strand table names, which
is the natural type for the parameter if the union route is taken.

## Expected end state

One exported `fileTombstone` and one exported `memberPeerStamp` in `strand-spec-helpers.ts`, one
argument order, all four spec files importing them, no local copies left. `yarn lint`,
`yarn typecheck`, and the cadre-core `strand-*` suites stay green — the helper bodies are not
changing behaviour, only location, so any test that flips is a real regression.

## Explicitly out of scope

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
carries its own `memberPeerStamp` and `managerGeneration`. That is a different package with no
shared test-helper module between the two, and setting one up is a larger structural question
than this ticket. Leave those copies alone.
