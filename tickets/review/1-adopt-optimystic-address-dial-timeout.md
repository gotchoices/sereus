description: Sereus now requires Optimystic 1.9.0, and every sereus node gives it connection time limits sized for the slowest relayed connection plus the time the relay and the called machine take to admit it, so relayed connections on the slowest supported link no longer time out after 6 seconds (gotchoices/sereus#13). Review the change.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files:
  - packages/{cadre-cli,cadre-core,cadre-rn,integration-tests,quereus-plugin-sereus,reference-app-ns,reference-app-rn,reference-app-web}/package.json, yarn.lock (`@optimystic/*` ^1.9.0; root `resolutions` still `link:`)
  - packages/cadre-core/src/link-budget.ts (`DIAL_ADMISSION_DECISIONS`, `optimysticDialLimits`, `OptimysticDialLimits`; module doc's "Optimystic's deadlines" table and NOTEs)
  - packages/cadre-core/src/cadre-node.ts (~1958 spread into control node options; ~3606 doc), packages/cadre-core/src/strand-instance-manager.ts (~815 spread into strand node options), packages/cadre-core/src/index.ts (~499 exports)
  - packages/cadre-core/src/types.ts (~499-506 `linkRoundTripMs` ceiling), peer-dial.ts (module doc), control-write-retry.ts (~82, ~99), strand-formation-protocol.ts (~551 figure, ~795 `openFormationStream` NOTE)
  - packages/cadre-core/test/{strand-first-sync-gate,strand-instance-manager-cluster-size,-hibernation,-network-addrs,-relay,-storage-ownership}.spec.ts (mock shape), link-budget.spec.ts (comment only)
  - packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (`LINK_DEADLINES`, figures), relayed-dial-cost-by-latency.integration.ts (`armOf`, cadre arm, doc table, 2026-10-01 record)
  - docs/cadre-consistency.md, docs/architecture.md (~103, ~298, ~1473-1491), ops/docker/libp2p-infra/src/main.ts (comment only), .release-notes.pending.md
  - tickets/blocked/report-issue-13-address-dial-timeout-rerun.md (new: the draft #13 follow-up)
----
# Adopt Optimystic 1.9.0's dial limits, with sereus's admission decisions on top

## What changed

Every `@optimystic/*` range moved from ^1.8.1 to ^1.9.0 in the eight package manifests; the lockfile follows, and `resolutions` stay `link:`.

`link-budget.ts` gains `optimysticDialLimits(linkRoundTripMs?)`. It resolves the declaration with cadre's own `resolveLinkRoundTripMs` (so an invalid one fails with cadre's message), takes Optimystic's `resolveLinkDeadlines` for it, and adds `DIAL_ADMISSION_DECISIONS` (2) × `ADMISSION_DECISION_TIMEOUT_MS` (2 000 ms) to three limits. The two decisions are a party-run relay's and the called machine's, both on the dialer's clock. Both node builders spread its result next to `linkRoundTripMs`, so the control node and every strand node state:

| option | value at the default 3 500 ms round trip | on 1.8.1 |
| --- | --- | --- |
| `connectionManager.addressDialTimeout` | 39 000 ms (10 r + 4 000) | 6 000 (libp2p's fixed limit) |
| `connectionManager.dialTimeout` | 39 000 ms (10 r + 4 000) | 17 500 |
| `rpcDeadlines.dialTimeoutMs` | 42 500 ms (11 r + 4 000) | 21 000 |

The listener's `inboundUpgradeTimeout` (17 500 ms) and the RPC response deadline (10 500 ms) stay Optimystic's own derivation.

What follows from these values:
- The Quereus plugin derives a 170 000 ms transaction budget and a 42 500 ms cancel budget from the request dial.
- A failing control write against a silent member now runs one pend round and three cancel rounds of 21 s each, about 84 s, and holds the control write lock that long. A write queued behind it settles at about 168 s.
- The largest accepted `linkRoundTripMs` falls to about 10.8 h, because the stated request dial then exceeds Optimystic's `MAX_RPC_DIAL_TIMEOUT_MS`.

The docs, comments and release note carry these figures. The release note compares against the last published release (Optimystic 1.8.x), so its baseline for the failing write is about 42 s, not the 63 s that only unreleased master ever had.

The degraded-cohort scenario now derives its bounds from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS, optimysticDialLimits().rpcDeadlines)`. Its per-`it` timeouts were already derived from `STALLED_WRITE_TIMEOUT_MS` (now 210 s), and each still exceeds the sum of the labelled deadlines it can pay (225 s against 270 s; 300 s against 330 s; 270 s against 330 s).

The latency instrument's cadre arm takes the helper's `connectionManager` values (adding `addressDialTimeout`) and its request dial. Its "every arm's 300 s dial completes" expectation is now asserted for the cadre arm only, because libp2p 3.3.11 applies `addressDialTimeout` inside a dial that carries its own signal (dial-queue.js ~204), so the fallback arm's dial now stops at 6 s.

The `openFormationStream` NOTE and the pending release note on joining now say that libp2p's per-address limit is longer than the formation dial budget (5 r + 2 000), so an address that never answers uses the whole budget and the join moves on to the party's next machine.

## Validation (all run in this pass, 2026-10-01)

- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn lint`, `yarn check:dep-ranges`: clean.
- `yarn workspace @serfab/cadre-core test`: 149 files, 2 364 passed, 1 skipped. `cadre-cli` tests: 19 files, 254 passed.
- `control-write-degraded-cohort-member`: 7/7 passed. Stalled remove 84.4 s, stalled authorize 168.6-168.9 s (queued behind `revocation-ledger-open`, which failed at 84.3 s), read-while-stalled 168.5 s, delayed writes 8.1 s each.
- `RELAY_DIAL_COST=1 RELAY_DIAL_COST_DELAYS=1500` latency instrument: 2/2 passed. The cadre arm's relayed dial took 12 089 ms and `newStream` 3 018 ms; the listener held 1 connection; the signal-less dial took 12 100 ms and the dial under the request deadline 12 094 ms. The fallback arm aborted at 6 004-6 007 ms, which is #13's cut-off reproduced in bare libp2p. Only the 1 500 ms delay was swept, not 0 or 900.
- `yarn check:published --skip-gates --allow-dirty` on HEAD 90e2b309: passed. Every `@optimystic/*` resolved to 1.9.0 from npm, including the reference apps' own copies, and `@quereus/quereus` resolved to 4.20.0. The `cpu-features` optional build failure is the documented benign one. **The full `yarn check:published` (all gates) was not run**: it is not runnable inside a ticket (docs/testing.md). It should now pass against npm 1.9.0, and the maintainer should run it before release.

Logs are in `tickets/.logs/adopt-optimystic-address-dial-timeout.*.log`.

## Tests

No new test, as the plan asked. The helper adds a constant to Optimystic's derivation, and its relationships (`dialTimeout` ≥ `addressDialTimeout`, cadre's message on an invalid declaration) hold by construction. The existing `link-budget.spec.ts` listener-containment test and the degraded-cohort scenario cover what can break.

Six cadre-core specs (`strand-first-sync-gate` and five `strand-instance-manager-*`) mocked `@optimystic/db-p2p` as `{ createLibp2pNode }` only. `buildStrandRuntime` now calls `resolveLinkDeadlines` through the helper, so 69 tests failed until each mock became a partial `vi.mock(import(...), importOriginal)` that keeps `resolveLinkDeadlines` real. These are mock-shape updates, not new tests. `strand-scope-key-validation.spec.ts` keeps the old mock shape and passes, because its path never reaches the node builder.

## For the reviewer

- **The request dial is longer than the per-address limit** (42.5 s against 39 s). Optimystic's `rpcDeadlines` doc says to keep it no longer, but Optimystic's own derivation has the same 11 r against 10 r. The extra round trip is stream negotiation after the connection opens, which the per-address limit does not cover. This is now stated in `optimysticDialLimits`'s doc. It may be worth raising upstream as a wording fix.
- **New NOTE in docs/architecture.md, "Relay Integration"**: libp2p's and Optimystic's dial limits now exceed the listener's 17.5 s, so a dial bounded only by them can meet the silent `Unexpected EOF` failure on a link much slower than declared. This was inferred from the code, not measured, and it was already true of Optimystic 1.9.0's own defaults.
- **Edits outside the plan's file list:**
  - docs/architecture.md ~1473-1491: "What Optimystic derives" is split, with a new "What cadre states on top" paragraph.
  - The relay container's comment in `ops/docker/libp2p-infra/src/main.ts`. Its `dialTimeout` of 17 500 ms is unchanged, because a relay dials nothing.
  - `strand-formation-protocol.ts` ~551: 154 s became 170 s.
- **Not done here, by design:**
  - Cadre's own dial budgets still omit opening the relay connection; `fix/bug-relayed-dial-budget-omits-opening-the-relay-connection` owns that.
  - Nodes built outside cadre-core get none of these limits; this is an arm on `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`, already written.
- **Reported to triage (`tickets/.pre-existing-error.md`), not caused here:** during the delayed-member case, C's background `[self-record-update]` was abandoned with `pending conflict: … unresolved rival action(s)`, inside the degraded window and with no test failing. The same line is in a log from before this ticket (`libp2p33.degraded-at-head.log`). The known-failures record classes that wording as a finding.
- **Two agent runs worked this ticket at the same time** (21:47 and 22:00); the earlier one ended once they coordinated. Its edits are in the tree and were re-validated above.
- **A leftover `check:published` worktree is still registered**: `C:/Users/n8ers/AppData/Local/Temp/sereus-check-published-W3CPro/repo`, detached at db00f225. It is from an earlier run. It was left alone because its `node_modules` may hold `link:` junctions into the sibling repositories (see docs/testing.md → "Scratch worktrees and clones").
- **The #13 follow-up** is drafted in `blocked/report-issue-13-address-dial-timeout-rerun.md`. Posting it is the maintainer's call.
