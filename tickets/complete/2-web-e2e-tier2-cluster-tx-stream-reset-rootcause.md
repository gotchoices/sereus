---
description: COMPLETE — Reviewed the cluster-tx stream-reset root-cause fix. `ClusterMember.handleConsensus` no longer throws (resetting the cluster stream → `StreamResetError` → `Some peers did not complete`) when a member reaches consensus on a commit/pend it cannot apply locally (missing pend / ahead-stale). Post-consensus local-execution divergence is now logged + tolerated via `applyConsensusOperation`; genuinely unexpected thrown faults still propagate. Verified: build (tsc exit 0), full db-p2p suite 502 passing / 8 pending / 0 failing incl. 5 new divergence tests, and failing-first confirmed (3 fail on reverted code). Review minor findings fixed inline (honest justification comment, docs); the broad convergence/under-replication gap (16/16 NOT met) stays correctly deferred to the filed follow-up fix ticket, now with one added reconciliation note.
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/test/cluster-consensus-divergence.spec.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/docs/internals.md, tickets/fix/web-e2e-tier2-cross-tab-convergence-under-replication.md
---

## Summary of the work reviewed

`ClusterMember.handleConsensus` (in `../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`)
previously executed each consensus-approved operation against local storage and
**threw** on any local failure (`pend`/`commit` returning `success:false`, or
`StorageRepo.commit` throwing `Pending action <id> not found for block(s): …`).
Any throw propagated out of `handleConsensus`, resetting the cluster stream the
coordinator awaited and surfacing as `StreamResetError` → `Some peers did not
complete`.

The fix decomposes the loop into `applyConsensusOperation(...)` + a module-level
`isMissingPendingActionError(...)` classifier. Post-consensus the operation is
authoritative cluster-wide, so a *local* failure is divergence (member **ahead**
= stale `success:false`; member **behind** = missing pend, commit throws), now
**logged** (`cluster-member:consensus-{pend,commit}-diverged`) and **tolerated**.
`handleConsensus`'s try/catch still rolls back the executed marker and rethrows
genuinely unexpected *thrown* faults. New spec
`test/cluster-consensus-divergence.spec.ts` (5 tests) drives a real
`ClusterMember` + real `StorageRepo`/`MemoryRawStorage` to the consensus-execution
phase for each divergence condition.

## Review findings

### Verification performed (all independently re-run by the reviewer)
- **Build** — `yarn workspace @optimystic/db-p2p build` (tsc) exit 0, clean. Re-run
  after the reviewer's comment/doc edits: still exit 0.
- **Targeted spec** — `cluster-consensus-divergence.spec.ts`: **5 passing**.
- **Failing-first claim CONFIRMED** — stashed the `cluster-repo.ts` fix and re-ran:
  **3 failing / 2 passing** (the happy-path-commit and unexpected-fault tests pass
  regardless, as expected). The fix is genuinely load-bearing for the 3 divergence
  tests.
- **Full suite** — `test/**/*.spec.ts`: **502 passing / 8 pending / 0 failing**.
  Matches the handoff; no regressions.
- **Lint** — optimystic has no real lint (`"lint": "echo 'Lint not configured…'"`);
  `tsc` is the type-check gate and it passes. Noted, not actioned.

### Correctness / logic
- **Classifier scope is safe.** `isMissingPendingActionError` (regex
  `/pending action .+ not found/i`) is only consulted inside the `commit` catch.
  Within `StorageRepo.commit` the only matching throw is storage-repo.ts:370
  (`…not found for block(s):`, the intended "behind" signal). The other two
  "pending action" sites — `get()`:121 (not reachable from commit) and
  internalCommit:452 (`…disappeared … within critical section`, no "not found")
  — do **not** match, so a real consistency fault still propagates. ✔
- **Promise-phase rejection claim is narrowly true.** `validatePendOperations`
  validates `pend` ops only (commits get no promise-phase validation), so the
  original comment slightly over-claimed; corrected inline. The substance holds:
  the tolerated cases are divergence, not invalidity.

### Findings & disposition

- **[minor — FIXED inline] Load-bearing justification comment over-claimed
  reconciliation.** The `applyConsensusOperation` JSDoc stated as fact that
  divergence "reconcile[s] through the normal sync / lazy read-repair path",
  but the implementer's own follow-up ticket establishes read-repair currently
  **cannot** recover an under-replicated block (no reachable peer holds the rev;
  `cluster-fetch:synced`=0). Rewrote the comment to mark reconciliation as the
  *intended-but-incomplete* path, cross-reference the follow-up, and clarify that
  the guarantee today is only "do not reset the stream". Also corrected the
  `validatePendOperations` (pend-only) scope.

