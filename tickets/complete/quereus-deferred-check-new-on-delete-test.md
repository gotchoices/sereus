---
description: Quereus-internal regression test for deferred CHECK constraints that reference `new.<col>` on DELETE (e.g. `coalesce(new.x, old.x)`). Guards the "No row context found for column …" bug fixed in `quereus-cadrepeer-delete-no-row-context`, independent of sereus. Test-only change; the artifact lives in the ../quereus repo (a SEPARATE git repo) and remains UNTRACKED there — it must be committed in quereus, not sereus.
files: ../quereus/packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic, ../quereus/packages/quereus/src/runtime/emit/delete.ts, ../quereus/packages/quereus/src/planner/building/delete.ts
---

## Summary

A new sqllogic regression test landed in the quereus repo:

- **`../quereus/packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic`** — exercises a deferred CHECK constraint that fires `on insert, delete` and references `coalesce(new.rkey, old.rkey)`. This is the quereus-local twin of the sereus `CadrePeer` `AuthorizedInsert` check that originally surfaced the bug.

No production code changed. The DELETE plan-tree fix (`runtime/emit/delete.ts` 2N OLD/NEW expansion + `planner/building/delete.ts` re-wiring) already landed under `quereus-cadrepeer-delete-no-row-context`; this ticket only adds the missing regression coverage in the repo where the bug lived.

The test has four blocks: (1) positive DELETE — the exact pre-fix throw scenario; (2) insert→delete→insert cycle; (3) negative DELETE (anti-vacuous guard) that drops the registry row in the same txn so the deferred check genuinely fires and rejects at commit; (4) whole-transaction rollback verification. The table omits `using memory`, so it runs in both memory and store (LevelDB) modes.

## Review findings

### What was checked

| Aspect | Result |
| --- | --- |
| Memory-mode run (`test-runner.mjs --grep 43.2-…`) | **1 passing** |
| Store-mode (LevelDB) run (`--store --grep 43.2-…`) — flagged unverified by implementer | **1 passing** — gap closed, the fix is backend-agnostic as predicted |
| Non-vacuity: independently reverted `runtime/emit/delete.ts` to a passthrough N-row, re-ran | **failed** with exactly `No row context found for column rkey` at the DELETE block (logic.spec.ts:53), then restored via `git checkout` — confirmed `git status` clean and passing again |
| Fix is committed (not WIP) | `delete.ts` / `planner/building/delete.ts` are clean at HEAD; the 2N expansion in `delete.ts:16-25` is the exact code the test guards |
| Format/convention vs siblings (`43-transition-constraints`, `29-constraint-edge-cases`) | Consistent — `-- run`, `→ [...]`, `-- error: …` directives, bare-commit-without-begin in setup, self-cleanup via `drop table` all match house style |
| Naming (`43.2`) | Slot was free, sits correctly next to `43.1-notnull-or-conflict` / `43-transition-constraints` |
| Comment accuracy (NON-PK rkey, NEW at flat `n..2n-1`) | Accurate |
| Self-containment / cross-file interference | None — creates and drops its own tables; safe to add |
| Lint | N/A — the artifact is `.sqllogic`; quereus eslint globs only `src/**/*.ts` and `test/**/*.ts`. No TS changed. |

### Findings & disposition

- **No correctness, DRY, modularity, resource-cleanup, type-safety, or error-handling defects found.** The change is a single additive, self-cleaning test file; the handoff claims were all independently verified true (including the store-mode gap, which I closed — it passes).

- **(Flag, not a defect) The deliverable is untracked in a separate repo and is NOT committed by this run.** `../quereus` is a distinct git repository; the sereus tess runner commits only sereus-repo changes (this stage move). `packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic` remains `?? ` (untracked) in the quereus working tree. **A human or a quereus-side commit must `git add`/commit it in `../quereus`** for the regression guard to actually persist. I deliberately did not commit or stage it (review must not commit, and it is out-of-band for this repo) — flagging prominently here is the correct disposition. The quereus tree also carries unrelated pre-existing WIP (`foreign-key-*.ts`, `lens-fk-discovery.ts`, `lens-enforcement.spec.ts`, `docs/lens.md`) that must NOT be bundled with the test commit.

- **(Considered, declined — minor) Immediate (non-deferred) `check on delete` referencing `new.<col>` is not separately asserted.** Declined to file a ticket: the fix in `delete.ts` expands to 2N unconditionally and both deferred and immediate checks flow through the same `ConstraintCheckNode` after it, so the deferred block already exercises that code path. An immediate variant would be marginal redundant coverage of the same fix, not a distinct gap.

- **Full ~3647-assertion logic suite not re-run.** Neither implementer nor reviewer ran it; the change is additive and self-contained (fresh tables per block, dropped at end), so cross-file interference is impossible, and the quereus tree's unrelated WIP would inject noise. Running only the new file in both modes is sufficient and was done.

### Major findings → new tickets

None. No major findings; no new fix/plan/backlog tickets filed.

## Out of scope (unchanged)

- The DELETE plan-tree fix itself (already landed under `quereus-cadrepeer-delete-no-row-context`).
- The sereus-side `seed-bootstrap.spec.ts` integration coverage (stays as integration-level guard).
