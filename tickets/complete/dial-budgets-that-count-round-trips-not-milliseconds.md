description: Cadre's limits on how long it may spend reaching another machine were fixed numbers of seconds, chosen for a fast local network — and the most important of them was short enough that copying a workspace's data to a machine that had just rejoined had never once worked over a relay. They are now worked out from one stated assumption about how fast the connection is, so a deployment on a slow connection changes one number instead of a list of them.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (NEW — the declared link round trip, one round-trip count per operation, and the ceiling this change does not lift)
  - packages/cadre-core/test/link-budget.spec.ts (NEW — the derivation's own coverage)
  - packages/cadre-core/src/types.ts (NetworkConfig.linkRoundTripMs, beside cohortQueryTimeoutMs)
  - packages/cadre-core/src/peer-join-backfill.ts (derived push budgets; the backoff re-arm, its gating, and the console.warn)
  - packages/cadre-core/src/relay-reservation.ts (DEFAULT_RELAY_RESERVE_TIMEOUT_MS now derived: 10_000 -> 8000)
  - packages/cadre-core/src/peer-dial.ts (control-cohort dial budgets derived; total 30_000 -> 32_000)
  - packages/cadre-core/src/cadre-node.ts (control catch-up construction, controlDialBudget, reserveRelays, the start() pre-flight check)
  - packages/cadre-core/src/strand-instance-manager.ts (strand catch-up construction, per-relay supervisors, the buildStrandRuntime pre-flight check)
  - packages/cadre-core/src/seed-bootstrap.ts (comment only)
  - packages/cadre-cli/src/config/types.ts (the declaration mirrored into file config)
  - packages/cadre-core/test/peer-join-backfill.spec.ts (push-options assertion; three retry cases)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (doc comment: the re-run, and the budgets-in-force table)
  - packages/reference-app-rn/src/host-node-request.ts (comment only — the per-peer dial limit it quotes)
  - docs/architecture.md (Relay Integration section, and the NetworkConfig listing)
  - docs/testing.md ("Where measurements live")
----

# Cadre's dial budgets are counted in link round trips

Implement commit `f1799b1`; review fixes in the commit carrying this ticket.

## What is true now

Opening a connection to another machine through a relay costs a fixed number of exchanges — four round trips between the two machines, measured — so any deadline written as a number of milliseconds has a link speed above which it can never open one, and the failure looks like an absent peer rather than a timeout. `NetworkConfig.linkRoundTripMs` (default 2000 ms) is the one declared assumption; `packages/cadre-core/src/link-budget.ts` holds one round-trip count per operation and does the arithmetic. Everything cadre owns that bounds a peer-join catch-up push, a relay reservation drive, or a control-cohort dial reads from it.

| budget | before | after | count |
| --- | --- | --- | --- |
| peer-join catch-up `dialTimeoutMs` | 3 000 | **8 000** | 4 round trips — a relayed dial |
| peer-join catch-up `responseTimeoutMs` | 10 000 | **10 000** (unchanged by construction) | 2 round trips + a 6 000 ms transfer allowance |
| `DEFAULT_RELAY_RESERVE_TIMEOUT_MS` | 10 000 | **8 000** | 4 round trips |
| control-cohort per-address dial | 8 000 | **8 000** (unchanged; now derived) | 4 round trips |
| control-cohort per-peer dial | 30 000 | **32 000** | 4 whole per-address attempts |

The defect this closes: the peer-join block catch-up exists so that a machine which joined after blocks were committed physically ends up holding them. Its dial had 3 000 ms, and a relayed dial cannot finish in that above 375 ms of one-way link delay — so over a relay, on any link slow enough to matter, that catch-up had never once been able to copy anything.

A catch-up whose push failed now re-arms on a doubling backoff (5 000 ms to 60 000 ms) instead of waiting for the next `connection:open`, and a `connection:open` arriving inside that wait is dropped rather than collapsing it back to the debounce. After three consecutive failures one `console.warn` per peer names the peer, both budgets and the ceiling.

**The ceiling is untouched, by design.** Above roughly 1 250 ms one-way, two libp2p budgets of 10 000 ms each abandon the connection before any cadre deadline is consulted, and the listener's is the one that makes the failure silent. `tickets/blocked/how-slow-a-relayed-link-does-sereus-carry` owns that.

## Measurement

`RELAY_DIAL_COST=1 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency` — 6 tests, ~2.5 min. A relayed dial took 20-25 ms at no delay, 7 255-7 279 ms at 900 ms one-way, 12 066-12 094 ms at 1 500 ms one-way. That instrument's doc comment remains the single home of the numbers.

## Review findings

Read the implement diff first, then the handoff. Checked: the derivation and every call site threading it; the retry state machine against churn, denial, disconnection and permanent verdicts; the docs the change touched and the ones it did not; every constant and comment elsewhere in the tree that quotes a number this change moved; the CLI config plumbing; the test fakes.

### Fixed in this pass

**The backoff re-armed on outcomes a retry cannot change.** This is the one finding with real cost, and it was introduced by the implement pass. `catchUpPeer` re-armed on any non-clean run except a denial — but `clean` also goes false when the raw storage implements no `listBlockIds` (the catch-up is inert, permanently), and when the receiver reports blocks in `missing`. That second one is not an edge case: the receiver refuses, per block, any revision pushed without a retained cohort commit proof when it runs the default `requirePushCertificate: true`, and the sender's own `Chunk.proofs` comment already states that an unretained proof is the ordinary case. So on any node holding one such block, every peer's catch-up would have been permanently non-clean, and the new backoff would have re-pushed the whole store (up to 10 000 blocks in 1 MiB chunks) to that peer every 60 seconds for the life of the node — and then reported it on `console.warn` as a link budget problem, which it is not. `runCatchUp` now returns `pushFailed` (at least one push threw, which is what a dial or response deadline expiring looks like) and only that re-arms. The three verdict cases still leave the peer un-memoized, so its next `connection:open` retries, which is the behaviour that predates the backoff and the right one for a verdict. `packages/cadre-core/src/peer-join-backfill.ts`; new case "does not re-arm when the receiver REFUSED the blocks".

**The re-arm fired for a peer that was no longer connected.** The handoff parked this as a tripwire saying it "costs one more dial attempt". It does not: the backoff is already at its 60 000 ms ceiling after four failures, so a peer that connected once, failed, and went away was dialed once a minute for the rest of the node's uptime. This module's trigger is `connection:open`, so a peer that went away already has its retry. The re-arm now checks `libp2p.getConnections(peerId)` at the point the decision is made. The NOTE at the site now states the residue that remains — a peer disconnecting *inside* an armed wait still costs that one attempt — which is the bounded claim the old one was making. New case "does not re-arm a peer that is no longer connected".

**`linkRoundTripMs` was documented as refused at startup, and was not.** Three doc comments (`types.ts`, `link-budget.ts`, the cadre-cli config mirror) promise that a value which is not a finite number above zero fails where the libp2p node is built. Every consumer of it is conditional — a node with no control storage builds no catch-up, a node with no relay addrs drives no reservation, `controlDialBudget()` is not called until a reconcile pass — so a node with a zero or `NaN` declaration would have booted and thrown later inside a best-effort path that logs and carries on. `CadreNode.start()` and `StrandInstanceManager.buildStrandRuntime` now call `resolveLinkRoundTripMs` eagerly in their config pre-flight, which makes the promise true for `start`, `addStrand` and `resumeStrand`. The `link-budget.ts` doc also claimed this was "the same place `cohortQueryTimeoutMs` refuses a bad value" — cadre-core does not validate that field at all; Optimystic refuses it when the node is built. Reworded to say what actually happens.

**Two stale numbers the change moved but did not follow.** `packages/reference-app-rn/src/host-node-request.ts` reasoned its 60 s connect wait as "two full dials at 30 s"; the per-peer limit is 32 s now and derived, so the arithmetic and the fixed framing are both corrected. And `docs/architecture.md`'s `NetworkConfig` listing — the code block that documents the interface field by field, including `cohortQueryTimeoutMs`, the field this one is explicitly modelled on — never gained `linkRoundTripMs`. Added, with the cost of raising it and the point above which it buys nothing.

### Filed

**`backlog/debt-three-more-dial-deadlines-ignore-the-declared-link`.** `link-budget.ts` states that it is the only place a new dial's budget should be written, and `docs/architecture.md` now says cadre declares the link once rather than carrying a list of independently chosen timeouts. Three pre-existing cadre-owned dial deadlines do not follow that: `DEFAULT_WAKE_TIMEOUT_MS` / `DEFAULT_WAKE_DIAL_BUDGET_MS` (10 s and 20 s, and the wake path dials the relay address *first*), `DEFAULT_ADDR_TIMEOUT_MS` (10 s) and `DEFAULT_SEED_DELIVER_TIMEOUT_MS` (10 s). Nothing is broken at the shipped default, which is why it is `debt-` rather than a bug — it becomes wrong the first time someone declares a slower link for the reason the setting exists, because half their dial budgets move and half stay at a value that cannot open a relayed connection above 1 250 ms one-way. Filed at the class level, not per site: the ticket asks for the counts *and* for a check that the rule is followed by the next dial added, because this is already the second instance. It also carries the smaller seed arm — the sender's fixed 10 s deliver deadline against a receiver ack that this change let grow to 32 s and beyond.

### Weighed and left alone

- **`RELAY_RESERVATION_ROUND_TRIPS = 4` when the measured protocol work is 2**, dropping the reservation drive's deadline from 10 000 to 8 000 ms. The handoff asked for a second opinion. Accepted as is: the count is argued at its site (the wait may instead be satisfied by libp2p's own relay discovery, which repeats both legs), 8 000 ms is still twice the measured work, and the previous 10 000 was not derived from anything. The visible cost — `CadreNode.start()` waits 2 s less against an unreachable relay — is in the right direction.
- **Whether the default declaration should be 2 500 rather than 2 000**, to reach the 1 000-1 250 ms one-way band libp2p still allows. Left at 2 000. Raising it lengthens every failure path by 25 % for every deployment in order to serve a 250 ms band, and a deployment in that band can declare its own — which is stated in `link-budget.ts`.
- **`PUSH_TRANSFER_ALLOWANCE_MS = 6 000` is unmeasured.** It carries a `NOTE:` saying so, and it is the residue of the value the deadline already shipped as, so nothing got worse. Measuring it needs a throughput measurement over a relayed mobile link that nobody has.
- **`PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES = 3` is reasoned, not swept.** Fine — it now fires only on genuine push failures, so its message is accurate.
- **`cadre-node.ts` and `strand-instance-manager.ts` spread `peerJoinPushBudget(...)` before the host's own backfill config**, so an explicit `dialTimeoutMs` still wins. Checked both; correct and consistent.
- **`resumeStrand` picking up the declaration.** Verified rather than assumed: it spreads the retained `launchConfig`, and `buildStrandRuntime` reads `config.network?.linkRoundTripMs` for the catch-up, the per-relay supervisors and now the pre-flight check.
- **The cadre-cli mirror is only type fields.** That is the whole mirror — `loader.ts` passes `fileConfig.network` through as one object and `node-session.ts` hands it to `CadreNode`, exactly as `cohortQueryTimeoutMs` travels.
- **No test was added for the two construction sites or for `controlDialBudget`.** Agreed with the handoff; a second copy of the existing one-call-site pattern buys nothing, and the derived pair is already asserted where it reaches `pushBlocks`.

