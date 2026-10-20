description: The strand watcher, the pending-join retry loop and the strand removal check now re-read their tables only when those tables change, plus a slow fallback, instead of on a short timer. The message-count measurement confirms all three are silent when idle, and the core, command-line and about half the cross-machine test files pass; the remaining 34 scenario files, mostly strand scenarios, still need running once nobody else is editing the core package.
prereq: control-invitation-and-grant-chains-cached-until-changed, control-reconcile-woken-by-changes-reads-once, revocation-ledger-marker-removed
architecture: docs/architecture.md#reactive-strand-management
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/pending-join-runner.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts, test-harness/build-freshness.ts
----
**What is left:** run the 34 scenario files under *Still to run*, including three debug runs of `strand-party-removal-via-formation-e2e`. Nothing else is owed. The measurement is done and recorded below.

**Why the prereqs.** At 02:48 on 2026-10-20 the stale-build guard refused `@serfab/cadre-core`. The reason was not this ticket: `6.2-control-invitation-and-grant-chains-cached-until-changed` was being implemented at the same time and had uncommitted edits in `cadre-core/src`. Building then would have compiled that ticket's unfinished code into every run here. The three prereqs are the implement tickets queued ahead of this one, and every one of them edits `cadre-core`. They are listed so that two runners do not work on them and on this ticket at once. This ticket does not depend on their content. A failure in the remaining runs may come from them as well as from the three changes; say which when you report it.

## What is being verified

Three changes replaced short polling timers with re-reads when a watched table changes, plus a slow backstop:

- `strand-watcher-woken-by-control-changes`: the strand watcher wakes on changes to `CadreControl.Strand` and `CadreControl.JoinedStrand`, with its own retry timers and a 5-minute backstop (`strandWatchInterval`, default 300000). It used to poll every 5 s.
- `pending-join-runner-woken-by-changes`: the pending-join retry loop (`pending-join-runner.ts`) wakes on changes to `JoinRequest`, `JoinSuccess`, `JoinFailure`, `OwnerKey` or `Revocation`, with a 10-minute backstop (`PENDING_JOIN_BACKSTOP_MS`). It used to run every 30 s.
- `strand-revocation-enforcer-woken-by-membership-changes`: each closed strand's revoked-peer enforcer re-reads `Strand.Member` and `Strand.MemberPeer` when they change, with a 5-minute backstop, a 30 s retry after a failed read, and a 30 s follow-up on a strand with more bound machines than its cluster size. It used to re-read every 30 s.

## Done on 2026-10-20

What each run executed:

- **sereus:** `cadre-core` and `cadre-cli` were built at 02:12 from `848175a0`. No package, doc or schema source changed between then and `f246c25e`.
- **optimystic, runs before 02:40:** `db-p2p` built at 02:11:51, which matched the source committed as `fe40f699`.
- **optimystic, runs after 02:40:** `db-p2p` built at 02:40:00 from what optimystic committed at 02:48 as `ccb1d4c4` (`a-cohort-consult-asks-each-peer-about-all-its-blocks-at-once`). The guard passed for every sibling package before and after each run.

### Unit suites

- `yarn workspace @serfab/cadre-core test`: 187 files, 2533 passed, 1 skipped (the `skipIf(win32)` file-mode test in `key-store.spec.ts`). This includes every spec the earlier tickets asked to watch.
- `control-founding-consult-budget.spec.ts` measured exactly its pinned figures: cold start 41 consults / 33 blocks / 1 commit; genesis 20 / 19 / 34; `foundStrand` control 4 / 4 / 3 and strand 29 / 15 / 14; every per-call read 0. Those pins were taken on 2026-10-20, after the three changes landed, so this match does not show the changes left the counts alone.
- `yarn workspace @serfab/cadre-cli test`: 25 files, 295 passed, 1 skipped.

### Integration files, all passing

These were run as `yarn vitest run <paths>` from `packages/integration-tests`, so the global setup ran the guard. The package's four `test/` specs and the `test-harness/` specs passed, and so did these 42 scenario files:

