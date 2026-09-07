description: Tests now prove that when the last manager of a private group permanently freezes who belongs to it, a second machine learns about it and refuses to let anyone else in — and the documentation claims that turned out to be wrong were corrected in every copy.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/quereus-plugin-sereus/src/strand-schema.ts, schemas/strand.qsql, docs/architecture.md, docs/strands.md
----

# What landed

Two networked tests proving a seal converges to the node that did not perform it and
binds *that* node's schema, plus documentation corrections in every place the old,
false claim lived. No production behaviour changed — `sealStrand` / `isStrandSealed` /
the schema constraints were already correct; what was missing was proof on the other
machine and honest prose about the window before the seal gets there.

## Code

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
grew from six tests to eight, in place (the seal cases need ~400 lines of harness
private to this file).

- **Test A — the founder's seal reaches the second node and binds its schema against
  every admission path.** Issues an invitation *before* sealing and gates it visible on
  the joiner (so the redemption below cannot fail for the wrong reason); captures the
  founder's live `Strand.Manager.StampId`; asserts the joiner currently sees that
  `Manager` row; seals on the founder; gates the joiner on `isStrandSealed`; asserts the
  joiner's whole sealed shape — no managers, a `Strand.Revocation` tombstone at exactly
  the captured stamp — **before** any rejected write; then refuses, against `joinerDb`:
  `issueInvite` (`InviteValid`), `consumeInvite` of the pre-seal invitation by a fresh
  stranger key (`NotSealed`), `addMemberByManager` and a re-promotion of the ex-manager
  (`Authorized`, both), and `admitManager` (`CHECK constraint failed` — see findings).
- **Test B — a sealed strand cannot be re-founded from the node that did not seal it.**
  A *signed* generation-0 `Strand.Manager` insert is refused on the joiner, because the
  retired manager stamp that closed the founding branch arrived over the wire.
- **`managerRow(db, memberKey)`** — one scan reading every column its callers need;
  `managerGeneration` and `managerStamp` are now thin accessors over it.
- **File header** updated for the new count, scope, gating list and the
  visibility-is-not-physical-replication paragraph.
- **Two `NOTE:` tripwires** in the new block's JSDoc: hoist the harness into
  `src/harness/` if a third scenario needs it; and why the propagation window gets no
  test, quoting both observed failure strings verbatim.

## Docs and schema

- **`docs/architecture.md`** — the manager-removal hazards paragraph no longer claims
  *"Only that key; no stranger gains anything"*; it now states what the tests prove and
  carries an honest ⚠️ **Still open** for the pre-convergence window, including that
  `ConsumedInvite.NotSealed` is evaluated against locally visible rows so a *stranger*
  holding a pre-seal invitation gains. Replay-coverage wording qualified rather than
  deleted. A new **End-to-end coverage** paragraph describes both seal tests. Latency is
  quoted as a measured range, not a bare adjective.
- **`docs/strands.md`** → *Who May Administer a Closed Strand*: the "a seal only binds a
  node once it gets there" known-gap bullet rewritten in plain language.
- **`schemas/strand.qsql`** and its mirrored runtime copy
  **`packages/quereus-plugin-sereus/src/strand-schema.ts`** — the `Manager`
  seal-propagation `NOTE:` corrected and pointed at the covering test;
  `ConsumedInvite.NotSealed` gained a sentence saying its `Manager` read is local.

# Validation run

```
yarn lint                                                          → clean
yarn workspace @serfab/integration-tests run typecheck             → clean
yarn workspace @serfab/quereus-plugin-sereus run typecheck         → clean
yarn workspace @serfab/quereus-plugin-sereus build                 → ok (stale-build guard)
yarn workspace @serfab/quereus-plugin-sereus test  → 9 files, 99 passed | 1 todo
yarn workspace @serfab/cadre-core test             → 107 files, 1718 passed | 1 skipped
yarn workspace @serfab/integration-tests exec vitest run \
  src/scenarios/strand-membership-closed-strand-e2e.integration.ts → 8 passed, 55.5s
```

The scenario was re-run *after* the plugin rebuild, so it exercised the corrected
embedded schema rather than a stale `dist`. Seal propagation observed at 64 ms and
73 ms in this pass, consistent with the 42/138/67 ms of earlier passes.

`tickets/.pre-existing-error.md` deliberately NOT written: the one failure this pass
found was caused by this ticket's own implement commit (below), not pre-existing.

# Review findings

## Major — found and fixed in this pass

- **The mirrored runtime schema was never updated, and its drift guard was RED.**
  `schemas/strand.qsql` and `packages/quereus-plugin-sereus/src/strand-schema.ts` are
  two hand-synced copies of the same schema; `docs/architecture.md` calls them
  "byte-equivalent" and
  `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` enforces it. The
  implement pass edited only the canonical copy, so at commit `b77fe98` that spec
  failed — and the embedded copy that actually runs on React Native and in the browser
  still carried the exact false claim this ticket existed to correct ("Only that one
  key; no stranger gains anything"). The implement pass's validation ran lint, a
  typecheck and one integration file, never the plugin's suite, so it never saw it.
  **Fixed**: both comment corrections mirrored; the guard is green.

  *Architecture-first note*: the invariant already has the right enforcement — a
  boundary test that catches the whole class — so no ticket. The gap was visibility,
  handled as a tripwire below.

## Minor — fixed inline

- **`docs/architecture.md` → "End-to-end coverage" was stale.** That section gives each
  test in the file its own paragraph (first through sixth); the two new ones had none.
  Added a paragraph covering both, including what is logged rather than asserted.
- **A coverage claim in the same section went stale.** "Not covered by any test:
  `removeManager`, `cancelInvite`, `admitManager` and `leaveStrand` still run
  founder-side only" — `admitManager` is now driven from the joiner (as a rejected
  write). Sentence corrected to say exactly that, rather than dropping the name.
