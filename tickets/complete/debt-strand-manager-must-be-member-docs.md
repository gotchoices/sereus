description: Documentation for the rule that a group's admin must also be one of its members is now written and reviewed — including the honest caveat that the rule is only checked against what a single node can see.
files: docs/strands.md (204-215, 236-240, 262-274), docs/architecture.md (580, 612-613), packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts (252-260), schemas/strand.qsql (364-381 Manager.MemberExists), packages/cadre-core/src/strand-membership-writer.ts (admitManager)
----

# Complete: docs + out-of-package call sites for `Manager.MemberExists`

Last of three chained tickets. Source (`Manager.MemberExists`, `Member.NotAManager`,
`admitManager`) landed in `debt-strand-manager-must-be-member`; its tests in
`debt-strand-manager-must-be-member-tests`. This ticket was paperwork only: docs, one
other package's test comment, validation.

## What shipped

**`docs/strands.md`** — plain-language rules for who may administer a closed strand:
- The paragraph that used to state the *old* rule ("being a manager does not require being
  a member") now states the enforced one, notes that admit-and-promote in one step is
  supported, and points at the known-gaps list for the single-node-visibility caveat.
- The *Removing Members* bullet states the removal-side half of the invariant and
  cross-references the insert-side half instead of restating it.
- The first known-gap bullet, previously only about the last-manager / last-member floors,
  now also covers the manager-must-be-a-member rule, which has the same
  one-node-visibility shape.

**`docs/architecture.md`** — implementation-level detail:
- The `addManager` bullet no longer claims the `Manager` table has no membership
  constraint; it states the enforced rule and points at `admitManager`.
- A new sibling `admitManager` bullet: one transaction, no new authority, promoting
  manager must pre-date the transaction so calls cannot chain.
- The anti-replay paragraph's claim that a non-member manager "can add members and promote
  managers but cannot revoke" is replaced with the current reality, plus the ⚠️ partition
  caveat in the same house style the neighbouring `MinOneManager` caveat uses.

**`packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`** — the `OnlyClosed`
test's header comment claimed the `Manager` insert "would otherwise satisfy its bootstrap
branch", true only before this rule existed. It now says the insert has two independent
rejectors (`OnlyClosed` and `Manager.MemberExists`) and why.

**`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`**
— read, nothing to change (see findings below for the independent re-derivation).

## Review findings

### Checked
- **The implement diff read first, against the schema, not the handoff.** Every doc claim
  re-derived from `schemas/strand.qsql` (`Manager.MemberExists`, `Manager.Authorized`
  bootstrap branch, `Revocation.Authorized`, `Member.NotAManager`, `MinOneManager`) and
  from `strand-membership-writer.ts` (`addManager`, `admitManager`, `removeManager`). The
  `admitManager` bullet's four claims — one transaction, both halves signed by the same
  manager over two distinct action-tagged digests, live-`Member`-table read, promoting
  manager must pre-date the transaction — all hold against the source.
- **Sites the change should also have touched.** Repo-wide grep for the retired ticket slug
  and for stale "a manager need not be a member" phrasings across `docs/`, `schemas/`,
  `packages/*/src`, `README.md`: zero remaining. `docs/STATUS.md` never carried the claim.
- **Test coverage for the rule** (from the prior ticket, re-checked, not re-written):
  `strand-membership-peer-rotation.spec.ts` covers the rejection, the founding-order case,
  `admitManager` accept, all-or-nothing rollback, repeat-call, and the no-chaining case.
  Adequate; nothing added.

### Found and fixed in this pass (all minor)
- **Two absolute claims contradicted by the schema's own note.** `docs/architecture.md:580`
  said `Manager.MemberExists` means "no manager is ever left holding those powers unable to
  use them", and `docs/strands.md` said the promotion "is rejected outright" with no
  qualifier. The constraint is a per-transaction check over locally visible rows — the
  schema comment says so explicitly — so a partitioned promote-vs-unmember pair can
  converge to a manager seat with no membership behind it. Both docs now carry the caveat,
  each in its own register: `architecture.md` in the ⚠️ style its `MinOneManager` caveat
  already uses, `strands.md` folded into the existing known-gaps bullet about local counts.
  This was the substantive finding — the docs were factually overclaiming.
- **Redundancy between two `strands.md` sections.** The insert-side rule was stated in full
  twice, thirty lines apart. The *Removing Members* bullet now cross-references rather than
  restates.
- **Misleading term of art in the test comment.** It said `'m1'` "never became a *committed*
  Member". `committed.<Table>` is a specific thing in this schema (the pre-transaction
  snapshot) and `Manager.MemberExists` reads the **live** table, so the word implied the
  wrong mechanism. Reworded.

### New tickets filed
None. Nothing found rose to major: the diff is prose plus one comment, the underlying
constraint was already reviewed in its own ticket, and the one real defect (overclaiming)
was a two-sentence fix.

### Tripwires recorded
None new. The convergence hazard this pass surfaced is not conditional — it is a live,
already-known limitation with an existing home in the schema comments — so it was written
into both docs as a stated gap rather than parked as a tripwire.

### Independent re-derivation the handoff asked for
`strand-membership-closed-strand-e2e.integration.ts:330-334` calls `addManager` with a
fresh signer *and* a fresh target. Re-derived from the schema rather than trusting the
handoff: the signer fails `Manager.Authorized` (no `Manager` row of smaller generation) and
the target independently fails `Manager.MemberExists` (no `Member` row). The comment ("A
non-manager cannot add a manager.") asserts only the signer-side reason and never claimed
exclusivity, so it stays accurate. Line 324 promotes a key already seated as a member
earlier in the scenario — unaffected. Confirms the handoff's call; no edit.

## Validation

| command | result |
| --- | --- |
| `yarn lint` (repo-wide `eslint .`) | exit 0, clean |
| `yarn typecheck` (repo-wide) | exit 0, clean, 14s |
| `yarn workspace @serfab/quereus-plugin-sereus test` | 7 files, 68 passed, 1 todo, 37s — includes the edited `strand-schema.e2e.spec.ts` |
| `yarn workspace @serfab/cadre-core test --run test/strand-*` | **not run** — see below |

**Why the `cadre-core` suite did not run.** Its `globalSetup` stale-build guard
(`test-harness/build-freshness.ts`) refuses the run: `@quereus/quereus`'s `dist` is older
than its `src`. The neighbouring `../quereus` workspace has uncommitted edits in
`packages/quereus/src/runtime/emit/subquery.ts` and `src/types/cast-semantics.ts` plus a new
sqllogic repro file — someone is mid-debug there. Rebuilding that workspace would compile a
third party's in-flight changes into the `dist` every sereus suite resolves through, so it
was deliberately not done, and the guard was not bypassed. Not filed as a pre-existing
failure: it is not a failing test, the cause is uncommitted work outside this repository,
and it self-heals the moment that workspace is rebuilt. The rule this ticket documents is
still covered by an executed suite — `quereus-plugin-sereus`'s schema e2e (no such guard)
drives the real constraints through the optimystic bootstrap transactor, and the
`cadre-core` specs pinning the rule passed in the prior ticket in this chain, against
unchanged source.

The real-network integration scenario was not executed either — it exceeds the agent idle
timeout, and it currently fails at strand bring-up on the separately-blocked
`control-db-convergence-optimystic-p2p` issue, already noted in `docs/architecture.md`.
