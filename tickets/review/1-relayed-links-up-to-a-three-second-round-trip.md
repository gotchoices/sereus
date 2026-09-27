description: Two machines that can only reach each other through a relay can now connect on a link as slow as a 3-second round trip, where anything above about 2.5 seconds used to fail silently; this checks that work — new connection limits on every node, a slower assumed link by default, and the documentation of what still fails at that speed.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (DECLARED_LINK_ROUND_TRIP_MS 2000 → 3500; new connectionManagerTimeouts(); module doc rewritten)
  - packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions passes connectionManager)
  - packages/cadre-core/src/strand-instance-manager.ts (strand createLibp2pNode passes connectionManager)
  - packages/cadre-core/src/index.ts (exports connectionManagerTimeouts)
  - packages/cadre-core/src/types.ts (NetworkConfig.linkRoundTripMs doc; DEFAULT_CONNECTION_MONITOR ping-vs-link note)
  - packages/cadre-core/src/{peer-dial,relay-reservation,peer-join-backfill,seed-bootstrap}.ts (comments quoting old derived numbers; backfill warning text)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (arms now db-p2p fallback vs cadre-core declared; new assertions; result recorded)
  - packages/reference-app-rn/src/host-node-request.ts (connectMs 60 s → 120 s)
  - packages/reference-app-rn/test/solo-founding.spec.ts (comment only)
  - packages/cadre-cli/src/config/types.ts (doc only)
  - ops/docker/libp2p-infra/src/main.ts (relay sets both limits to 14 000)
  - docs/architecture.md (Relay Integration → "Dial budgets are counted in round trips, not milliseconds"; config block)
  - docs/testing.md, docs/reference-app-rn.md, .release-notes.pending.md
  - tickets/backlog/debt-three-more-dial-deadlines-ignore-the-declared-link.md, tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md (arms appended)
----

# Relayed links up to a 3-second round trip — review handoff

## What was decided (maintainer, 2026-09-26)

Sereus supports a machine that reaches its cadre only through a circuit relay up to a **3-second link round trip** (1.5 s each way). Optimystic 1.7.0 (already the floor, `^1.7.0`) lets an embedder set libp2p's `connectionManager.dialTimeout` and `inboundUpgradeTimeout` through `NodeOptions.connectionManager`. Before, both were 10 s. That cannot open a relayed connection above a 2.5 s round trip, and the listener's side of the failure is silent: the caller's dial resolves, but the called machine has already discarded the connection, so every stream dies with `Unexpected EOF`.

## What changed

- **`link-budget.ts`**
  - New `connectionManagerTimeouts(linkRoundTripMs?)` returns `{ dialTimeout, inboundUpgradeTimeout }`, both equal to `relayedDialBudgetMs` (4 link round trips, which is 8 one-way delays).
  - The listener's limit is deliberately equal to the dialer's, not smaller. The listener's clock starts only when the relay hands it the circuit, so with equal limits it never discards a connection the dialer would still accept. This is reasoning, supported by the 1500 ms measurement below. It was not tested at every delay up to 1750 ms one-way, where 14 s runs out.
- **`DECLARED_LINK_ROUND_TRIP_MS` is now 3500** (was 2000).
  - The 3 s supported link is rounded up to the next half second, because the worst measured dial at 3 s was 12 094 ms, above the 12 000 ms that 3000 would derive.
  - 3500 derives 14 000 ms, leaving about 1.9 s for a phone's handshake crypto. That margin is not measured on a device.
- **Derived budgets at the new default:**

| budget | old | new |
| --- | --- | --- |
| relayed dial, per address | 8 s | 14 s |
| reservation drive | 8 s | 14 s |
| control-cohort per-peer dial | 32 s | 56 s |
| peer-join push response | 10 s | 13 s |
| libp2p `dialTimeout` / `inboundUpgradeTimeout` | 10 s | 14 s |

- **Both node builders pass `connectionManager`:** the control node (`buildControlNodeOptions`) and every strand node. `network.linkRoundTripMs` moves both limits.
- **Relay container** (`ops/docker/libp2p-infra/src/main.ts`) sets both limits to 14 000 by hand, with a comment tying them to cadre-core. Its ping settings are untouched. The comment says honestly that 10 s already covered the relay's own direct-connection leg.
- **Checked whether any containing limit is now exceeded:**
  - The reference app's lent-node `connectMs` was documented as "two full per-peer dials". At 56 s per dial, 60 s no longer holds two, so it was raised to **120 s**, with `docs/reference-app-rn.md` updated (8 s → 14 s per address, 60 s → 120 s). This is a judgment call; the alternative was to keep 60 s and weaken the comment. It is user-visible: a genuinely unreachable lent node now reports after 2 minutes instead of 1.
  - `solo-founding.spec.ts`'s dead-relay deadlines (30 s and 45 s) still hold. Founding measured 14.1 s, which is one full drive.
  - The 300 s first-sync wait contains a 14 s drive easily.
  - The connection monitor's pinned 30 s ping deadline versus a 3 s link: one ping costs about 2 link round trips, about 6 s. This is now noted on `DEFAULT_CONNECTION_MONITOR`.
