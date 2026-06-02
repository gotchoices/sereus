---
description: Quereus-internal regression test added for deferred CHECK constraints that reference `new.<col>` on DELETE (e.g. `coalesce(new.x, old.x)`). Guards the "No row context found for column …" bug fixed in `quereus-cadrepeer-delete-no-row-context`, independent of sereus. The test artifact lives in the ../quereus repo (a SEPARATE git repo) and is currently UNTRACKED there — it must be committed in quereus, not sereus.
files: ../quereus/packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic, ../quereus/packages/quereus/src/runtime/emit/delete.ts, ../quereus/packages/quereus/src/planner/building/delete.ts
---

## What landed

A new sqllogic regression test in the quereus repo:

- **`../quereus/packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic`** — exercises a deferred CHECK constraint that fires `on delete` and references `coalesce(new.<col>, old.<col>)`. This is the quereus-local twin of the sereus `CadrePeer` `AuthorizedInsert` check (`coalesce(new, old).PeerId`) that originally surfaced the bug.

No production code changed. The DELETE plan-tree fix (`runtime/emit/delete.ts` 2N expansion + `planner/building/delete.ts` re-wiring) already landed under `quereus-cadrepeer-delete-no-row-context`; this ticket only adds the missing regression coverage in the repo where the bug lived.

## ⚠️ Cross-repo commit caveat (read first)

The deliverable is in **`../quereus`**, which is a **separate git repository** from sereus (linked via `resolutions` in the root `package.json`). The sereus tess runner commits only sereus-repo changes — i.e. this ticket's stage move. **The `.sqllogic` file is an untracked file in the quereus repo and will NOT be committed by the sereus runner.** A human (or a quereus-side commit) must `git add`/commit it in `../quereus`. Current quereus `git status` shows it as `?? packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic`.

(Note: the quereus working tree also has unrelated, pre-existing uncommitted WIP in `foreign-key-builder.ts`, `foreign-key-actions.ts`, `lens-fk-discovery.ts` — those are NOT part of this ticket; do not bundle them.)

## How the test reproduces the bug

The constraint is auto-deferred because its expression contains a subquery (quereus auto-defers any CHECK whose expression has a subquery or a `committed.*` ref — see `planner/building/constraint-builder.ts:163-174`). Schema:

```sql
create table registry (rkey text primary key);
create table guarded (
  id integer primary key,
  rkey text,                          -- NON-PK, so NEW lands in a plain flat-row slot
  constraint key_registered check on insert, delete (
    exists (select 1 from registry r where r.rkey = coalesce(new.rkey, old.rkey))
  )
);
```

On DELETE the flat row's NEW section is all-NULL, so `coalesce(new.rkey, old.rkey)` falls back to `old.rkey`. Pre-fix, the DELETE plan ran `ConstraintCheckNode` against the bare N-column source row, so resolving the NEW attribute (flat index `n..2n-1`) indexed past the row and threw `No row context found for column rkey`.

## Use cases covered (the test's four blocks)

1. **Positive DELETE** — insert `(1,'alpha')` (registry has `'alpha'`), `begin; delete …; commit;`, assert `count(*) = 0`. This is the exact scenario that threw pre-fix.
2. **insert→delete→insert cycle** — re-insert the same `(1,'alpha')` after the delete and read it back, mirroring the sereus regression test's re-authorize step.
3. **Negative DELETE (anti-vacuous guard)** — drop `'alpha'` from `registry` in the same txn, then delete the guarded row; the deferred check now misses and rejects at commit (`-- error: CHECK constraint failed: key_registered`). This proves the check genuinely *fires* on DELETE and that NEW/OLD resolve to a real value — otherwise block 1 could pass vacuously if DELETE silently skipped the check.
4. **Rollback verification** — after the failed commit, assert both `guarded` and `registry` rows survived (whole-txn rollback).

## Validation performed

| Check | Result |
| --- | --- |
| `node test-runner.mjs --grep "43.2-deferred-check-new-on-delete"` (memory mode) | **1 passing** |
| Same, with `runtime/emit/delete.ts` temporarily reverted to a passthrough N-row | **1 failing** — `No row context found for column rkey` at the DELETE block, then restored via `git checkout` and confirmed passing again |

The revert/restore proves the test is a real guard, not a vacuous pass.

## Known gaps / things for the reviewer to scrutinize

- **Store-mode not executed.** The file deliberately omits `using memory`, so the `--store` (LevelDB) logic run *will* include it; I only ran the **memory** suite this pass. The fix is plan-tree-level (backend-agnostic) and the analogous deferred-subquery file `29-constraint-edge-cases.sqllogic` runs in both modes, so I expect it to pass — but it is unverified here. A reviewer with a quick LevelDB run could confirm (`node test-runner.mjs --store --grep "43.2-deferred-check-new-on-delete"`).
- **Full logic suite not re-run.** I ran only the new file, not all ~3647 logic assertions. Rationale: the change is purely additive — one self-contained file that creates a fresh `db` per `beforeEach` and drops its own tables — so cross-file interference is not possible; and the quereus tree has unrelated WIP that could produce noise. If the reviewer wants belt-and-suspenders, run the whole `logic.spec.ts` (mindful that any FK-related failures likely stem from the pre-existing WIP, not this file).
- **Single deferral mechanism.** Deferral here is triggered by a subquery (matching the sereus bug). An immediate (non-deferred) `check on delete` referencing `new.<col>` would *also* have hit the same pre-fix error (both go through `ConstraintCheckNode`), but that variant is not separately asserted. Optional follow-up, not blocking.
- **Naming.** Placed at `43.2-…` next to `43-transition-constraints` / `43.1-notnull-or-conflict`; `43.2` was free. If quereus has a stronger convention for constraint-on-delete tests, the reviewer may prefer to renumber.

## Out of scope (unchanged)

- The DELETE plan-tree fix itself (already landed).
- The sereus-side `seed-bootstrap.spec.ts` integration coverage (stays as-is).
