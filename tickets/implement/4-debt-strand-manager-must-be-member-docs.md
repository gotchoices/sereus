description: The rule that a group's admin must also be one of its members is now enforced in code, but two design documents still tell readers the opposite — fix those, fix two stale test comments in other packages, and run the type and lint checks that were never run against the change.
prereq: debt-strand-manager-must-be-member-tests
files: docs/strands.md (208-214, 240-242, 197-200), docs/architecture.md (612, 580), packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts (~278), packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts (~324, ~333)
difficulty: easy
----

# Docs + out-of-package call sites for `Manager.MemberExists`

The schema constraint and the `admitManager` writer landed already (see
`debt-strand-manager-must-be-member-tests` for exactly what). This ticket carries the
paperwork half: two docs that still state the OLD rule, two stale test comments in other
packages, and the type/lint checks nobody has run against the change.

## The rule, stated once

A `Strand.Manager` row may only exist for a key that also holds a `Strand.Member` row.
Enforced from both sides:

- insert side — `Manager.MemberExists` (`schemas/strand.qsql:379-381`), `check on insert`,
  reading the LIVE `Member` table so an admit-then-promote in ONE transaction passes.
- delete side — `Member.NotAManager` (`schemas/strand.qsql:198-200`), which refuses to
  un-member a key that still holds a `Manager` row.

Together the invariant is total. `packages/cadre-core/src/strand-membership-writer.ts`
exports `admitManager({ byManagerKeyPair, newManagerKey })` — admit + promote in one
transaction, the flow for a key that is not in the strand yet; `addManager` alone promotes
a key that is already a member.

Not fixed, and must not be claimed as fixed: two partitioned nodes (one promoting X, one
removing X's `Member` and `Manager` rows) can each pass locally and converge to a `Manager`
row with no `Member` row. Recorded as a `NOTE:` on the constraint itself.

## Docs to correct

**The line numbers in the parent ticket were wrong** — it cited `docs/strands.md ~612`,
but that file is only 272 lines and the `~612` text is in `docs/architecture.md`. Verified
locations:

- **`docs/strands.md:208-214`** — a whole paragraph opening "Being a manager does not
  require being a member: a key with no `Member` row can still be promoted…" and closing
  "Whether managers should be required to be members is tracked separately as
  `debt-strand-manager-must-be-member`." This is now FALSE end to end. Replace it with the
  enforced rule, in the same plain-language register as the surrounding bullets (that
  section is written for a reader deciding, not implementing — no constraint names in the
  prose beyond what is already there), and mention that admitting-and-promoting in one step
  is supported.
- **`docs/strands.md:240-242`** — the "A manager must resign before losing membership"
  bullet under *Removing Members*. Pair it with the new insert-side half so the invariant
  reads as total rather than one-directional.
- **`docs/strands.md:197-200`** — already states the `Header` → `Member` → `Manager`
  bootstrap order and that seating the manager first is rejected. Check the wording still
  holds now that the rejection comes from `MemberExists` on EVERY insert, not only from the
  bootstrap branch's gate.
- **`docs/architecture.md:612`** — the `addManager` bullet in the strand-writers list ends
  with "(The `Manager` table has **no** `MemberExists` constraint, so a manager key need not
  also be a `Member` row — tracked as `debt-strand-manager-must-be-member`.)" Delete that
  parenthetical, state the enforced rule, and add a sibling **`admitManager`** bullet.
- **`docs/architecture.md:580`** — the anti-replay paragraph claims "a manager holding no
  `Member` row can add members and promote managers but cannot revoke, clear a peer
  binding, or resign (all of those file tombstones — see
  `debt-strand-manager-must-be-member`)". That state is now unreachable. Correct it — the
  tombstone-filing-is-a-member-action fact is still true and worth keeping; what changed is
  that no manager can be a non-member, so the consequence no longer bites. This site was
  NOT listed in the parent ticket.

A repo-wide grep for `debt-strand-manager-must-be-member` outside `tickets/` hits exactly
`docs/architecture.md:580` and `docs/strands.md:214`. Both are above; no other slug
references need retiring.

## Other packages

- **`packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`** — the
  closed-strand cases (~188, ~212) seat `Member 'm1'` first and should pass unchanged. The
  OPEN-strand `OnlyClosed` case (~278) still rejects, but now for two reasons (`OnlyClosed`
  AND `MemberExists`, since the sibling `Member` insert is rejected too) — its comment
  claims the insert "would otherwise satisfy its bootstrap branch", which is now wrong. Fix
  the comment. **This spec has not been run since the schema change** — run
  `yarn workspace @serfab/quereus-plugin-sereus test 2>&1 | tee /tmp/plugin-test.log`.
- **`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`**
  — ~324 promotes the joiner (already a member — expect no change); ~333's negative case
  promotes a fresh key and still rejects, but check whether its assertion names a REASON and
  correct it if so. Real-network scenarios: NOT agent-runnable inside the 10-minute idle
  timeout. Update the source, do not run it, and note the deferral in the review handoff.

## Validation owed

- `yarn typecheck` and `yarn lint` — NEITHER has been run against any of this work
  (schema, writer, or tests).
- `yarn workspace @serfab/quereus-plugin-sereus test` — only the drift spec has been run.
- The full `@serfab/cadre-core` suite is `debt-strand-manager-must-be-member-tests`' job;
  if that ticket's handoff says it went green, do not re-run it here.

## TODO

- Fix the `OnlyClosed` comment in the plugin e2e spec; run the plugin test suite streamed
  (`… test 2>&1 | tee /tmp/plugin-test.log`).
- Update the integration-tests scenario source; do NOT run it.
- `yarn typecheck`, `yarn lint`.
- Rewrite the five doc sites above.