- **Docs:**
  - The accepted wording is in `docs/architecture.md` → Relay Integration, with a "Known limits at the supported round trip" list: Optimystic's 3 s RPC dials (375 ms one-way, upstream `debt-rpc-dial-deadlines-cannot-open-a-slow-relayed-connection`), the four still-fixed cadre deadlines, and the first-sync wait sized at 1.8 s.
  - The rule "declare the same `linkRoundTripMs` on every machine of a party" is stated in the architecture doc, in `link-budget.ts`, in the `NetworkConfig` doc and in the CLI config doc.
- **Release note** added to `.release-notes.pending.md`, ending "Requires `@optimystic/*` 1.7.0".
- **Backlog arms appended** rather than filing new tickets (same class, same site):
  - `debt-three-more-dial-deadlines-ignore-the-declared-link`: its premise "nothing is wrong at the default" is no longer true at the supported link. A fourth arm was added for `COHORT_READ_DEADLINE_MS` (5 s, below the roughly 6 s a cohort read costs at a 3 s round trip). That arm is `repro: static`, arithmetic from the counts.
  - `debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`: the three node builders outside cadre-core miss the new limits too.

## Proof (the ticket's step 3)

Command: `RELAY_DIAL_COST=1 RELAY_DIAL_COST_DELAYS=0,1500 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency`. It took about 105 s; 4 of 4 tests passed. Results are recorded in the scenario's doc comment:

| arm, at 1500 ms one-way | relayed dial | `newStream` | listener holds | dial with no signal |
| --- | --- | --- | --- | --- |
| **cadre-core declared** (14 000 each) | 12 061 ms | 3016 ms | 1 | 12 068 ms |
| db-p2p fallback | 12 061 ms | `Unexpected EOF` after 2465 ms | 0 | aborted at 10 015 ms |

The scenario's arms changed:
- The old 120 s control arm was replaced by a `cadre-core declared` arm, which imports `connectionManagerTimeouts()` so it cannot drift from what cadre-core ships.
- The declared arm now **asserts**, at every delay up to 1500 ms one-way, that the listener holds the connection, `newStream` works on it, and a dial with no signal of its own completes.

## Validation run

- cadre-core full suite: 140 files, 2282 passed, 1 skipped.
- reference-app-rn: 294 passed. cadre-cli: 236 passed.
- Integration scenarios: every file except the three opt-in measurement scenarios passed, in three batches (7 + 25 + 28 files including package specs). The suite takes about 13 minutes, over the 10-minute limit for a single command here, so it was never run as one command.
- Type checks passed for cadre-core, cadre-cli, integration-tests and reference-app-rn. `yarn lint` is clean.

## Tests added

None beyond the scenario's new assertions (opt-in, not part of `yarn test`). `connectionManagerTimeouts` has no branching, and `link-budget.spec.ts` already asserts relationships rather than literal milliseconds, so it needed no change.

**For the reviewer to weigh:** there is no unit test pinning that the control and strand nodes pass `connectionManager`. The analogous `connectionMonitor` wiring does have tests in `cadre-node-control-node-options.spec.ts` and `strand-instance-manager-network-addrs.spec.ts`, but those were justified by that field being defaulted. This one is plain wiring, so under "don't test wiring" I left it out. If it were dropped, the failure would only show on a slow link.

## Known gaps

- **Not measured:**
  - The connection was not held past one liveness-ping cycle (35 s); the scenario doesn't wait that long.
  - The 900 ms delay was not re-run in this pass.
  - No run on a real phone or a real slow link.
- **The same-link rule is documentation only.** Nothing detects two machines of a party declaring different `linkRoundTripMs`. A machine declaring a faster link than its peers reproduces the silent failure for connections opened to it.
- **The relay container change was not built or run.** Its file is `@ts-nocheck`, so `tsc` does not check the new keys. libp2p 2.10's `ConnectionManagerInit` does declare both `dialTimeout` and `inboundUpgradeTimeout` (checked in its `.d.ts`). Issue #17 plans to restructure that file.
- **Still failing at 3 s, by design of scope:**
  - Optimystic's own 3 s RPC dials (upstream).
  - The strand wake, strand-address, seed-delivery and cohort-read deadlines (backlog).
  - The first-sync wait, sized from measurements at 1.8 s.
  - The stated 3 s ceiling is therefore true for the connections cadre opens itself, not yet for every path. The docs say so.
- **A longer `inboundUpgradeTimeout`** (14 s instead of 10 s) lets a peer that stalls its handshake hold a half-built connection 4 s longer. This is stated at `connectionManagerTimeouts`.
