----
description: Three cadre-core cost-budget specs trip their anti-vacuity FLOORS — the measured cost fell, it did not rise. Every one of them counts work done inside `@optimystic/db-core`, and that package's `dist` cannot be rebuilt to a stable point right now: a live runner in `../optimystic` is mid-implement on exactly the caching and block-floor code these specs measure (`block-floors.ts`, `cache-source.ts`, `transactor-source.ts`, `collection.ts`). The numbers cannot be re-baselined against a moving dependency, and until they settle there is no evidence any defect exists in this repo.
prereq: ../optimystic `review/1-refreshed-collection-caches-a-block-older-than-its-log-entry` committed and `@optimystic/db-core` building clean
files:
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts (expectWithinBudget ~line 502, expectPerCall ~line 523 — the floor and the exact per-call pin)
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (expectWithinBudget ~line 256 — the op floor)
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts (same failure shape; already owned by warm-restart-into-declared-schema-diverges-from-declaration)
  - ../optimystic/packages/db-core/src/transactor/block-floors.ts, src/transform/cache-source.ts, src/transactor/transactor-source.ts, src/collection/collection.ts (the in-flight edits)
  - packages/quereus-plugin-sereus/src/cached-storage.ts (this repo's write-through cache over raw storage — the other side of the same cost path)
difficulty: small once upstream settles (re-measure and re-baseline), unknown if the drop turns out to be a real upstream regression
repro: blocked — cannot be measured against a stable build
----

# Blocked (b): the dependency under measurement is being edited while we measure

**Category (b) — the moving part is outside this repo.** Nothing here is broken that we can
demonstrate. The specs measure `@optimystic/db-core`'s consult and raw-storage traffic, and that
package's source is being rewritten as these words are typed.

# The failing tests

Reported from a `yarn workspace @serfab/cadre-core test` run during
`review/retire-the-stream-reset-retry-fingerprint` (a documentation-only ticket — its diff and the
implement commit `5e4494a` it reviews touch comments, prose and ticket files only, so neither pass
went near this subsystem).

`packages/cadre-core/test/control-founding-consult-budget.spec.ts`, both tests:

- `control database founding, cohort consult and commit budget > stays within its consult and commit budgets from cold start through an idle reconcile pass`

  ```
  AssertionError: genesis issued only 7 cohort consults, far below (measured 14 consults over 3 blocks
  and 4 commits on 2026-09-15; …).
  This run's consults per block: default/cadrecontrol/OwnerKey×3,
  default/cadrecontrol/OwnerKey/index/_uniq_7.stampid×3, default/cadrecontrol/Revocation×1.
  : expected 7 to be greater than 7
  ```

- `Revocation ledger marker, cohort consult budget > once the marker is filed, the membership reads, a control insert and a reconcile pass stop re-consulting`

  ```
  AssertionError: before the marker, queryRevokedStamps('CadrePeer'): per-call consults moved from
  [2, 2, 2, 2, 2, 2] (measured 2026-09-15) to [1, 1, 1, 1, 1, 1].
  ```

`packages/cadre-core/test/strand-solo-write-budget.spec.ts`:

- `solo strand write budget > stays within its operation budgets`

  ```
  AssertionError: solo select issued only 0 raw-storage operations, far below the measured 2 ops over
  1 distinct blocks on 2026-09-14.
  This run, calls/distinct-blocks by method: .: expected 0 to be greater than 1
  ```

`packages/cadre-core/test/control-start-storage-op-budget.spec.ts` failed in the same run with the
same shape (`expected 13 to be greater than 22`). It is **already owned** by
`fix/warm-restart-into-declared-schema-diverges-from-declaration` and is not re-filed here — but it
is listed above because one cause plausibly covers all three files, and whoever unblocks this should
re-measure that one at the same time.

# Why this is blocked rather than fixed

Every one of these is a **floor** trip, not a budget trip. The floor is the anti-vacuity guard: half
the figure measured when the budget was set. Tripping it means the measured cost went *down* —
14 → 7 consults, 2 → 1 consults per call, 2 → 0 raw-storage ops, 22 → 13 ops. That is either a
genuine improvement to re-baseline against, or the counter losing sight of the path. Both readings
require a dependency that holds still.

It does not. Triage on 2026-09-17 ran the suite's own build-freshness guard first, which refused the
run:

```
Stale build detected: these tests run real compiled output.
  - @optimystic/db-core: dist is stale — src was edited after the last build.
```

Rebuilding `@optimystic/db-core` failed on its own test sources —

```
test/block-floors.spec.ts(66,24): error TS2339: Property 'checkOnly' does not exist on type 'BlockFloors'.
```

— because a live runner in `../optimystic` is mid-implement: `git status` there gained two more
modified files between two `git status` calls about a minute apart, and the source mtimes
(`13:50:09`, `13:50:17`, `13:50:30`) were within seconds of the clock each time it was read. The
`BlockFloors` API is being reshaped right now (`block-floors.ts`, −36 net lines, `checkOnly`
removed), so the package's own spec no longer compiles against its source. `tsc` emitted `dist` for
`src` before failing on those test files, so `@optimystic/db-core`'s `dist` now carries a partial
build of that mid-edit source; a re-run tripped the freshness guard again anyway, because `src` had
moved on once more.

The in-flight work is `../optimystic` `review/1-refreshed-collection-caches-a-block-older-than-its-log-entry`,
which touches `block-floors.ts`, `cache-source.ts`, `transactor-source.ts` and `collection.ts`:
block caching and read-floor logic, which is precisely what a "consult" and a "raw-storage op" count.
A cache that now answers a read locally removes exactly the consults and ops these floors miss.
So the most likely explanation for all four assertions is the upstream change under construction,
observed through a half-built `dist` — not a defect in this repo.

Measuring anyway would have produced a number attributed to sereus that actually describes another
repo's uncommitted mid-implement state, which is the failure mode `tickets/.pre-existing-known.md`
already records for `control-write-hears-zero-approvals-from-healthy-trio` (2026-09-17). It was not
done.

# Unblock condition

`../optimystic`'s `1-refreshed-collection-caches-a-block-older-than-its-log-entry` is committed and
`yarn workspace @optimystic/db-core build` succeeds from a clean tree there. Then, from
`packages/cadre-core`:

```
npx vitest run test/control-founding-consult-budget.spec.ts test/strand-solo-write-budget.spec.ts test/control-start-storage-op-budget.spec.ts
```

The suite's `global-setup.ts` guard will confirm the dist is fresh before anything is measured; do
not bypass it, and do not rebuild a sibling package whose tree is dirty.

Three outcomes:

1. **All green.** The floors were tripped by a half-built dependency. Remove the ledger entries,
   move this to `complete/`, record no defect.
2. **Still floor-tripping, and the new numbers are stable across repeated runs.** The upstream cache
   genuinely removed the work. Re-baseline each budget to the new measurement — *tighten*, as each
   spec's own message instructs — and stamp the new `MEASURED_ON` date with the optimystic commit
   that changed the cost. This is the expected outcome.
3. **Numbers vary run to run, or a count reaches 0.** A zero count (`solo select … 0 raw-storage
   operations`) can also mean the counter stopped seeing the path — the spec messages name the
   candidates: a renamed or bypassed `CoordinatorRepo` method, a repo attributed to the wrong label,
   or the provider branch on `strandId` no longer routing through the storage the spec hands it.
   Confirm the path is still instrumented *before* re-baselining, or the budget will be re-pinned to
   a measurement of nothing.

# Design constraints

- **Do not widen a budget to make a floor pass, and do not delete the floor.** The floor exists
  because a ceiling alone cannot distinguish "cheap" from "not measured". Both halves stay.
- **Re-baselining is a measurement, not a guess.** Each spec carries a `MEASURED_ON` date and prose
  naming what was counted. A new figure must come with a new date and the upstream commit that moved
  it; `expectPerCall`'s array is pinned exactly on purpose (the shape of the per-call sequence is the
  signal, not its sum), so it is replaced with a newly observed sequence, never loosened to a range.
- **These are cost specs, not behaviour specs.** A re-baseline must not change what the scenarios do.
  If a scenario has to change to make the numbers reachable, that is a different ticket.
- No cross-cutting obligations are triggered by the re-baseline itself: no determinism edition bump,
  no byte-format vector, no golden fixture, no migration. Outcome 3 could turn into an upstream
  regression ticket, which would have its own.
