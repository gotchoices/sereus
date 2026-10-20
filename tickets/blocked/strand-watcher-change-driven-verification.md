description: The strand watcher now re-reads its tables only when they change (plus a 5-minute fallback) instead of every 5 seconds, but its full test run and its before/after message-count measurement have not been done, because a sibling repository's build was out of date. Run them once that build is fresh.
architecture: docs/architecture.md#reactive-strand-management
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-cli/test, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts
----
**Blocked: dependency outside this repo.** Unblocks when `../optimystic`'s `@optimystic/db-core` dist is rebuilt by its own project, so the stale-build guard in `test-harness/build-freshness.ts` passes. On 2026-10-19 `packages/db-core/src/collection/collection.ts` was committed at 12:57 (optimystic `tess: agent error on a-collection-open-reads-its-log-ends-once — added resume note`, a partial edit from an interrupted optimystic ticket) and the dist was last built at 10:59. Per `tickets/rules/sibling-repos.md` nobody here builds it. When the guard passes, move this ticket to `implement/`.

## What needs verifying

`ticket(implement): strand-watcher-woken-by-control-changes` replaced the strand watcher's 5-second polling with runs woken by changes to `CadreControl.Strand` and `CadreControl.JoinedStrand`, its own retry timers, and a 5-minute backstop (`strandWatchInterval`, default now 300000). Its review checked the code by reading it and ran only the three suites that load no optimystic code (`strand-watcher`, `strand-watcher-filters`, `table-change-watch`; 34/34 pass). Every suite that boots a `CadreNode` is unrun.

Run, in this order:

- Build `cadre-core` and `cadre-cli` (their dist is stale only because of this repo's own edits).
- `yarn workspace @serfab/cadre-core test` (the watcher runs inside every `CadreNode` spec). Watch in particular `discovered-strands-late-subscriber`, `strand-unpublish`, `control-founding-consult-budget`, `joined-strand-store`, `cadre-node`, `types`.
- `yarn workspace @serfab/cadre-cli test` (`config-validation.spec.ts` checks `example.cadre.yaml`; `env-names.spec.ts` reads `docker/env.example`).
- The integration scenarios that pass no `strandWatchMs`, which now converge only through change events, the watcher's own retries, or the 5-minute backstop.
- The measurement, both idle arms, recorded before/after in this ticket's successor. The baseline is in the doc comment of `message-cost-accounting.integration.ts`, which must not be edited:
  `MESSAGE_COST_MEASURE=1 MESSAGE_COST_CASE=strand yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`
  `MESSAGE_COST_MEASURE=1 MESSAGE_COST_CASE=cadre yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`

## What a failure would mean

- **Idle reads do not fall, or rise.** Expected: the strand case's idle gets drop by about 48 and the cadre case's idle `sync` count drops substantially. If not, suspect a run that wakes the next one: the change subscription hears read-repair landings, so a watcher read of `Strand`/`JoinedStrand` on a two-machine cadre that lands a repair would wake another run. A second suspect is a `JoinedStrand` read that keeps failing (`JoinedStrandSession.lastReadPartial()` stays true), which re-runs the watcher on its read-retry ladder, capped at 60 s.
- **A scenario newly times out waiting for a strand on a sibling machine.** The cause is a change the subscription did not report (see `docs/architecture.md` → "Table change subscriptions" → "What it does not hear"), not a reason to shorten the default backstop.
- **`control-founding-consult-budget.spec.ts` moves.** Record the measured figure and the reason; do not just raise the budget. What is new during founding is a watcher run on any `Strand`/`JoinedStrand` change.

## If nothing is done

The change stays on `master` unverified, and the next person to run the suites after optimystic rebuilds meets any regression without knowing which change caused it.
