description: Tests now prove that when the last manager of a private group permanently freezes who belongs to it, a second machine learns about it and refuses to let anyone else in — and two documentation claims that turned out to be wrong were corrected.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, docs/architecture.md, docs/strands.md, schemas/strand.qsql
difficulty: medium
----

# What landed

Two new networked tests plus three documentation corrections. No production code changed —
`sealStrand` / `isStrandSealed` / the schema were already correct; what was missing was
proof on the *other* node, and honest prose about the window before the seal gets there.

## Code

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
(1349 → 1576 lines; `wc -l`). Extended in place, per the ticket's settled decision not to
open a sibling file — the seal cases need ~400 lines of harness private to this file.

- **New `describe`, "Closed-strand sealing converges to the second node"**, at the end of
  the file, with two tests. Each brings up its own two-node strand.
- **Test A — `the founder's seal reaches the second node and binds ITS schema against
  every admission path`.** Issues an invitation on the founder *before* sealing and gates
  it visible on the joiner; captures the founder's live `Strand.Manager.StampId`; asserts
  the joiner currently sees that `Manager` row; seals on the founder; gates
  `isStrandSealed(joinerDb)` on the shared `GATE` budget; asserts the joiner's whole
  sealed shape (`managerKeys` empty, plus a `Strand.Revocation` row for `'Manager'` at the
  captured stamp, both via scan-and-filter) **before** any rejected write; then the
  rejection block against `joinerDb` — `issueInvite` → `/InviteValid/`, `consumeInvite` of
  the pre-seal invitation by a fresh key → `/NotSealed/`, `addMemberByManager` →
  `/Authorized/`, `addManager` re-promoting the ex-manager → `/Authorized/`. Nothing
  follows it (this file's rejection floor).
- **Test B — `a sealed strand cannot be re-founded from the node that did not seal it`.**
  Seal, gate, assert state (`managerKeys` empty, `memberKeys` exactly the founder), then a
  *signed* generation-0 `insert into Strand.Manager` against `joinerDb` →
  `/Authorized/`. Same shape as `cadre-core/test/strand-seal.spec.ts` → "refuses a SIGNED
  re-founding attempt at generation 0"; what it adds is the other machine.
- **New private helper `managerStamp(db, memberKey)`** beside `managerGeneration` — one
  scan reading both columns, throws rather than returning `undefined` (a missing stamp
  would silently weaken Test A's tombstone assertion into "some tombstone exists").
- **File header updated**: "SIX independent tests" → "EIGHT", the scope sentence, the
  "four of the six end with rejected writes" count → "six of the eight", the
  gated-everywhere list, and the visibility-is-not-physical-replication paragraph (four
  convergence tests → six).
- **Two `NOTE:` tripwires** in the new block's JSDoc: hoist the harness into
  `src/harness/` if a *third* scenario ever needs it; and why the propagation window gets
  no test, quoting both observed failure strings verbatim.

## Docs

- **`docs/architecture.md`**, manager-removal hazards: the false claim *"Only that key; no
  stranger gains anything"* is gone. Replaced with what the new tests prove (arrival, the
  constraint each path fails, the 42/138 ms measurement, no split state observed) and an
  honest ⚠️ **Still open** for the pre-convergence window — including that
  `ConsumedInvite.NotSealed` is locally evaluated so a *stranger* holding a pre-seal
  invitation gains, that the mechanism was observed but the composite is inferred from the
  schema text, and that two nodes fail closed so the composite cannot be staged there.
- **`docs/architecture.md`**, replay coverage: "Coverage is single-node only … has no
  test" qualified rather than deleted — seal propagation now has a two-node test; the
  `MemberExists` partition hazard and the `Revocation` tombstone replay are still
  uncovered, and it says so.
- **`docs/strands.md`** → *Who May Administer a Closed Strand*, known gaps: the "A seal
  only binds a node once it gets there" bullet rewritten in the section's plain language —
  a stranger holding a pre-seal invitation can still join at a node that has not heard
  about the seal, nothing un-joins them, the seal travels in tens of milliseconds on two
  nodes, and larger strands are unmeasured. The sealing bullet above it now points at the
  known gaps for the "outstanding invitations die with it" claim.
- **`schemas/strand.qsql`**: the `Manager` table's seal-propagation `NOTE:` no longer says
  "no stranger gains anything" and now names the integration test that covers arrival;
  `ConsumedInvite.NotSealed` gained one sentence saying its `Manager` read is local.

# Validation run

```
yarn workspace @serfab/integration-tests exec vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts
  → Test Files 1 passed (1), Tests 8 passed (8), 30.63s
yarn workspace @serfab/integration-tests run typecheck   → clean
yarn lint                                                 → clean
```

All eight tests pass, not just the new two — the header change and the new block did not
disturb the six that were passing. Observed in this run: `[closed-strand:seal-binds]
joiner observed the seal 67ms after the founder committed it`, consistent with the plan
pass's 42 ms / 138 ms.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

# What a reviewer should poke at

**These are the honest soft spots, not a checklist of things I already verified.**

- **The rejection assertions could pass for a wrong-but-adjacent reason.** Each is pinned
  to a constraint name, which is the strongest available guard, but a constraint name is
  still a substring match on an error message. Worth confirming by hand (or by
  deliberately breaking the seal) that `/NotSealed/` in Test A is genuinely the seal gate
  and not, say, an `InviteExists` failure whose message happens to enumerate constraints.
  The pre-seal invitation is gated visible on the joiner precisely to close that hole, but
  the gate proves the `Invite` row arrived, not that `NotSealed` is what fired.
- **`managerKeys(joinerDb)).toEqual([])` is an emptiness claim on a networked scan.** It
  is a scan (not a point lookup), and step 3 proves the row was there beforehand, so a
  vacuous pass needs both the scan to under-report *and* the earlier assertion to have
  passed — but a reviewer who knows the storage layer better than I do should confirm the
  scan cannot transiently under-report on a converged strand.
- **`isStrandSealed` as the gate condition.** It is three conjuncts, so neither half of
  the seal alone satisfies it — that is why it was chosen. But it is also *the function
  under test* being used as its own gate. An independent formulation (scan `Manager`
  empty + scan `Revocation` for the captured stamp) would be a stronger gate; I kept
  `isStrandSealed` because the ticket specified it and because step 5 immediately
  re-asserts both halves independently. Reviewer's call whether that is enough.
- **Test A's timing log is informational only.** Nothing asserts a bound on convergence
  latency — deliberately, since a wall-clock assertion on a two-node libp2p fixture is a
  flake generator. So the "tens of milliseconds" claim now in the docs rests on three
  observations (42, 138, 67 ms), not on anything CI will keep honest. If that number
  matters to anyone, it needs a real benchmark, not this test.
- **Nothing tests the window itself, and nothing tests above cohort size.** Both are
  argued in comments rather than asserted. The reasoning for why a two-node partition
  cannot stage it is reproduced verbatim from the plan pass's measurements (I did not
  re-run those probes); if a reviewer doubts it, the two failure strings in the `NOTE:`
  are the thing to reproduce. The unmeasured above-cohort-size window is already an arm on
  `backlog/debt-replication-proof-above-cohort-size` (filed by the plan pass — I added
  nothing there).
- **The stranger-joins-a-stale-node claim in the docs is INFERRED, not demonstrated.** The
  plan pass observed a cut-off joiner accepting a pre-seal redemption, and the schema text
  says `NotSealed` reads local rows; the composite (that same acceptance *on a strand that
  is sealed elsewhere*) has never been run end to end. The docs say so explicitly in both
  places. If a reviewer thinks that wording still overclaims, it is the sentence to
  argue about.
- **Doc-prose judgement.** Three files' worth of wording changed; none of it is
  machine-checked. In particular the `docs/architecture.md` hazards paragraph is now long,
  and the `docs/strands.md` bullet is deliberately plainer and longer than its neighbours
  because the correction is the part a human most needs to understand.

# Deliberately not done

- No sibling test file, no harness hoist into `src/harness/` — recorded as the tripwire
  described above. The ticket settled this; I did not re-litigate it.
- Tests four and six (physical replication, offline durability) were not extended to the
  seal. These tests claim *visibility*, and the header now says so for the seal cases too.
- No new tickets filed. Nothing found during implementation warranted one.
