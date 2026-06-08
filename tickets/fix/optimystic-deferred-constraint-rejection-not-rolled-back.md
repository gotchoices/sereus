description: A deferred (subquery-bearing) CHECK constraint that fails on a write throws correctly, but the optimystic local/bootstrap transactor does NOT roll back the violating row — it stays committed in storage. RBAC enforcement is therefore non-atomic for any constraint that references other tables.
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../quereus/packages/quereus/src/core/database-transaction.ts, schemas/strand.qsql, schemas/control.qsql
----

## Problem

Discovered while implementing `apply-strand-membership-schema`. In **bootstrap mode**
(optimystic `local` transactor, the mode the strand + RBAC integration tests run in), an
`insert` that violates a **deferred** CHECK constraint behaves wrong:

- The constraint **does** fire — `db.exec(...)` rejects/throws (good: the constraint is active).
- But the violating row is **left committed** — it is visible to subsequent reads in the same
  session **and survives a reopen of the same storage** (so it is persisted, not just a cache
  artifact).

A constraint is "deferred" when its expression contains a subquery or a `committed.*`
reference (Quereus `constraint-builder.ts` sets `needsDeferred = containsSubquery(...) ||
containsCommittedRef(...)`). **Immediate** CHECK constraints (no subquery — e.g. the sApp
RBAC fixture `simple-sapp.qsql`'s `AuthorizedWrite`, which references only `new`/`old`/
`context`) reject cleanly and leave no row, which is why existing RBAC coverage never hit this.

This matters because **every cross-table authorization constraint is deferred**: the entire
`Strand` membership schema (`Member.Authorized` checks `Authority`/`ConsumedInvite`, all the
`OnlyClosed` checks read `Header`, `Invite.InviteValid` reads `Authority`, …) and the control
schema (`CadreControl.AuthorityKey.Authorized`, `Strand.Authorized`, `FormationUsage.*`) are
all subquery-gated. So a rejected unauthorized write currently still lands its row in
bootstrap mode, defeating the RBAC promise for any multi-table rule.

## Evidence / repro

Minimal repro (bootstrap mode, real `FileRawStorage`):

1. Apply the `Strand` schema; insert a closed `Header` and a founding `Member` (`m1`).
2. `insert into Strand.Member (Key) ... values ('m2')` with no authority context.
   - `Member.Authorized` is `(select count(1) from Member) <= 1 or exists(Authority…) or
     exists(ConsumedInvite…)` → with 2 members, a null authority key, and no consumed invite,
     it evaluates false. `db.exec` **throws** (constraint fired).
3. `select count(*) from Strand.Member` → returns **2**, not 1. Reopen the strand over the
   same storage dir → still **2**. The rejected `m2` row persisted.

Confirmed with a probe during `apply-strand-membership-schema`: `sessionCount=2
persistedCount=2`.

## Why it is a transactor-layer bug, not a schema bug

Quereus's own commit path is correct: `database-transaction.ts:commitTransaction` runs
`runDeferredRowConstraints()` BEFORE committing connections and, on failure, calls
`connection.rollback()` on every vtab connection and rethrows
(`database-transaction.ts:233-270`). So the membership schema constraints are wired right —
they evaluate and throw. The gap is that the optimystic vtab connection's `rollback()`
(`optimystic-module.ts:872` → `txnBridge.rollbackTransaction()`) does not actually discard the
already-staged/committed mutation from the local transactor's tree/storage. Networked-mode
behavior is **untested** here and may differ (consensus commit ordering); scope the
investigation to confirm both transactors.

## Desired behavior

A write rejected by ANY constraint (immediate or deferred) must leave the target table
unchanged — the statement's mutation is rolled back atomically with the throw, in both the
local/bootstrap transactor and the network transactor. After a rejected `insert`, `select
count(*)` (in-session and after reopen) must be unchanged.

## Acceptance tests

- Bootstrap mode: an `insert` rejected by a deferred (subquery) CHECK leaves row count
  unchanged, in-session and after reopen. (A focused version of the
  `apply-strand-membership-schema` rejection cases — see
  `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`, which currently asserts
  only that the write throws and documents this gap as the reason it cannot assert
  "table unchanged".)
- Same for an `update`/`delete` rejected by a deferred constraint.
- Regression guard that immediate-constraint rejection still leaves no row (already works).

## Notes for whoever picks this up

- The two repaired schemas that depend on this for real enforcement are `schemas/strand.qsql`
  (this ticket's sibling) and `schemas/control.qsql`.
- `strand-membership-lifecycle-population` (the follow-on that actually writes membership rows
  with real ed25519 signatures) needs atomic rejection-rollback to make its "unauthorized join
  is rejected" guarantees real, so this should land before or alongside enforcement work.
- Root-cause likely lives in `../optimystic` (`quereus-plugin-optimystic` transaction bridge /
  collection layering), so a fix may be an optimystic change surfaced through the `resolutions`
  link rather than a Sereus-only edit.
