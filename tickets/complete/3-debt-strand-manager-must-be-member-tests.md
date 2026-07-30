description: Tests now prove that a group's admin must also be one of its members, so the rule cannot silently break in future; reviewed, extended, and green.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, schemas/strand.qsql, packages/cadre-core/src/strand-membership-writer.ts
----

# Complete: tests for `Manager.MemberExists` + `admitManager`

Test-only work. No source, no schema, no docs changed — the schema constraint and the
`admitManager` writer landed in the two prior tickets. The remaining paperwork (two design
docs still stating the OLD rule, two stale test comments in other packages, repo-wide
`yarn typecheck`, the plugin test suite) belongs to `debt-strand-manager-must-be-member-docs`,
which runs next.

## The invariant now under test

A `Strand.Manager` row must always have a `Strand.Member` row behind it. Two constraints
hold the halves:

- **insert half** — `Manager.MemberExists` (`schemas/strand.qsql:379-381`) refuses a
  promotion of a key with no `Member` row. It reads the LIVE `Member` table, so an
  admit-then-promote inside ONE transaction passes.
- **delete half** — `Member.NotAManager` (`schemas/strand.qsql:198-200`) refuses to
  un-member a key that still holds a `Manager` row. Deferred, so it sees the post-image: a
  transaction deleting BOTH rows passes, in either statement order.

Why it matters: every delete a manager performs files a `Strand.Revocation` tombstone, and
`Revocation.Authorized` verifies the filer against a committed `Member` row. A manager with
no `Member` row would therefore hold admin rights it could never exercise — no revoking a
member, no clearing a peer binding, not even resigning.

## Tests in place