- **[minor — FIXED inline] Stale docs.** `../optimystic/docs/internals.md`
  "Consensus Execution" described only the old behavior. Added a bullet
  documenting tolerate-don't-throw post-consensus divergence + the read-repair
  caveat and follow-up reference.

- **[minor — folded into existing follow-up ticket] Propagate-vs-tolerate keys
  off throw-vs-return, not failure nature.** A genuine `internalCommit` fault
  surfaces as `CommitResult.success:false` (with `reason`, no `missing`,
  storage-repo.ts:404) and is now tolerated like divergence, while the *same*
  fault thrown propagates — so the implementer's "no false tolerance / unexpected
  faults still propagate" claim has a hole for return-style failures. Not a new
  ticket and not safe to "fix" by re-throwing (that reintroduces the very
  stream-reset this ticket removes); the principled fix is reconciliation, which
  is exactly the deferred convergence work. `CommitResult` already distinguishes
  the cases (`missing` ⇒ divergence; bare `reason` ⇒ genuine failure). Documented
  in the code CAVEAT comment + docs, and appended as an explicit sub-task to
  `tickets/fix/web-e2e-tier2-cross-tab-convergence-under-replication.md`.

- **[minor — noted, no action] `pend()` can throw, untolerated, post-consensus.**
  `StorageRepo.pend` can throw `Missing action <id> for block <id>`
  (storage-repo.ts:222) when an ahead member lacks a historical transaction blob;
  the `pend` branch has no try/catch, so this would still propagate (stream
  reset). It is a corrupted/partial-state edge (not the cohort-drift path the fix
  targets) and is arguably a genuine fault that *should* propagate; left as-is,
  flagged for awareness. Not covered by tests.

- **[minor — noted, no action] String-matching error classifier is brittle.**
  `isMissingPendingActionError` depends on storage-repo's exact message wording.
  It **fails safe** (a wording change makes the error propagate, not silently
  swallow), so acceptable now; a typed/coded storage error would be more robust
  but touches the storage error contract — out of scope, low value.

### Test coverage assessment
- Happy path ✔, both divergence edges (ahead/behind, commit + pend) ✔, error-path
  (unexpected thrown fault propagates + executed-marker rollback) ✔, regression
  (failing-first) ✔. Genuine-`internalCommit`-failure-as-`success:false` and the
  `pend()`-throws edge are **not** covered — both tracked above (former in the
  follow-up ticket).

### Empty categories (explicit)
- **Resource cleanup** — nothing new to clean up; `executedTransactions` marker
  lifecycle (set-before-await, rollback-on-throw) is unchanged and correct. No
  finding.
- **Type safety** — `CommitResult` import added and used; `RepoMessage['operations'][number]`
  typing is precise; no `any` introduced. No finding.
- **DRY / modularity** — the extraction into `applyConsensusOperation` +
  classifier is a genuine improvement over the inline loop. No finding.

## Acceptance status (carried forward honestly)

The named root cause (the stream-reset throw) is **fixed and validated**. The
ticket's broader acceptance — "Tier-2 sweep 16/16 across 3 runs" — is **NOT met**:
the three multi-tab specs now fail on a *distinct* root cause (cross-tab
under-replication / convergence). That is correctly filed as
`tickets/fix/web-e2e-tier2-cross-tab-convergence-under-replication.md`
(prereq: this ticket), and is the proper place for the deferred work — the
reviewer concurs with deferring it rather than pulling the larger
active-reconciliation design into this fix.

## Provenance — code lives in the sibling `../optimystic` repo (UNCOMMITTED)

The runner commits **sereus** (ticket-file moves only). The actual code/doc
changes are in the separate **optimystic** working tree and must be committed
there or the fix is lost:
- `packages/db-p2p/src/cluster/cluster-repo.ts` (M — fix + reviewer comment edit)
- `packages/db-p2p/test/cluster-consensus-divergence.spec.ts` (new, 5 tests)
- `docs/internals.md` (M — reviewer doc update)

The `@optimystic/db-p2p` dist was rebuilt from source (tsc exit 0). cf. the open
`land-orphaned-cluster-error-envelope` backlog item for the same uncommitted-sibling
situation.