`app-joins-cadre-by-invitation`, `basic-connectivity`, `blind-relay-phone-to-phone-e2e`, `cadre-host-bootstrap`, `cadre-host-join-by-invitation`, `cadre-host-join-by-qr`, `cadre-host-orchestrator-lifecycle`, `cadre-host-origin-guard`, `cadre-host-sse-events`, `cadre-host-update-notify`, `cadre-invite-any-member`, `cadre-invite-row-unreplicated`, `control-bring-up-quiet-period`, `control-cohort-auto-convergence`, `control-cohort-cold-start-retry`, `control-cohort-edge-carries-data`, `control-cohort-harness-helpers`, `control-cohort-three-node-isolation`, `control-concurrent-same-pk-insert`, `control-concurrent-unique-column-race`, `control-cross-machine-unique-column`, `control-db-two-node-convergence`, `control-delete-while-alone-convergence`, `control-divergent-repair-yardstick`, `control-offline-read-after-restart`, `control-stream-authz`, `control-write-while-alone-convergence`, `control-write-degraded-cohort-member`, `convergence-stress`, `deliver-seed-cross-network`, `enrollment-e2e`, `happy-path`, `harness-party-control-cohort`, `harness-topology`, `joiner-first-commit-over-slow-relay`, `machine-removal`, `membership-connection-gater`, `message-cost-accounting`, `multi-party-sync`, `multi-party-workflows`, `pending-join-survives-restart`, `strand-removal-cuts-network`.

Notes on that list:

- `message-cost-accounting`'s default arm skips all three cases without `MESSAGE_COST_MEASURE=1`; the measured runs are below.
- `joiner-first-commit-over-slow-relay` passed 6 of 6, one of which is its known `it.fails` frame-cap arm.
- `strand-removal-cuts-network` passed 3 of 3. Test 2 is the end-to-end proof of the enforcer's change-driven route: the removed node runs the production schedule and heard `strand:revoked` with no refresh call, in a test that took 8.4 s. Two `removal-cut` retry lines in its log ("Failed to get super-majority" on the removed party's write) are that test's expected refusals, not failures.
- `pending-join-survives-restart` passed 1 of 1 in 3.3 s.

### The measurement (the before/after this ticket owes)

Each case is the idle minute (`MESSAGE_COST_IDLE_S` default 60). "Before" is the baseline in `message-cost-accounting.integration.ts`'s doc comment (2026-10-19, sereus `52ac437e`, optimystic `f22a8cb7`). "After" is these runs, on the builds above (optimystic `ccb1d4c4`). Logs: `tickets/.logs/strand-watcher-change-driven-verification.cost-{strand,cadre}.log`.

| idle 60 s | before | after |
|---|---|---|
| strand: Optimystic + Sereus streams | 18 (all `sync` from the revocation enforcer) | 0 |
| strand: upkeep streams (ping, FRET) | 56 | 30 |
| strand: block-read calls | 154 (144 control) | 23 (46 block ids) |
| cadre: `sync` streams | 103 | 26 (A→M 14, M→A 12) |
| cadre: `block-transfer` streams | not listed in the baseline | 32 (A→M) |
| cadre: block-read calls | 133 | 25 (A 13, M 12) |

**What the totals do and do not show.** Other work also landed between the two runs. In sereus: `control-membership-rows-cached-until-changed`, `control-collections-created-at-cadre-founding`, `strand-founding-control-writes-in-one-transaction` and `strand-founding-writes-batched`. In optimystic, several cohort-consult changes ran between `f22a8cb7` and `ccb1d4c4`. So the drop in the totals is not these three changes alone. What does belong to them is the per-caller breakdown of block reads. In both idle minutes, every read came from `MembershipView.load` (strand: A 12, B 10 and 1 retry; cadre: A 13, M 12), and the watcher, the pending-join runner and the revocation enforcer read nothing. The tickets had predicted about 48 idle reads removed from the watcher in the strand case, the runner's 24 idle reads removed in the cadre case, and the enforcer's 18 `sync` streams removed in the strand case. All three figures are now zero. Neither self-wake suspect showed: the watcher was not woken by a read-repair landing it caused, and no `JoinedStrand` read kept failing and re-ran the watcher.

**The remaining idle reads** are the membership view expiring after `MEMBERSHIP_VIEW_MAX_AGE_MS` (15 s, set equal to the reconcile pass interval) and the reconcile pass reloading it. That work is `control-reconcile-woken-by-changes-reads-once`.

