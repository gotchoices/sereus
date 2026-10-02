description: Sereus now tells the database library how slow the slowest link is, so the library sizes its own network time limits from the same number Sereus already uses, instead of Sereus setting some of those limits itself and the rest staying sized for a local network.
files: packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/link-budget.spec.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/peer-join-backfill.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, ops/docker/libp2p-infra/src/main.ts, packages/*/package.json, yarn.lock, docs/architecture.md, docs/cadre-consistency.md, docs/testing.md, .release-notes.pending.md, tickets/blocked/forked-control-collection-sync-livelocks.md, tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md
----
# Pass the declared link round trip to optimystic's `NodeOptions.linkRoundTripMs`

## What shipped

- Every `@optimystic/*` range is `^1.8.0`.
- `CadreNode.buildControlNodeOptions` and `StrandInstanceManager.buildStrandRuntime` pass `linkRoundTripMs: resolveLinkRoundTripMs(network?.linkRoundTripMs)` to `createLibp2pNode`, always, including the 3500 ms default. Optimystic derives from it (`resolveLinkDeadlines` in `db-p2p/src/rpc-deadline.ts`), each value floored at its old local-network default: libp2p's `dialTimeout` and `inboundUpgradeTimeout` at 5 round trips (17 500 ms at the default; cadre used to set 16 000), a request's dial at 6 (21 000 ms; was a fixed 3 000), a request's response at 3 (10 500 ms; was 10 000), and a rebalance transfer at max(30 000, the request dial).
- Removed: cadre's own `connectionManager` values on both node kinds, and `connectionManagerTimeouts()` with its export from `@serfab/cadre-core`. Optimystic's limit is at least cadre's `relayedDialBudgetMs` at every declaration; `link-budget.spec.ts` pins that.
- Kept on purpose: the hand-set `clusterPolicy.cohortQueryTimeoutMs` at two round trips (7 000 ms), where Optimystic would derive three (10 500 ms). The reasons are on `cohortReadDeadlineMs` in `link-budget.ts`.
- The relay container (`ops/docker/libp2p-infra/src/main.ts`) sets both libp2p limits to 17 500 by hand. Deployed containers were not rebuilt.
- Measurements at the supported link (1500 ms one-way) are recorded on the constants that own them (`link-budget.ts`, `strand-first-sync-gate.ts`, `cluster-size.ts`, and the doc comment of `relayed-dial-cost-by-latency.integration.ts`). In short: reads that ask another machine for a block now complete instead of being cut off at 3 s (declined reads during a fresh join went from 32 to 0); a re-attach over a kept store was writable at launch in 3 of 3 runs; a fresh join is writable at about 64 s, which did not improve.
- `blocked/forked-control-collection-sync-livelocks` was re-checked on 1.8.0 (9 of 10 runs passed) and stays blocked; its unblock condition now names optimystic's `debt-multi-collection-retry-cannot-see-the-taken-revision`.

Implemented in `ticket(implement): adopt-optimystic-link-round-trip-option`.

## Review findings

**Checked**

- The implement diff, read before the handoff: both pass-through sites, the removal of `connectionManagerTimeouts`, the new spec, the opt-in measurement scenario, and every doc and comment it touched.
- How Optimystic 1.8.0 consumes the option (`../optimystic/packages/db-p2p/src/libp2p-node-base.ts`, read only): an explicit `clusterPolicy.cohortQueryTimeoutMs`, `connectionManager`, and per-push dial and response deadlines all still win over the derived values, so cadre's kept cohort read deadline and its peer-join push budgets are not overridden.
- The containment claim (Optimystic's five round trips with a 10 000 ms floor is at least cadre's four plus 2 000 ms at every declaration): correct by arithmetic, and the spec's declarations sit on both sides of the 2 000 ms crossover. The test checks a contract between two packages that nothing else enforces, so it stays.
- Stale references: no source, doc or open ticket still names `connectionManagerTimeouts`, the closed `report-request-dial-deadline-…` ticket, or the removed "libp2p's own two limits" section, except the release notes and a backlog ticket that record the removal.
- The implementer's open question — a request to a machine that is gone now takes longer to fail, and cadre's "cuts off by design" budgets only check between attempts. Measured rather than argued; see below.

**Found and fixed in this pass (minor)**

- **The cost of the longer deadlines was not written down anywhere, and several comments still stated Optimystic's response deadline as 10 s.** Measured with `control-write-degraded-cohort-member.integration.ts` (2026-09-30, one Windows machine): a control write against a connected member that never answers failed at 42.2 s with the link declared, and at 40.2 s with the same build and no link declared (a temporary local edit, reverted). An `authorizePeer` failed at 84.3 s declared and 80.2 s undeclared. So this change adds about 5 % to that failure, not more. Corrected: `control-write-retry.ts` (`CONTROL_WRITE_RETRY_BUDGET_MS` comment), `docs/architecture.md` (the two degraded-member bullets), the scenario's header and deadline comments, and a cost sentence in `.release-notes.pending.md`.
- **The scenario's failure ceiling had 6 s of margin left.** `FAILURE_CEILING_MS` was 90 s against a measured 84.3 s (80.2 s before this change). Its comment described settlements of 20 and 40 s, which was already out of date. Raised to 110 s, under the 120 s hang timeout that bounds the same write, and the comment now states the measured figures.

**Tripwire recorded**

- A request to a machine that never completes a connection now waits up to Optimystic's 21 000 ms dial deadline, where it waited 3 000. That case was not measured: the scenario's silent member is connected, so it exercises the response deadline only. Parked as a `NOTE:` in the "Optimystic's deadlines, from the same declaration" section of `link-budget.ts`, with the revisit condition (writes on a fast link seen waiting out the dial deadline) and the remedy (declare the deployment's real round trip).

**Noticed, not caused by this ticket, no ticket filed**

- The 84 s `authorizePeer` failure is two 42 s writes in a row: a background control write (`revocation-ledger-open`) holds the control write lock for its own failed attempt first, and the user's write queues behind it. It is the same with no link declared (80.2 s), so it predates this change. It only happens while a cohort member is connected and silent, and the scenario's comments now say so. Not filed: no current-release anchor names degraded-member latency, and the failure is clean and named.

**Major findings:** none. The change is a pass-through plus a removal, the one cross-package guarantee it relies on is pinned by a spec, and the behaviour change it causes in the degraded case was measured at about 5 %.

**Validation**

- `yarn lint`, `yarn build`, `yarn typecheck`: pass. `@serfab/cadre-core` tests: 147 files, 2379 passed, 1 skipped. `@serfab/quereus-plugin-sereus` tests: 151 passed. `yarn check:dep-ranges`: pass.
- Integration scenarios run in this pass: `control-write-degraded-cohort-member` (7 of 7, run twice declared and once undeclared), `strand-always-on-replica-hosts-cross-party-join`, `strand-membership-closed-strand-e2e`, `blind-relay-phone-to-phone-e2e` (13 of 13 across the three). The whole integration suite was not re-run here; the implement pass ran it in three groups, and this pass changed only comments and one test ceiling.
- The pre-existing failure the implement pass reported (`strand-always-on-replica-hosts-cross-party-join`, `expected 'starting' to be 'active'`) was fixed by the runner's triage commit (`tess: triage pre-existing test failure`) and passes now.
- **Not run: `yarn check:published`.** It refuses a dirty tree and this stage does not commit. Run it after the runner commits.
- **Not done: rebuilding the deployed relay containers** with the 17 500 ms limits. The relay is the listener only for direct connections, which cost about one round trip, so the deployed 16 000 ms is not a defect; rebuild at the next relay deploy.