### Not covered, and knowingly so

The band this fixes — a relayed catch-up between 375 ms and 1 250 ms of one-way delay — still has no end-to-end coverage. The argument that it now lands is arithmetic plus a bare-libp2p measurement; no cadre scenario runs a relayed catch-up at a slow link and watches blocks arrive. The nearest committed relayed coverage is `blind-relay-phone-to-phone-e2e`'s 10 ms arm, far below where the old budget broke. This is unchanged from the handoff and is owned by the existing `backlog/debt-relay-scenarios-never-see-link-latency`; no new ticket.

## Validation

- `yarn lint` — clean. `yarn typecheck` — clean.
- `yarn workspace @serfab/cadre-core build` — clean; `test` — **140 files, 2 282 passed, 1 skipped** (2 280 before; the two additions are the retry cases above).
- `yarn workspace @serfab/cadre-cli build` — clean (the integration suite's stale-build guard needs it).
- Every scenario that touches the catch-up, re-run after the retry change — `strand-membership-closed-strand-e2e`, `control-offline-read-after-restart`, `control-delete-while-alone-convergence`, `strand-late-cadre-join`, `strand-membership-second-machine`, `strand-two-party-two-machine`, `strand-formation-concurrent-redemption` — **20 tests, all passed**.
- `blind-relay-phone-to-phone-e2e` — both arms passed, the 10 ms latency arm in 6 715 ms.
- `relayed-dial-cost-by-latency` (opt-in) was run by the implement pass, not re-run here — nothing in the review touched what it measures.

No pre-existing failures surfaced.
