description: The strand watcher, the pending-join retry loop and the strand removal check now re-read their tables only when those tables change, plus a slow fallback, instead of on a short timer. Every cross-machine test file now passes with all three changes in place, and the message-count measurement shows all three send nothing while idle.
prereq: control-invitation-and-grant-chains-cached-until-changed, control-reconcile-woken-by-changes-reads-once, revocation-ledger-marker-removed
architecture: docs/architecture.md#reactive-strand-management
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/pending-join-runner.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts, test-harness/build-freshness.ts
----
This ticket changed no code and added no tests. It ran the checks owed by three earlier changes that replaced short polling timers with re-reads when a watched table changes, plus a slow fallback timer (the "backstop"):

- `strand-watcher-woken-by-control-changes`: the strand watcher wakes on changes to `CadreControl.Strand` and `CadreControl.JoinedStrand`, with its own retry timers and a 5-minute backstop (`strandWatchInterval`, default 300000). It used to poll every 5 s.
- `pending-join-runner-woken-by-changes`: the pending-join retry loop (`pending-join-runner.ts`) wakes on changes to `JoinRequest`, `JoinSuccess`, `JoinFailure`, `OwnerKey` or `Revocation`, with a 10-minute backstop (`PENDING_JOIN_BACKSTOP_MS`). It used to run every 30 s.
- `strand-revocation-enforcer-woken-by-membership-changes`: each closed strand's revoked-peer enforcer re-reads `Strand.Member` and `Strand.MemberPeer` when they change, with a 5-minute backstop, a 30 s retry after a failed read, and a 30 s follow-up on a strand with more bound machines than its cluster size. It used to re-read every 30 s.

## Result

All 76 files in `packages/integration-tests/src/scenarios` passed, in two sittings on two builds (below). The `cadre-core` and `cadre-cli` unit suites passed. No failure, retry or flake was seen in this pass.

### Second sitting, 2026-10-20 08:12–08:40: the 34 files left over

Build: `cadre-core` and `cadre-cli` rebuilt at 08:12 from sereus `a19c28aa` with a clean tree, so it contains all three prereqs and `new-machine-self-record-written-once` and `control-collections-created-at-cadre-founding`. optimystic `db-p2p` dist at 04:24:10 (optimystic HEAD `72ac338c`, clean tree), unchanged before and after every batch. The stale-build guard passed at the start of every batch.

Each batch ran as `yarn vitest run <paths>` from `packages/integration-tests`. Logs: `tickets/.logs/strand-watcher-change-driven-verification.{b1,b2,b3,b4,b5-workload,b6,party-removal-run1,party-removal-run2,party-removal-run3}.log`.

| batch | files | tests | wall time |
|---|---|---|---|
| b1 | `owner-anchor-follows-owner-changes`, `owner-grant-backup-recovery`, `owner-grant-without-machine`, `strand-formation-cross-party-seed`, `strand-formation-concurrent-redemption`, `strand-always-on-replica-hosts-cross-party-join`, `strand-membership-second-machine` | 10 passed | 81 s |
| b2 | `strand-two-party-two-machine`, `strand-relay-only-restart-reconverges`, `strand-formation-e2e`, `strand-membership-closed-strand-e2e`, `node-claim-by-phone`, `provider-container-claimed-by-phone`, `provider-container-joins-by-invitation` | 54 passed, 2 skipped | 108 s |
| b3 | `push-wake-e2e`, `rbac-signed-write`, `relay-only-control-addr`, `relay-round-trip-measure`, `seed-bootstrap`, `strand-addr-seed-convergence`, `strand-always-on-replica-survives-phone-loss`, `strand-chat-participants-converge` | 19 passed, 4 skipped | 92 s |
| b4 | `strand-circuit-same-party-e2e`, `strand-creation`, `strand-late-cadre-join`, `strand-reactivity-wakes-watchers`, `strand-read-cost-over-relay`, `strand-unpublish-sibling-convergence`, `websocket-chat` | 14 passed, 1 skipped | 116 s |
| b5 | `strand-workload-on-a-phone-link` | 1 passed, 1 skipped | 18 s |
| b6 | `strand-moves-between-cadres`, `strand-reattach-first-sync-measure`, `relayed-dial-cost-by-latency` | 1 passed, 9 skipped | 37 s |
| 3 runs | `strand-party-removal-via-formation-e2e` | 2 passed each run | 202 s, 173 s, 178 s |

