description: The strand watcher, the pending-join retry loop and the strand removal check now re-read their tables only when those tables change, plus a slow fallback, instead of on a short timer. The core and command-line suites and about half the cross-machine scenarios now pass with these changes; the strand scenarios and the before/after message-count measurement are still unrun, waiting on a sibling repository's build.
architecture: docs/architecture.md#reactive-strand-management
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/pending-join-runner.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/pending-join-survives-restart.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-cli/test, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts
----
**Blocked: dependency outside this repo.** Unblocks when the stale-build guard in `test-harness/build-freshness.ts` passes again. At 2026-10-20 02:33 it refused `@optimystic/db-p2p`: `../optimystic` (HEAD `fe40f699`) had uncommitted edits made 02:30–02:33 to `packages/db-p2p/src` (`protocol-limits.ts`, `sync/protocol.ts`, `storage/block-archive.ts`, `sync/service.ts`, `repo/coordinator-repo.ts`, `index.ts`, `libp2p-node-base.ts`, and a new `repo/consult-round.ts`), and its dist was last built at 02:11:51. Per `tickets/rules/sibling-repos.md` nobody here builds it. When the guard passes, move this ticket to `implement/` and run only what *Still to run* lists.

## Done on 2026-10-20

These ran between 02:12 and 02:32 with the guard passing. `../optimystic`'s dist was built at 02:11:51 and no `db-p2p` or `db-core` source file was newer until 02:30, so every run below used a dist that matched optimystic's source (its `a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead`, committed 02:15 and reviewed 02:25).