- **Test A's title claimed "every admission path" but covered four of five.**
  `admitManager` was missing. Added, pinned to `/CHECK constraint failed/` rather than a
  constraint name: it writes a `Member` row and a `Manager` row in one transaction, so
  which `Authorized` is reported is engine evaluation order — the same compromise, for
  the same reason, that `cadre-core/test/strand-seal.spec.ts` makes single-node.
  (`cancelInvite` is an administrative path, not an admission path, so the title stays
  true without it; it remains covered single-node only.)
- **The convergence-latency log under-reported.** `sealCommittedAt` was captured *after*
  a founder-side `isStrandSealed` call, which is itself several networked scans — so the
  logged delay omitted them. Moved to the instant `sealStrand` returns; over-reporting is
  the safe direction for a number the docs quote. Re-measured 64 ms / 73 ms.
- **`managerStamp` duplicated `managerGeneration`.** Two near-identical scan-and-filter
  loops differing only in the column read. Collapsed onto one `managerRow` helper, which
  is also the shape the file's own comment argues for ("ONE scan reading both columns
  together").
- **Ragged JSDoc left by minimal-diff edits.** Three orphaned short lines in the file
  header, reflowed.
- **`strand-schema.ts` JSDoc pointed at a "planned" guard** that in fact exists. Now
  names `test/strand-schema-drift.spec.ts` and says what it cannot catch.
- **The `docs/architecture.md` manager-removal hazards paragraph had grown to one
  ~500-word block.** Split in two at the seal sentence. No content changed.

## Verified, not defects — including the implementer's own listed soft spots

- **"The rejection assertions could pass for a wrong-but-adjacent reason."** Checked by
  reading every constraint on each target table against the post-seal state. In each of
  the four pinned cases the named constraint is the *only* one that can fail:
  `Invite.InviteValid` (needs a `Manager` row), `ConsumedInvite.NotSealed` (all its
  siblings pass, and `Member.Authorized`'s invite branch never reads `Manager`),
  `Member.Authorized` for `addMemberByManager`, and `Manager.Authorized` for the
  re-promotion. Decisive supporting evidence: the single-node spec has to pin
  `admitManager` to `/CHECK constraint failed/` *because* `/Authorized/` would be
  ambiguous — which means the engine names one constraint per failure, not an
  enumeration. The substring-match worry does not survive that.
- **"`managerKeys(joinerDb)).toEqual([])` is an emptiness claim on a networked scan."**
  `scanColumn` issues an unfiltered scan, the shape the file header argues is the only
  reliable one; the point-lookup hazard it warns about does not apply. Step 3's
  positive assertion rules out a vacuous pass.
- **"`isStrandSealed` used as its own gate."** Acceptable as written: it is three
  conjuncts, so no half of the seal satisfies it, and step 5 immediately re-asserts both
  halves through independent scans in the test file. Confirmed `isStrandSealed`'s own
  reads (`strandTableCount`, `strandHasManagerRevocation`) are scans, not point lookups.
- **Test A step 3's ungated `toContain`** is safe: `bringUpClosedStrand` already gates
  `Manager` count ≥ 1 on the joiner.
- **Test B's signed re-founding insert** matches the promotion branch's digest shape and
  context columns exactly; the bootstrap branch is closed by the retired stamp. It fails
  for the intended reason.
- **`docs/strands.md`'s stranger-joins-a-stale-node wording** states the gap as fact
  while `docs/architecture.md` marks the composite as inferred. Deliberate and correct:
  the mechanism follows from the constraint text regardless of whether the composite was
  staged end to end, and a plain-language *known gaps* section should not understate a
  security window. Left as written.

## Tripwire recorded, not filed

- **The schema drift guard lives in a different package from the canonical schema.** An
  edit to `schemas/strand.qsql` alone stays green everywhere its author is likely to
  look — exactly what happened here. Recorded as a `NOTE:` in the `schemas/strand.qsql`
  header (and echoed in `strand-schema.ts`'s JSDoc) telling the editor to run that spec.
  Conditional, not a defect: the guard already covers the class, and it only bites when
  someone edits one copy and runs neither the plugin suite nor CI.

## Considered and NOT filed

- **The pre-convergence admission window** (a stranger with a pre-seal invitation joining
  a node behind on the seal) is real and now honestly documented, but it is **already
  tracked** — an arm added by this ticket's plan pass sits on
  `tickets/backlog/debt-replication-proof-above-cohort-size` (lines 43–61), which also
  explains why it cannot be staged on a two-node fixture. Re-filing would duplicate it.
- **The wider "membership gates read locally visible rows" class** (`MinOneMember`,
  `NotRevoked`, `Manager.MemberExists`, `ConsumedInvite.NotSealed`) is a documented,
  deliberate property of the design, stated at all four sites and in both docs. Changing
  it is a design decision, not a bug fix, and nothing in this diff makes it newly urgent.
- **A wall-clock assertion on convergence latency.** Correctly declined by the
  implementer: it would be a flake generator on a two-node libp2p fixture. The docs now
  say the figure rests on observation rather than on anything CI keeps honest.

## Empty categories

- **No new `fix/`, `plan/` or `backlog/` tickets** — the one major finding was a
  mechanical mirror omission, fixed here, whose enforcing invariant already exists; every
  other finding was minor enough to fix inline or already tracked.
- **Nothing routed to `blocked/`** — no decision in this diff needs a human, and no
  dependency sits outside this repo.
- **No pre-existing failures** — the full `cadre-core`, `quereus-plugin-sereus` and
  scenario suites are green, and the one red test this pass found was introduced by this
  ticket's own implement commit.
