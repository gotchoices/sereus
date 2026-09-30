description: Sereus now tells the database library how slow the slowest link is, so the library sizes its own network time limits from the same number Sereus already uses, instead of Sereus setting some of those limits itself and the rest staying sized for a local network. Review the change, the measurements taken on a slow link, and the one limit Sereus still sets on purpose.
files: packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/link-budget.spec.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/peer-join-backfill.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts, ops/docker/libp2p-infra/src/main.ts, packages/*/package.json, yarn.lock, docs/architecture.md, docs/cadre-consistency.md, docs/testing.md, .release-notes.pending.md, tickets/blocked/forked-control-collection-sync-livelocks.md, tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md
----
# Pass the declared link round trip to optimystic's `NodeOptions.linkRoundTripMs`

## What changed

- **Dependency floor.** Every `@optimystic/*` range is now `^1.8.0` (`yarn upgrade:optimystic`; `check:dep-ranges` passes).
- **The declaration reaches Optimystic.** `CadreNode.buildControlNodeOptions` and `StrandInstanceManager.buildStrandRuntime` pass `linkRoundTripMs: resolveLinkRoundTripMs(network?.linkRoundTripMs)` to `createLibp2pNode`, so it is always stated, including the 3500 ms default. Optimystic 1.8.0 derives from it (`resolveLinkDeadlines` in `db-p2p/src/rpc-deadline.ts`), each value floored at its old LAN default:
  - libp2p's `dialTimeout` and `inboundUpgradeTimeout`: 5 round trips, 17 500 ms at the default (was 16 000, set by cadre);
  - request dial: 6 round trips, 21 000 ms (was a fixed 3 000);
  - request response: 3 round trips, 10 500 ms (was 10 000);
  - rebalance transfer: max(30 000, the request dial).
- **Removed as redundant:** the `connectionManager` pass-through on both node kinds and the `connectionManagerTimeouts()` helper, including its export from `@serfab/cadre-core`. Optimystic's limit is at least cadre's `relayedDialBudgetMs` at every declaration. At or above 2 000 ms, five round trips are at least four round trips plus the 2 000 ms admission allowance. Below 2 000 ms, Optimystic's 10 000 ms floor covers the dial budget. The new spec pins this.
- **Kept on purpose:** the hand-set `clusterPolicy.cohortQueryTimeoutMs`. Optimystic's derivation uses 3 round trips (10 500 ms) and cadre's `cohortReadDeadlineMs` uses 2 (7 000 ms), so they differ. The ticket said to remove it only if they matched. The reasons are on `cohortReadDeadlineMs`: the headroom is already in the declaration, and a third round trip lengthens every consult against a peer that is gone. The plugin's frozen policies must state the value anyway, because a plugin-only host declares no link.
- **Relay container.** `ops/docker/libp2p-infra/src/main.ts` now sets both limits to 17 500 by hand, to match. Deployed containers were not rebuilt.
- **Docs.** `link-budget.ts` has a new section, "Optimystic's deadlines, from the same declaration", with a table. It replaces the "libp2p's own two limits" section and the first bullet of "What still fails". Also updated: `COMMIT_ROUND_TRIPS` (new measurement), `cohortReadDeadlineMs`, `COHORT_READ_DEADLINE_MS`, the first-sync bands and the 300 s rationale, `NetworkConfig.linkRoundTripMs` (it now also notes Optimystic refuses values above about 1.66 days), `docs/architecture.md` (Relay Integration, and the config example), `docs/cadre-consistency.md` (deadline section), `docs/testing.md`, and a release-notes section. All references to the closed `report-request-dial-deadline-cuts-cohort-consults-on-open-connections-to-optimystic` are gone.

## Measurements (one Windows machine, loopback relay, `pipelined` delay)

Recorded in the code comments that own them. In summary:

| what | before (1.7.0, 2026-09-29) | now (1.8.0) |
| --- | --- | --- |
| relayed dial at 1500 ms one-way, `cadre-core declared` arm | dial 12 061 ms, listener held it | dial 12 086 ms, `newStream` 3011 ms, listener held 1, signal-less dial 12 086 ms, dial under Optimystic's request deadline 12 091 ms (was: fails at 3 s) |
| fresh join, writable | 52.1, 82.1, 63.6, 70.2 s | 63.9, 63.8 s (row at 88.0 s both) |
| declined reads during a fresh join | 32 (at 7000), 39 (at 5000) | 0 |
| consult spacing on the joiner | 3.00–3.02 s (cut off) | 6.03–6.05 s (completed: two round trips) |
| re-attach over a kept store | 1 of 3 writable at launch, 2 gated to 75.7/78.7 s; row at 33.4/120.8/175.0 s | 3 of 3 writable at launch (9.2 s); row at 35.6 s each |
| one strand insert at 150 ms one-way (`COMMIT_ROUND_TRIPS`) | 3.84–4.46 s / 5.09–6.09 s | 3.26–3.94 s / 4.45–5.17 s, at most 17.2 round trips; 20 stands |

Commands: `RELAY_DIAL_COST=1 RELAY_DIAL_COST_DELAYS=0,1500 … vitest run src/scenarios/relayed-dial-cost-by-latency.integration.ts`; `REATTACH_SYNC_MEASURE=1 REATTACH_ARMS=<arm> REATTACH_DELAY_MS=1500 DEBUG='optimystic:db-p2p:coordinator-repo*,sereus:cadre:strand-first-sync' … vitest run src/scenarios/strand-reattach-first-sync-measure.integration.ts`; `RELAY_RRT_MEASURE=1 RELAY_RRT_CONFIG=delayed … relay-round-trip-measure`. Declined reads were counted as `cluster-fetch:peers-silent` lines between "B attaches" and `RESULT`. The only ones in the logs came while B was stopped, or during teardown.

The fresh join did not get faster. Its consults now succeed, but they run one after another at 6 s each, and the gate opened after the seventh. Whether that serialization belongs to cadre's gate probes or to Optimystic was not investigated. It fits the 300 s budget with a wide margin (worst sample now 64 s). The empty-store re-attach arm was not re-run.

## Blocked ticket re-check (step 5)

`control-delete-while-alone-convergence`, 10 runs: 6 in parallel, then 4 isolated. 9 passed. 1 failed with `CoordinatorStaleLossError … Pend failed for collection default/cadrecontrol/CadrePeer: stale conflict`. That comes from Optimystic's multi-collection commit, which its revision-floor change does not reach yet. Optimystic tracks that gap as its own backlog `debt-multi-collection-retry-cannot-see-the-taken-revision`. So `blocked/forked-control-collection-sync-livelocks` stays blocked; its unblock condition now names that ticket, and the re-check is recorded at its top.

## Tests

- Added `link-budget.spec.ts` → "gets a listener limit from Optimystic that outlasts cadre's relayed dial at every declared link". It checks the cross-package guarantee that replaced cadre's own `connectionManager` values. Its declarations sit on both sides of the 2 000 ms point where Optimystic switches from its floor to its multiple. No wiring test was added for the `linkRoundTripMs` pass-through itself; per the test rules, wiring gets none.
- Changed the opt-in `relayed-dial-cost-by-latency.integration.ts`. Both arms now read their limits and request dial deadline from Optimystic's `resolveLinkDeadlines`, undeclared and at `DECLARED_LINK_ROUND_TRIP_MS`. The cadre arm also asserts that a dial under Optimystic's request deadline succeeds at the supported link. It was run and passes (see the table).

## Validation run, and gaps

- `yarn lint`, `yarn build`, `yarn typecheck`: pass. Every workspace's tests pass: cadre-core has 147 files / 2378 tests, and the others all pass too. The root `test:*` node scripts and `yarn smoke:published` (which installs 1.8.0 from npm) pass. The integration suite was run in three groups of about 22 files, because one `yarn check` run is longer than the 10-minute tool limit. The only failure is below.
- **Pre-existing failure, reported in `tickets/.pre-existing-error.md`:** `strand-always-on-replica-hosts-cross-party-join` gets `expected 'starting' to be 'active'` right after the phone's `addStrand`, 4 of 4 times. It fails the same way with HEAD's versions of the four runtime-changed cadre-core files rebuilt into `dist`, so this ticket did not cause it.
- **Not run: `yarn check:published`.** It refuses a dirty tree, and this stage does not commit. Run it once the runner has committed this work.
- **For the reviewer to weigh:** Optimystic's longer request deadlines (dial 21 s, response 10.5 s) mean a request to a peer that is gone takes longer to fail. cadre's "cuts off by design" deadlines check between attempts (for example `CONTROL_WRITE_RETRY_BUDGET_MS`, 10 s), so one attempt can now outlast them. The integration suite shows no regression from this, but no scenario targets it.