- `cadre-core` and `cadre-cli` rebuilt at 02:12.
- `yarn workspace @serfab/cadre-core test`: 187 files, 2533 passed, 1 skipped (`key-store.spec.ts`'s `skipIf(win32)` file-mode test). This covers every spec the first section below names.
- `control-founding-consult-budget.spec.ts` measured exactly its pinned figures: cold start 41 consults / 33 blocks / 1 commit; genesis 20 / 19 / 34; `foundStrand` control 4 / 4 / 3 and strand 29 / 15 / 14; every per-call read 0. This does not show that the three changes left the figures unchanged. The pins were taken on 2026-10-20 (`control-membership-rows-cached-until-changed`, then `strand-founding-writes-batched`), after all three changes had landed on 2026-10-19 between 21:48 and 23:42. Comparing the counts with and without the changes would need a build that leaves them out, and that was not done.
- `yarn workspace @serfab/cadre-cli test`: 25 files, 295 passed, 1 skipped.
- Integration, run as `yarn vitest run <paths>` from `packages/integration-tests` so the global setup runs the guard: the four `test/` specs, the `test-harness/` specs, and these 33 scenario files, all passing: `app-joins-cadre-by-invitation`, `basic-connectivity`, `blind-relay-phone-to-phone-e2e`, `cadre-host-bootstrap`, `cadre-host-join-by-invitation`, `cadre-host-join-by-qr`, `cadre-host-orchestrator-lifecycle`, `cadre-host-origin-guard`, `cadre-host-sse-events`, `cadre-host-update-notify`, `cadre-invite-any-member`, `cadre-invite-row-unreplicated`, `control-bring-up-quiet-period`, `control-cohort-auto-convergence`, `control-cohort-cold-start-retry`, `control-cohort-edge-carries-data`, `control-cohort-harness-helpers`, `control-cohort-three-node-isolation`, `control-concurrent-same-pk-insert`, `control-concurrent-unique-column-race`, `control-cross-machine-unique-column`, `control-db-two-node-convergence`, `control-delete-while-alone-convergence`, `control-divergent-repair-yardstick`, `control-offline-read-after-restart`, `control-stream-authz`, `control-write-while-alone-convergence`, `control-write-degraded-cohort-member`, `convergence-stress`, `deliver-seed-cross-network`, `enrollment-e2e`, `happy-path`, `joiner-first-commit-over-slow-relay` (3 tests).
- The run that was working this ticket stopped at 02:32 in the middle of its fifth integration batch, with no error in its log. `machine-removal` and `membership-connection-gater` were in that batch and have no result; that is not a failure.

Logs: `tickets/.logs/strand-watcher-change-driven-verification.{cadre-core,cadre-cli,it-b1,…,it-b5}.log` (pruned after 14 days; the figures above are the record).

## Still to run

- The 43 scenario files not listed above, in batches of a few files: `harness-party-control-cohort`, `harness-topology`, `machine-removal`, `membership-connection-gater`, `message-cost-accounting` (default arm), `multi-party-sync`, `multi-party-workflows`, `node-claim-by-phone`, `owner-anchor-follows-owner-changes`, `owner-grant-backup-recovery`, `owner-grant-without-machine`, `pending-join-survives-restart`, `provider-container-claimed-by-phone`, `provider-container-joins-by-invitation`, `push-wake-e2e`, `rbac-signed-write`, `relay-only-control-addr`, `relay-round-trip-measure`, `relayed-dial-cost-by-latency`, `seed-bootstrap`, `strand-addr-seed-convergence`, `strand-always-on-replica-hosts-cross-party-join`, `strand-always-on-replica-survives-phone-loss`, `strand-chat-participants-converge`, `strand-circuit-same-party-e2e`, `strand-creation`, `strand-formation-concurrent-redemption`, `strand-formation-cross-party-seed`, `strand-formation-e2e`, `strand-late-cadre-join`, `strand-membership-closed-strand-e2e`, `strand-membership-second-machine`, `strand-moves-between-cadres`, `strand-party-removal-via-formation-e2e` (three runs, see the third section below), `strand-reactivity-wakes-watchers`, `strand-read-cost-over-relay`, `strand-reattach-first-sync-measure`, `strand-relay-only-restart-reconverges`, `strand-removal-cuts-network`, `strand-two-party-two-machine`, `strand-unpublish-sibling-convergence`, `strand-workload-on-a-phone-link`, `websocket-chat`.
- Both idle arms of the measurement (commands below).
- Re-check the guard before each batch. `../optimystic` builds its own dist while it works, so a batch that spans one of its rebuilds runs part of its files against different code; compare `packages/db-p2p/dist/src/index.js`'s modification time before and after each batch, and re-run any batch where it changed.
- If `cadre-core`, `cadre-cli`, `cadre-host` or `quereus-plugin-sereus` source has changed since 02:12, rebuild them first; the guard names whichever is stale.

## What needs verifying

`ticket(implement): strand-watcher-woken-by-control-changes` replaced the strand watcher's 5-second polling with runs woken by changes to `CadreControl.Strand` and `CadreControl.JoinedStrand`, its own retry timers, and a 5-minute backstop (`strandWatchInterval`, default now 300000). Its review checked the code by reading it and ran only the three suites that load no optimystic code (`strand-watcher`, `strand-watcher-filters`, `table-change-watch`; 34/34 pass).

The parts that remain are the integration scenarios that pass no `strandWatchMs`, which now converge only through change events, the watcher's own retries, or the 5-minute backstop, and the measurement, both idle arms, recorded before/after in this ticket's successor. The baseline is in the doc comment of `message-cost-accounting.integration.ts`, which must not be edited:
  `MESSAGE_COST_MEASURE=1 MESSAGE_COST_CASE=strand yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`
  `MESSAGE_COST_MEASURE=1 MESSAGE_COST_CASE=cadre yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`

## What a failure would mean

- **Idle reads do not fall, or rise.** Expected: the strand case's idle gets drop by about 48 and the cadre case's idle `sync` count drops substantially. If not, suspect a run that wakes the next one: the change subscription hears read-repair landings, so a watcher read of `Strand`/`JoinedStrand` on a two-machine cadre that lands a repair would wake another run. A second suspect is a `JoinedStrand` read that keeps failing (`JoinedStrandSession.lastReadPartial()` stays true), which re-runs the watcher on its read-retry ladder, capped at 60 s.
- **A scenario newly times out waiting for a strand on a sibling machine.** The cause is a change the subscription did not report (see `docs/architecture.md` → "Table change subscriptions" → "What it does not hear"), not a reason to shorten the default backstop.

## Second arm: the pending-join runner

`pending-join-runner-woken-by-changes` made the pending-join retry loop (`pending-join-runner.ts`) run on a change to `CadreControl.JoinRequest`, `JoinSuccess`, `JoinFailure`, `OwnerKey` or `Revocation`, with a 10-minute backstop (`PENDING_JOIN_BACKSTOP_MS`), instead of re-reading every 30 s on every machine. Its own suites now pass in the full `cadre-core` run above.

Still to check:

- The `cadre` idle arm of the measurement is the one that shows this change. Before: the runner cost 24 of the 155 control reads in the idle minute (both nodes). Expected after: about 1 per 10 minutes per node, so none in a 60 s idle unless a watched table changes. If it does not fall, suspect the same self-wake as above: a pass's read of a never-written join table that lands a read-repair would wake one more pass.
- `pending-join-survives-restart` (integration): attempts run on their own timers, so it should not change; a new timeout there points at the start pass or the `kick` on owner-signer wiring.

## Third arm: the strand revocation enforcer

`strand-revocation-enforcer-woken-by-membership-changes` made each closed strand's revoked-peer enforcer (`strand-revocation-enforcer.ts`) re-read `Strand.Member` and `Strand.MemberPeer` when they change, with a 5-minute backstop (`DEFAULT_REVOCATION_BACKSTOP_MS`), a 30 s retry after a failed read or hang-up, and a 30 s follow-up on a strand with more bound machines than its cluster size, instead of re-reading every 30 s. It starts when the strand's database is published, not at runtime build.

Still to check:

- `strand-removal-cuts-network` (3 tests). Test 2 is the end-to-end proof of the change-driven route: the removed machine runs the production schedule and must see `strand:revoked` within 60 s with no refresh call.
- `strand-party-removal-via-formation-e2e`, at least three runs under `DEBUG='sereus:cadre:strand-revocation,sereus:cadre:strand-membership-reconciler'`. The implement pass of that change saw test 1 fail 1 of 4 runs (the removed party's machines already disconnected before join[0]'s explicit refresh) and test 2 fail 1 of 3 (a 120 s timeout waiting for `strand:rejoin-blocked`), causes not established. Its review then made `autoRefresh: false` (the harness's `revocationSuspended`) turn off the retry and wide-strand follow-up too, which removes the one way this change could cut a suspended machine early. A test 1 failure that recurs now is not that; a test 2 timeout with only the start refreshes in the enforcer log points at the reconciler, not the enforcer.
- The `strand` idle arm of the measurement. Informational runs saw the enforcer's idle share fall to zero (baseline 18 idle sync streams, all from the enforcer). If it does not fall, suspect the read-repair self-wake described by the `NOTE:` on `StrandRevocationEnforcer.subscribe`.

## If nothing is done

The change stays on `master` with its strand scenarios and its measurement unrun, and the next person to run them after optimystic rebuilds meets any regression without knowing which change caused it.