The 17 skipped tests are all opt-in arms that need an environment variable, and the full suite skips them the same way: `relay-round-trip-measure` (all 4, `RELAY_RRT_MEASURE`), `relayed-dial-cost-by-latency` (all 6, `RELAY_DIAL_COST`), `strand-reattach-first-sync-measure` (all 3, `REATTACH_SYNC_MEASURE`), the phone-link arms of `strand-workload-on-a-phone-link` (`STRAND_WORKLOAD_PHONE`) and `strand-read-cost-over-relay` (`READ_COST_PHONE`), and the negative-control and two-process arms of `strand-relay-only-restart-reconverges`. None of them were run with their variable set.

**`strand-party-removal-via-formation-e2e`** ran three times with `DEBUG='sereus:cadre:strand-revocation,sereus:cadre:strand-membership-reconciler'`. All 6 tests passed. Test 1 ("seats and binds a second party…") took 139.5 s, 110.5 s and 114.5 s against a 600 s timeout. Test 2 ("re-forms after removal…") took 48.8 s, 48.8 s and 48.9 s, well inside its 120 s wait for `strand:rejoin-blocked`. Every machine in this file runs with `revocationSuspended: true`, so each enforcer refreshes once at strand start and then only when the test calls `refreshRevocationEnforcement`. The enforcer logs have the same shape in all three runs (21 lines for the first strand, 15 for the second): start refreshes with 0 revoked peers, then only the refreshes the test drives. The earlier failures (test 1 failed 1 of 4 runs and test 2 timed out 1 of 3, both before the enforcer change's review made `revocationSuspended` also turn off the retry and the wide-strand follow-up) did not come back in these 3 runs. That is too few runs to call them fixed.

### First sitting, 2026-10-20 02:12–02:48: the other 42 files and the unit suites

Build: `cadre-core` and `cadre-cli` from sereus `848175a0` (no package source changed up to `f246c25e`), so it had the three changes but none of the three prereqs. optimystic `db-p2p` built from `fe40f699` before 02:40 and from `ccb1d4c4` after.

- `yarn workspace @serfab/cadre-core test`: 187 files, 2533 passed, 1 skipped (the `skipIf(win32)` file-mode test in `key-store.spec.ts`). `control-founding-consult-budget.spec.ts` matched its pinned figures exactly, but those pins were taken after the three changes landed, so that match does not show the changes left the counts alone.
- `yarn workspace @serfab/cadre-cli test`: 25 files, 295 passed, 1 skipped.
- The integration package's four `test/` specs, the `test-harness/` specs, and these 42 scenario files passed: `app-joins-cadre-by-invitation`, `basic-connectivity`, `blind-relay-phone-to-phone-e2e`, `cadre-host-bootstrap`, `cadre-host-join-by-invitation`, `cadre-host-join-by-qr`, `cadre-host-orchestrator-lifecycle`, `cadre-host-origin-guard`, `cadre-host-sse-events`, `cadre-host-update-notify`, `cadre-invite-any-member`, `cadre-invite-row-unreplicated`, `control-bring-up-quiet-period`, `control-cohort-auto-convergence`, `control-cohort-cold-start-retry`, `control-cohort-edge-carries-data`, `control-cohort-harness-helpers`, `control-cohort-three-node-isolation`, `control-concurrent-same-pk-insert`, `control-concurrent-unique-column-race`, `control-cross-machine-unique-column`, `control-db-two-node-convergence`, `control-delete-while-alone-convergence`, `control-divergent-repair-yardstick`, `control-offline-read-after-restart`, `control-stream-authz`, `control-write-while-alone-convergence`, `control-write-degraded-cohort-member`, `convergence-stress`, `deliver-seed-cross-network`, `enrollment-e2e`, `happy-path`, `harness-party-control-cohort`, `harness-topology`, `joiner-first-commit-over-slow-relay`, `machine-removal`, `membership-connection-gater`, `message-cost-accounting`, `multi-party-sync`, `multi-party-workflows`, `pending-join-survives-restart`, `strand-removal-cuts-network`.
- `strand-removal-cuts-network` passed 3 of 3. Its test 2 is the end-to-end check of the enforcer's change-driven path: the removed node runs the production schedule and heard `strand:revoked` without any refresh call, in 8.4 s. The two `removal-cut` retry lines in its log ("Failed to get super-majority" on the removed party's write) are refusals that test expects.
- `pending-join-survives-restart` passed 1 of 1 in 3.3 s. `joiner-first-commit-over-slow-relay` passed 6 of 6, one of which is its known `it.fails` frame-cap arm.