**The 32 idle `block-transfer` streams** go from the owner A to the newly admitted pinning member M. There were 65 in the settle phase before the idle minute. They look like the tail of copying blocks to the new member, not a periodic cost, but a 60 s window cannot tell those apart. Block transfers are not block reads, so the three changes cannot have opened them. If they matter, run the cadre arm with `MESSAGE_COST_IDLE_S=180` and see whether the count falls off.

## Still to run

The 34 scenario files not listed above:

`node-claim-by-phone`, `owner-anchor-follows-owner-changes`, `owner-grant-backup-recovery`, `owner-grant-without-machine`, `provider-container-claimed-by-phone`, `provider-container-joins-by-invitation`, `push-wake-e2e`, `rbac-signed-write`, `relay-only-control-addr`, `relay-round-trip-measure`, `relayed-dial-cost-by-latency`, `seed-bootstrap`, `strand-addr-seed-convergence`, `strand-always-on-replica-hosts-cross-party-join`, `strand-always-on-replica-survives-phone-loss`, `strand-chat-participants-converge`, `strand-circuit-same-party-e2e`, `strand-creation`, `strand-formation-concurrent-redemption`, `strand-formation-cross-party-seed`, `strand-formation-e2e`, `strand-late-cadre-join`, `strand-membership-closed-strand-e2e`, `strand-membership-second-machine`, `strand-moves-between-cadres`, `strand-party-removal-via-formation-e2e` (three runs, see below), `strand-reactivity-wakes-watchers`, `strand-read-cost-over-relay`, `strand-reattach-first-sync-measure`, `strand-relay-only-restart-reconverges`, `strand-two-party-two-machine`, `strand-unpublish-sibling-convergence`, `strand-workload-on-a-phone-link`, `websocket-chat`.

How to run them:

- **Rebuild first.** Build `cadre-core` and `cadre-cli` (and any other package the guard names) when no other ticket has uncommitted edits in them. If the guard names a package stale because another ticket is editing it right now, stop. Do not build someone else's unfinished edit.
- **Keep each command under about eight minutes.** A batch of eight files that included `joiner-first-commit-over-slow-relay` (535 s of tests on its own, already passed) took 11 minutes. That pushed the command past the tool's 10-minute foreground limit and into the background, and while it ran there a second agent started on this same ticket. Run the long files on their own: `strand-workload-on-a-phone-link`, `strand-reattach-first-sync-measure`, `relayed-dial-cost-by-latency`, `strand-moves-between-cadres`, and `strand-party-removal-via-formation-e2e` (about 4.5 minutes).
- **Check the optimystic build before and after each batch.** Compare the modification time of `../optimystic/packages/db-p2p/dist/src/index.js`, and re-run a batch whose files straddled a rebuild.
- **`strand-party-removal-via-formation-e2e`:** run it at least three times, each with `DEBUG='sereus:cadre:strand-revocation,sereus:cadre:strand-membership-reconciler'`. The enforcer change's implement pass saw test 1 fail 1 of 4 runs and test 2 fail 1 of 3 (a 120 s timeout waiting for `strand:rejoin-blocked`), causes not established. Its review then made `autoRefresh: false` (the harness's `revocationSuspended`) turn off the retry and the wide-strand follow-up too. A test 1 failure that recurs now is therefore not the enforcer cutting a suspended machine early. A test 2 timeout with only the start refreshes in the enforcer's log points at the reconciler, not the enforcer.

## What a failure would mean

- **A scenario newly times out waiting for a strand on a sibling machine.** The likely cause is a change the table-change subscription did not report (`docs/architecture.md` → "Table change subscriptions" → "What it does not hear"). That is not a reason to shorten the 5-minute backstop.
- **A pending-join scenario times out.** Join attempts run on their own timers, so look at the runner's start pass, or at the `kick` when the owner signer is wired, which now arms a 0 ms timer instead of running a pass synchronously.

## If nothing is done

The three changes stay on `master` with half their cross-machine scenarios unrun. Each looked fine wherever it was run, but the strand scenarios, the ones most likely to depend on the old 5-second poll, have not been run against them.
