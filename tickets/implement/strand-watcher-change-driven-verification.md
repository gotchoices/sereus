description: The strand watcher (and, since, the pending-join retry loop and the strand removal check) now re-reads its tables only when they change, plus a slow fallback, instead of on a short timer, but the full test run and its before/after message-count measurement have not been done, because a sibling repository's build was out of date. Run them once that build is fresh.
architecture: docs/architecture.md#reactive-strand-management
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/pending-join-runner.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/pending-join-survives-restart.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-cli/test, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-20T08:11:34.500Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\strand-watcher-change-driven-verification.implement.2026-10-20T08-11-34-499Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
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

## Second arm: the pending-join runner

`pending-join-runner-woken-by-changes` made the pending-join retry loop (`pending-join-runner.ts`) run on a change to `CadreControl.JoinRequest`, `JoinSuccess`, `JoinFailure`, `OwnerKey` or `Revocation`, with a 10-minute backstop (`PENDING_JOIN_BACKSTOP_MS`), instead of re-reading every 30 s on every machine. Its implement pass ran `pending-join-runner.spec.ts` and `table-change-watch.spec.ts` (pure, 14/14), and `cadre-node-owner-signer.spec.ts` (boots a `CadreNode`, so it builds the runner's real five-table subscription), `control-pending-join.spec.ts` and `cadre-join-request.spec.ts` (13/13), all through a scratch vitest config without the global setup, against the stale optimystic `dist`. The full suites and the measurement are unrun.

When the guard passes, as part of the runs above:

- The `cadre` idle arm of the measurement is the one that shows this change. Before: the runner cost 24 of the 155 control reads in the idle minute (both nodes). Expected after: about 1 per 10 minutes per node, so none in a 60 s idle unless a watched table changes. If it does not fall, suspect the same self-wake as above: a pass's read of a never-written join table that lands a read-repair would wake one more pass.
- `pending-join-survives-restart` (integration): attempts run on their own timers, so it should not change; a new timeout there points at the start pass or the `kick` on owner-signer wiring.
- `control-founding-consult-budget.spec.ts`: `kick()` on owner-signer wiring now arms a 0 ms timer instead of starting a pass synchronously, and `settleStart` stops the runner right after; the `genesis` phase can therefore lose the runner's reads. Record any move with this as its reason.

## Third arm: the strand revocation enforcer

`strand-revocation-enforcer-woken-by-membership-changes` made each closed strand's revoked-peer enforcer (`strand-revocation-enforcer.ts`) re-read `Strand.Member` and `Strand.MemberPeer` when they change, with a 5-minute backstop (`DEFAULT_REVOCATION_BACKSTOP_MS`), a 30 s retry after a failed read or hang-up, and a 30 s follow-up on a strand with more bound machines than its cluster size, instead of re-reading every 30 s. It starts when the strand's database is published, not at runtime build. Its implement and review passes ran the touched cadre-core specs, the full cadre-core suite, both removal scenarios and the strand measurement only through scratch configs without the global setup, against the stale optimystic `dist`. On 2026-10-19 the guard also named `@optimystic/db-p2p` stale.

When the guard passes, as part of the runs above:

- `strand-removal-cuts-network` (3 tests). Test 2 is the end-to-end proof of the change-driven route: the removed machine runs the production schedule and must see `strand:revoked` within 60 s with no refresh call.
- `strand-party-removal-via-formation-e2e`, at least three runs under `DEBUG='sereus:cadre:strand-revocation,sereus:cadre:strand-membership-reconciler'`. The implement pass saw test 1 fail 1 of 4 runs (the removed party's machines already disconnected before join[0]'s explicit refresh) and test 2 fail 1 of 3 (a 120 s timeout waiting for `strand:rejoin-blocked`), causes not established. The review then made `autoRefresh: false` (the harness's `revocationSuspended`) turn off the retry and wide-strand follow-up too, which removes the one way this change could cut a suspended machine early. A test 1 failure that recurs now is not that; a test 2 timeout with only the start refreshes in the enforcer log points at the reconciler, not the enforcer.
- The `strand` idle arm of the measurement. Informational runs saw the enforcer's idle share fall to zero (baseline 18 idle sync streams, all from the enforcer). If it does not fall, suspect the read-repair self-wake described by the `NOTE:` on `StrandRevocationEnforcer.subscribe`.

## If nothing is done

The change stays on `master` unverified, and the next person to run the suites after optimystic rebuilds meets any regression without knowing which change caused it.
