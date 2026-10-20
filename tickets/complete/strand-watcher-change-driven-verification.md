description: Confirmed that the strand watcher, the pending-join retry loop and the strand removal check, which now re-read their tables only when those tables change (plus a slow fallback timer), leave every cross-machine test passing and send no messages while idle.
prereq: control-invitation-and-grant-chains-cached-until-changed, control-reconcile-woken-by-changes-reads-once, revocation-ledger-marker-removed
architecture: docs/architecture.md#reactive-strand-management
files: packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/pending-join-runner.ts, packages/cadre-core/src/strand-revocation-enforcer.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts, test-harness/build-freshness.ts
----
This was a verification-only ticket. Three earlier changes replaced short polling timers with re-reads when a watched table changes, plus a slow fallback timer (the "backstop"). This ticket ran the checks those changes owed:

- `strand-watcher-woken-by-control-changes`: the strand watcher wakes on changes to `CadreControl.Strand` and `CadreControl.JoinedStrand`, with a 5-minute backstop (`strandWatchInterval`, default 300000). It used to poll every 5 s.
- `pending-join-runner-woken-by-changes`: the pending-join retry loop wakes on changes to `JoinRequest`, `JoinSuccess`, `JoinFailure`, `OwnerKey` or `Revocation`, with a 10-minute backstop (`PENDING_JOIN_BACKSTOP_MS`). It used to run every 30 s.
- `strand-revocation-enforcer-woken-by-membership-changes`: each closed strand's revoked-peer enforcer re-reads `Strand.Member` and `Strand.MemberPeer` when they change, with a 5-minute backstop, a 30 s retry after a failed read, and a 30 s follow-up on a strand with more bound machines than its cluster size. It used to re-read every 30 s.

## Result

All 76 files in `packages/integration-tests/src/scenarios` pass on one build: sereus `a19c28aa` (`cadre-core` and `cadre-cli` dist built 08:12 on 2026-10-20) with optimystic `db-p2p` dist built 04:24 from `72ac338c`. That build has all three changes and all three prereqs. The implement pass ran 34 of the files on it. The other 42 had run on an older build that lacked the prereqs, and the review pass reran them on this one (below). The `cadre-core` (2520 passed, 1 skipped) and `cadre-cli` (295 passed, 1 skipped) unit suites and `yarn lint` pass on this build too.

The idle minute sends no Optimystic or Sereus message in the strand case and reads no block. Its 30 streams are libp2p ping and FRET ping. The 2026-10-19 baseline, from before the three changes, had 18 `sync` streams from the revocation enforcer and 154 block reads. In the cadre case the remaining idle streams are Optimystic's under-replication drain, which the cost test's doc comment already explains.

`strand-party-removal-via-formation-e2e` passed 3 of 3 runs in the implement pass. It had failed 1 of 4 and 1 of 3 runs before the enforcer change's review. Three runs are too few to call that fixed.

The implement pass's tables, per-batch timings, enforcer log analysis and before/after cost table are in the logs `tickets/.logs/strand-watcher-change-driven-verification.{b1..b6,it-b1..it-b6,party-removal-run1..3,cost-strand,cost-cadre}.log` until they are pruned.

## Review findings

**Diff read first.** `ticket(implement): strand-watcher-change-driven-verification` changes only the ticket file, with no code and no tests. So the review checked whether the ticket's claims are true and closed the gaps it named.

**Claims checked against the logs.** Every vitest summary in the 19 implement-pass logs matches the pass and skip counts the ticket gave. Each of the 76 scenario files appears in at least one log, so none was left out. The 17 skipped tests are the opt-in measurement arms, which skip without their environment variable.

**Gap 1, "the two sittings ran on different builds": closed.** The review reran the 42 first-sitting files, the four `test/` specs and the `test-harness/` specs on the build above. Logs: `rv-b1` to `rv-b5`, `rv-joiner1`, `rv-joiner2`.