`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (46 → 52 tests):

- promotion of a key with no `Member` row is rejected, pinned to `MemberExists` by name
  (the promotion is otherwise well-formed, so that constraint is the sole rejector);
- the founding `Manager` seat needs its `Member` row first — the real bootstrap path is
  asserted to still seat Member=1/Manager=1, and a hand-seeded reverse order is rejected
  with a positive control proving the ordering was the cause;
- new `describe('admitManager')`: both rows at ONE commit and the new manager then really
  does revoke a member, clear another member's peer binding, and resign; a rejected
  admission leaves NEITHER row; a repeat call for an existing member seats no `Manager`
  row; admissions cannot be chained inside one transaction.

`packages/cadre-core/test/strand-member-revocation.spec.ts` (+1 test): revoke-then-resign in
one transaction, the mirror of the pre-existing resign-then-revoke test, proving statement
order is irrelevant to the deferred delete-half check.

## Review findings

**Checked.** The implement diff (`df12c19`) read first, before the handoff summary. Every
constraint-branch claim in the new test comments was re-derived against
`schemas/strand.qsql` (`Member.Authorized`, `Member.NotAManager`, `Manager.MemberExists`,
`Manager.Authorized`) and against `strand-membership-writer.ts`'s `addManager` /
`admitManager`, rather than taken from the handoff. Also checked: helper duplication across
the strand specs, the new helpers' necessity and use count, spec file size, whether the
`admitManager` behaviours documented on the writer are actually covered, whether the
duplicated-`/Authorized/`-name ambiguity is handled the way the rest of these specs handle
it, and which docs the change should have touched.

**Minor — fixed in this pass.**

- The comment on `a rejected admission leaves NEITHER row` claimed `Member.Authorized` was
  the rejector. It is not the only one: the stranger holds no `Manager` row, so the
  promotion half fails `Manager.Authorized` too (the writer falls back to generation 1 and
  lets the schema reject — and the promotion-half-alone case is already covered by
  `rejects an add whose signer is not a manager`). Both constraints are named `Authorized`
  and the engine reports the bare name, so the `/Authorized/` pin holds either way; the
  comment now says the rejection is over-determined and that the test's load-bearing claim
  is the atomicity, matching how the neighbouring over-determined tests in this file are
  already worded.
- The writer documents `admitManager` as NOT insert-if-absent (a repeat call for an
  existing member collides on the `Member` primary key), and the handoff listed that as
  untested. Added `is not insert-if-absent: a repeat call for an existing member seats no
  Manager row` — it pins the unique-violation, asserts both counts unchanged and no
  generation for the key, then shows `addManager` (the call the caller actually wanted)
  succeeding on the untouched rows. The rollback is the point: the promotion half alone
  would have been legal.
- The spec's file header still described its scope as peer registration plus manager
  promote/remove/resign, omitting admit-and-promote. Updated.

**Major — one new ticket.** `tickets/backlog/debt-strand-spec-helpers-duplicated.md`. Five
`strand-*.spec.ts` files each carry their own copy of `makeSAppConfig`, `freshKeyPair`,
`tableCount`, `openStrand`, `inTransaction`, and now `openRawStrand`, `insertHeader`,
`rawInsertMember`. The `inTransaction` and `openStrand` copies encode the subtle parts
(rollback-after-failed-commit; node shutdown on teardown), so a fix will land in one copy
and not the rest. The package already has the convention for this
(`control-constraint-helpers.ts`, `membership-gate-helpers.ts`, `wake-stream-helpers.ts`).
The handoff suggested folding this into `4-debt-share-transaction-rollback-helper`; that
ticket is about `ControlDatabase`/`seed-bootstrap.ts` production code and shares nothing
with these test helpers, so a separate ticket was filed instead. The rotation spec's size
(~1,500 lines, mostly manager rotation rather than peer registration) is recorded there as
a decision for whoever picks it up, not as separate work.

**Conditional / speculative — no tickets filed.** Two, both already recorded at their code
site as `NOTE:` comments in `schemas/strand.qsql`, so nothing new was parked: (1) two
partitioned nodes can still converge to a `Manager` row with no `Member` row — same
convergence class as the `MinOneMember` / `MinOneManager` notes, and only real work if
partitioned membership changes become a supported workflow; (2) `MemberPeer` rows still
outlive their `Member` row, whose networked-removal coverage is separately queued as
`debt-strand-memberpeer-networked-removal-coverage` in `plan/`.

**Deliberately left alone.** The handoff asked whether the founding-order test's loose
`/CHECK constraint failed/` pin is worth its two node bring-ups, and whether that test
belongs in `strand-founder-bootstrap.spec.ts` instead. Kept as-is: the rejection genuinely
is over-determined in the founding state (`MemberExists` and the `Manager.Authorized`
bootstrap branch assert the same predicate there), the loose pin plus the positive control
is exactly the idiom the rest of this file uses, and the founder-bootstrap spec drives
`StrandInstanceManager` with no `Database`-level helpers to hand-seed rows with.

**Docs.** None needed here and none touched — a repo-wide grep for the parent slug outside
`tickets/` hits exactly `docs/architecture.md:580`, `docs/architecture.md:612`, and
`docs/strands.md:214`, and all three are itemised in
`debt-strand-manager-must-be-member-docs` with the corrections spelled out. That ticket's
"neither typecheck nor lint has been run" line was updated to record what this review ran.

## Validation

| command | result |
| --- | --- |
| `yarn lint` (repo-wide, `eslint .`) | exit 0, clean |
| `yarn workspace @serfab/cadre-core run typecheck` | exit 0, silent |
| `yarn vitest run` in `packages/cadre-core` (whole suite) | 71 files, **1094 passed, 1 skipped**, 57s |

The one skip is `key-store.spec.ts:231`, an `it.skipIf(process.platform === 'win32')` that
predates this work. Nothing was skipped, loosened, or disabled.

One environment note for the next agent: the suite's stale-build guard initially refused to
run because `../quereus`'s `dist` was older than an uncommitted edit to
`packages/quereus/src/vtab/memory/layer/scan-layer.ts` in that workspace (not this repo's
change, and not touched here). `yarn workspace @quereus/quereus build` in `C:\projects\quereus`
cleared it; the full suite is green against that rebuild.