### The idle message count (the before/after the three changes owed)

Run with `MESSAGE_COST_MEASURE=1` over a 60 s idle window (`MESSAGE_COST_IDLE_S` default). "Before" is the baseline in `message-cost-accounting.integration.ts`'s doc comment (2026-10-19, sereus `52ac437e`, optimystic `f22a8cb7`). "After" is the first-sitting build with optimystic `ccb1d4c4`. Logs: `tickets/.logs/strand-watcher-change-driven-verification.cost-{strand,cadre}.log`.

| idle 60 s | before | after |
|---|---|---|
| strand: Optimystic + Sereus streams | 18 (all `sync` from the revocation enforcer) | 0 |
| strand: upkeep streams (ping, FRET) | 56 | 30 |
| strand: block-read calls | 154 (144 control) | 23 (46 block ids) |
| cadre: `sync` streams | 103 | 26 (A→M 14, M→A 12) |
| cadre: `block-transfer` streams | not in the baseline | 32 (A→M) |
| cadre: block-read calls | 133 | 25 (A 13, M 12) |

Other work landed between the two runs (in sereus `control-membership-rows-cached-until-changed`, `control-collections-created-at-cadre-founding`, `strand-founding-control-writes-in-one-transaction` and `strand-founding-writes-batched`; in optimystic several cohort-consult changes), so the drop in the totals is not these three changes alone. The part that belongs to them is the per-caller breakdown: in both idle minutes every block read came from `MembershipView.load`, and the watcher, the pending-join runner and the revocation enforcer read nothing. Those were predicted to save about 48 reads, 24 reads and 18 `sync` streams; all three callers are now at zero. The watcher was never woken by a read-repair it caused itself, and no failing `JoinedStrand` read kept re-running it.

The remaining idle reads came from the membership view expiring after `MEMBERSHIP_VIEW_MAX_AGE_MS` (15 s) and the reconcile pass reloading it. `control-reconcile-woken-by-changes-reads-once` has since landed to remove them; this pass did not re-measure on the newer build.

## What the reviewer should know

- **The two sittings ran on different builds.** The 42 first-sitting files and the cost measurement never ran on the build that has the three prereqs. Those prereqs' own review passes ran many of the same files on their builds. A full `yarn vitest run` of `packages/integration-tests` on one build would close this gap. It takes longer than an agent's ten-minute command limit, so it has to be split.
- **The 32 idle `block-transfer` streams in the cadre case** go from the owner A to the newly admitted pinning member M, after 65 in the settle phase. They look like the end of copying blocks to the new member rather than a periodic cost, but a 60 s window cannot tell the two apart. Block transfers are not block reads, so the three changes cannot have caused them. To check, run the cadre arm with `MESSAGE_COST_IDLE_S=180` and see whether the count falls off.
- **The opt-in measurement arms were not run** (list above). `strand-reattach-first-sync-measure` is the only one close to these changes: a restarted node's watcher brings its strands up in its start pass, not on a timer, so it should not be affected.

## What a failure would mean (for later runs)

- **A scenario newly times out waiting for a strand on a sibling machine.** The likely cause is a change the table-change subscription did not report (`docs/architecture.md` → "Table change subscriptions" → "What it does not hear"). That is not a reason to shorten the 5-minute backstop.
- **A pending-join scenario times out.** Join attempts run on their own timers, so look at the runner's start pass, or at the `kick` when the owner signer is wired, which now arms a 0 ms timer instead of running a pass synchronously.
- **`strand-party-removal-via-formation-e2e` test 2 times out with only the start refreshes in the enforcer's log.** That points at the membership reconciler, not the enforcer.
