description: Five strand test files each keep their own copy of the same few short test helpers; move them into the shared test-helper file so there is one copy of each.
files: packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-peer-registration.spec.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-seal.spec.ts
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
| `fileTombstone` | 5 | `strand-approval-replay.spec.ts:108`, `strand-member-revocation.spec.ts:66`, `strand-membership-peer-registration.spec.ts:51`, `strand-membership-manager-rotation.spec.ts:65`, `strand-seal.spec.ts:103` |
| `memberPeerStamp` | 2 | `strand-approval-replay.spec.ts:86`, `strand-membership-peer-registration.spec.ts:36` |
| `managerStamp` | 2 | `strand-membership-manager-rotation.spec.ts:50`, `strand-seal.spec.ts:77` |
| `seatMember` | 2 | `strand-approval-replay.spec.ts:124`, `strand-seal.spec.ts:140` |

Counted with `grep -rn "async function fileTombstone\|function memberPeerStamp\|async function managerStamp\|async function seatMember" packages/cadre-core/test`
(2026-09-02, after `strand-seal-tests-and-docs`).
Four of the five `fileTombstone` bodies are byte-identical; the odd one out
(`strand-member-revocation.spec.ts`) has drifted — its parameter order is
`(db, stampId, retiree, tableName = 'Member')` rather than `(db, tableName, stampId, retiree)`.
That drift is the cost this ticket is really about: the same helper now reads two different
ways depending on which file you opened.

`strand-seal.spec.ts` (landed 2026-09-02) added the fifth `fileTombstone`, a second
`managerStamp` and a second `seatMember`; its copy of `fileTombstone` is byte-identical to
the three-way-identical group and its `managerStamp` is identical to the rotation spec's.
It also carries a `hasRevocation` reader with no sibling yet — one copy, so not part of this
move, but it belongs in the same shared module the day a second file wants it.

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

One exported `fileTombstone`, `memberPeerStamp`, `managerStamp` and `seatMember` in
`strand-spec-helpers.ts`, one argument order each, all five spec files importing them, no
local copies left. `yarn lint`, `yarn typecheck`, and the cadre-core `strand-*` suites stay
green — the helper bodies are not changing behaviour, only location, so any test that flips
is a real regression.

## Explicitly out of scope

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
carries its own `memberPeerStamp` and `managerGeneration`. That is a different package with no
shared test-helper module between the two, and setting one up is a larger structural question
than this ticket. Leave those copies alone.