| batch | files | tests | wall |
|---|---|---|---|
| rv-b1 | 16 (harness, `test/` specs, `app-joins…` to `cadre-host-update-notify`) | 127 passed | 83 s |
| rv-b2 | 10 (`cadre-invite-*`, `control-bring-up…` to `control-concurrent-unique-column-race`) | 32 passed | 169 s |
| rv-b3 | 7 (`control-cross-machine-unique-column` to `control-write-while-alone-convergence`) | 11 passed | 58 s |
| rv-b4 | 5 (`control-write-degraded-cohort-member`, `convergence-stress`, `deliver-seed-cross-network`, `enrollment-e2e`, `happy-path`) | 24 passed | 339 s |
| rv-b5 | 9 (`harness-*`, `machine-removal`, `membership-connection-gater`, `message-cost-accounting`, `multi-party-*`, `pending-join-survives-restart`, `strand-removal-cuts-network`) | 28 passed, 3 skipped (cost arms, no env var) | 259 s |
| rv-joiner1/2 | `joiner-first-commit-over-slow-relay`, split with `-t` to stay under the ten-minute command limit | 5 passed, plus the known `it.fails` frame-cap arm as an expected fail | 278 s + 279 s |

There were no failures or retries. A full `yarn vitest run` in one process was not done. It takes longer than the ten-minute command limit.

**Gap 2, "the cost measurement never ran on the prereq build": closed for the strand case.** `MESSAGE_COST_MEASURE=1 MESSAGE_COST_CASE=strand` on the build above (log `rv-cost-strand`). The idle 60 s had 0 app streams, 30 upkeep streams (ping and FRET ping) and 0 block reads. The implement pass's 23 idle reads, all from the membership view reloading, are gone now that `control-reconcile-woken-by-changes-reads-once` has landed. The cadre and invite cases were already re-measured on this day by that ticket and recorded in the doc comment, so they were not rerun.

**Gap 3, "are the 32 idle `block-transfer` streams in the cadre case periodic?": already answered, no action.** The doc comment in `message-cost-accounting.integration.ts` already says these are Optimystic's under-replication drain re-sending blocks the owner wrote before the member joined, as `DEBUG=optimystic:db-p2p:*` shows. That cadence belongs to Optimystic, and block transfers are not reads by any of the three components.

**Docs: one stale passage, fixed.** The doc comment in `message-cost-accounting.integration.ts` said the strand case's idle figures were the 2026-10-19 ones and "not re-measured", and that table still listed 18 `sync` streams from the revocation enforcer. The review added the strand row for `a19c28aa` and replaced that sentence. These docs were checked and were already correct:

- `docs/architecture.md` → "Reactive Strand Management": the watcher's triggers, 5-minute backstop and retry ladder.
- `docs/strands.md` → "Who retries": the pending-join runner's triggers, 10-minute backstop and 30 s read retry.
- `docs/strands.md` → removal: the enforcer's 5-minute backstop and 30 s wide-strand follow-up.
- `packages/cadre-cli/README.md` → `CADRE_STRAND_WATCH_INTERVAL`: described as a backstop with default 300000.

A search for "every 5 s" and "every 30 s" found no remaining text that describes these three components as polling.

**Code: nothing found.** The three source files are not in this ticket's diff and had their own review passes. The review checked that each component's `stop()` disposes its change subscription and clears its own timers (`strand-watcher.ts:397`, `pending-join-runner.ts:305`, `strand-revocation-enforcer.ts:382`). File sizes are 507, 752 and 740 lines (`wc -l`). None is large enough to file.

**Tests: none added or cut.** The ticket added none. The behaviour is covered by `strand-removal-cuts-network` test 2 and `strand-reactivity-wakes-watchers`, which both passed on this build. A new test would duplicate them.

**Tripwires and tickets: none filed.** Nothing conditional or latent turned up that is not already parked at its site by the earlier reviews.

**Not run:** the opt-in measurement arms (`RELAY_RRT_MEASURE`, `RELAY_DIAL_COST`, `REATTACH_SYNC_MEASURE`, `STRAND_WORKLOAD_PHONE`, `READ_COST_PHONE`, and the relay-restart negative control). Of these, only `strand-reattach-first-sync-measure` is close to these changes. A restarted node's watcher brings its strands up in its start pass, not on a timer, so that arm should not be affected.

## What a failure would mean (for later runs)

- **A scenario newly times out waiting for a strand on a sibling machine.** The likely cause is a change the table-change subscription did not report (`docs/architecture.md` → "Table change subscriptions" → "What it does not hear"). That is not a reason to shorten the 5-minute backstop.
- **A pending-join scenario times out.** Join attempts run on their own timers. Look at the runner's start pass, or at `kick` when the owner signer is wired, which arms a 0 ms timer instead of running a pass synchronously.
- **`strand-party-removal-via-formation-e2e` test 2 times out with only the start refreshes in the enforcer's log.** That points at the membership reconciler, not the enforcer.
