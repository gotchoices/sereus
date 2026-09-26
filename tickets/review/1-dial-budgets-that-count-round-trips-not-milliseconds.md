description: Cadre's limits on how long it may spend reaching another machine were fixed numbers of seconds, chosen for a fast local network — and the most important of them was short enough that copying a workspace's data to a machine that had just rejoined had never once worked over a relay. They are now worked out from one stated assumption about how fast the connection is, so a deployment on a slow connection changes one number instead of a list of them.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (NEW — the declared link round trip, one round-trip count per operation, and the ceiling this change does not lift; read its doc comment first)
  - packages/cadre-core/test/link-budget.spec.ts (NEW — the derivation's own coverage)
  - packages/cadre-core/src/types.ts (NetworkConfig.linkRoundTripMs, beside cohortQueryTimeoutMs)
  - packages/cadre-core/src/peer-join-backfill.ts (derived push budgets; the backoff re-arm and the console.warn)
  - packages/cadre-core/src/relay-reservation.ts (DEFAULT_RELAY_RESERVE_TIMEOUT_MS now derived: 10_000 -> 8000)
  - packages/cadre-core/src/peer-dial.ts (control-cohort dial budgets derived; total 30_000 -> 32_000)
  - packages/cadre-core/src/cadre-node.ts (control catch-up construction, controlDialBudget, reserveRelays)
  - packages/cadre-core/src/strand-instance-manager.ts (strand catch-up construction, per-relay supervisors)
  - packages/cadre-core/src/seed-bootstrap.ts (comment only — the owner-dial ack bound moved with the cohort total)
  - packages/cadre-cli/src/config/types.ts (the declaration mirrored into file config)
  - packages/cadre-core/test/peer-join-backfill.spec.ts (the push-options assertion, and the backoff case)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (doc comment: the re-run, and the budgets-in-force table)
  - docs/architecture.md (Relay Integration -> "Dial budgets are counted in round trips, not milliseconds")
  - docs/testing.md ("Where measurements live" -> one sentence pointing at the derivation)
----

# Review: cadre's dial budgets are derived from a declared link round trip

## What the change is, in one paragraph

Opening a connection to another machine through a relay costs a fixed number of exchanges — four round trips between the two machines, measured — so any deadline written as a number of milliseconds has a link speed above which it can never open one, and the failure looks like an absent peer rather than a timeout. `NetworkConfig.linkRoundTripMs` (default 2000 ms) is now the one declared assumption, and `packages/cadre-core/src/link-budget.ts` holds one round-trip count per operation and does the arithmetic. Everything cadre owns that bounds a dial or a relay reservation reads from it.

## The numbers, before and after, at the default declaration

| budget | before | after | why that count |
| --- | --- | --- | --- |
| peer-join catch-up `dialTimeoutMs` | 3 000 | **8 000** | 4 round trips — a relayed dial |
| peer-join catch-up `responseTimeoutMs` | 10 000 | **10 000** (unchanged by construction) | 2 round trips + a 6 000 ms transfer allowance |
| `DEFAULT_RELAY_RESERVE_TIMEOUT_MS` | 10 000 | **8 000** | 4 round trips (see the gap list — measured work is 2) |
| control-cohort per-address dial | 8 000 | **8 000** (unchanged; now derived) | 4 round trips |
| control-cohort per-peer dial | 30 000 | **32 000** | 4 whole per-address attempts |

At a declared 3 000 ms link every one of those becomes 12 000 ms except the response deadline, which becomes 12 000 too (2 × 3 000 + 6 000).

## The defect this closes

The peer-join block catch-up exists so that a machine which joined (or rejoined) after blocks were committed physically ends up holding them. Its dial had 3 000 ms, and a relayed dial cannot finish in that at any one-way link delay above 375 ms — so over a relay, on any link slow enough to matter, that catch-up had **never once** been able to copy anything. Both budgets sereus already sized for relayed phones (the cohort read deadline and the first-sync budget) were chosen against a 1.8-second round trip, which is 900 ms one-way — well past where the catch-up died.

## What was measured, on this machine, for this change

`RELAY_DIAL_COST=1 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency` — 6 tests, all passed, ~2.5 min. A relayed dial took **20-25 ms** at no delay, **7 255-7 279 ms at 900 ms one-way**, and **12 066-12 094 ms at 1 500 ms one-way**, across both listener arms. That is within about 40 ms of the figures already in the instrument's doc comment, and 60-95 ms *above* four round trips of pure delay (the handshakes). Both halves of the libp2p ceiling reproduced too: at 1 500 ms one-way the dial under libp2p's own 10 s default failed with `The operation was aborted due to timeout`, and with the shipped 10 s inbound-upgrade budget the dialer's 12 094 ms dial resolved while the listener had already discarded the connection, so the first stream died with `Unexpected EOF - stream closed while reading 0/1 bytes`.

The instrument's doc comment now carries the re-run and a corrected budgets-in-force table. It remains the single home of the numbers.

## The open question the ticket asked to settle: the repeating `connection:open`

**Answer, confirmed statically — not with a DEBUG run.** The founder's side kept receiving a fresh `connection:open` for the rejoining machine because Optimystic's `RebalanceMonitor` (`../optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts:285`) subscribes to `connection:open`/`connection:close` and pushes through `BlockTransferCoordinator.pushBlock`, which passes `transferTimeoutMs ?? 30000` as **both** the dial and the response deadline (`cluster/block-transfer.ts:104,457`). 30 s is the only dial budget anywhere in the stack above the measured 12 s relayed setup cost, so that dial kept succeeding while the catch-up's 3 s one could not. For contrast, `SpreadOnChurnMonitor` — which the old `dialTimeoutMs: 3000` comment cited — really does use 3 000 ms (`cluster/spread-on-churn.ts:90`) and triggers on `connection:close`, so that comment was accurate and is unchanged.

**What would confirm it directly**, and was not run: the 2026-09-26 relayed reproduction at 1 500 ms one-way under `DEBUG='sereus:cadre*,optimystic:db-p2p:*'`, looking for the rebalance push's dial immediately before each `connection:open`. The chain above is read from code, so treat it as `static`.

## The retry decision, and where it lives

A catch-up run that does not finish cleanly now **re-arms on a doubling backoff** (`retryBackoffMs` 5 000 → `maxRetryBackoffMs` 60 000) instead of waiting for the next `connection:open`, and a `connection:open` arriving inside that wait is **dropped** rather than collapsing the wait back to the debounce. Both halves matter: without the re-arm a transient failure left a peer partially copied until its next reconnect; without dropping churn, a peer that cannot be reached at all was re-dialled on every connection event forever — which is exactly what the reproduction showed at ~14.5-second intervals for a 200-second run.

Two deliberate exemptions, both stated in the code:

- **A denied run does not back off.** The membership gate answering "no" is a policy answer, and the control network's join order is connect-then-authorize, so the retry is driven on purpose by `scheduleConnectedPeers()` the moment the membership commit lands. Backing that off would delay every control-network join.
- **The re-arm is gated on `started`.** A caller driving `catchUpPeer` by hand against a backfill that was never started owns its own retry policy and is not left holding a background timer.

And the failure is now legible: after `PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES` (3) consecutive failures, one `console.warn` per peer names the peer, both budgets, and the ceiling — because otherwise a machine on a too-slow link says nothing at all.

## Tests

| test | what it verifies |
| --- | --- |
| `test/link-budget.spec.ts` → "multiplies each operation's round-trip count…" | the arithmetic, and that a host declaration moves every budget together (not just one) |
| `test/link-budget.spec.ts` → "scales only the latency part of a circuit request…" | the transfer allowance stays flat when the declared link doubles — a slow-link declaration must not inflate a bandwidth budget |
| `test/link-budget.spec.ts` → "refuses a declaration that is not a finite number above zero" | the validation branch; 0 would mean "give up at once" and `NaN` "never time out", both silent |
| `test/peer-join-backfill.spec.ts` → "re-arms a failed catch-up on a backoff, and drops connection churn inside that wait" | the retry decision above: 20 `connection:open` events inside the wait cost nothing, and the retry still fires without one |
| `test/peer-join-backfill.spec.ts` → the push-options assertion (edited, not added) | the derived pair actually reaches `pushBlocks`; asserts `peerJoinPushBudget()` rather than literals, so it does not have to be edited by the next declaration change |

**No wiring test was added** for the two construction sites threading `network.linkRoundTripMs`, nor for `controlDialBudget`. That follows the ticket and the repo's own bar — the existing `cadre-node-control-node-options.spec.ts` / `strand-instance-manager-cluster-size.spec.ts` pattern pins one call site each for `cohortQueryTimeoutMs` and a second copy of that shape buys nothing. It is a real gap all the same: see below.

## Validation run

- `yarn lint` — clean. `yarn typecheck` — clean.
- `yarn workspace @serfab/cadre-core build` — clean; `test` — **140 files, 2 280 passed, 1 skipped**.
- `yarn workspace @serfab/cadre-cli build` — clean (needed for the integration suite's stale-build guard).
- `relayed-dial-cost-by-latency` (opt-in) — 6/6 passed, numbers above.
- `blind-relay-phone-to-phone-e2e` — **both arms passed**, the 10 ms latency arm in 7 740 ms. No committed duration budget exists on that scenario, so "did not get slower" is an eyeball against its normal band, not an assertion. The derived budgets are timeouts, so a fast link cannot spend them unless something is waiting one out.
- Every scenario that touches the catch-up — `control-delete-while-alone-convergence`, `control-offline-read-after-restart`, `strand-late-cadre-join`, `strand-membership-second-machine`, `strand-membership-closed-strand-e2e`, `strand-two-party-two-machine`, `strand-formation-concurrent-redemption` — **20 tests, all passed**. No scenario pins any of these budgets (grepped for `dialTimeoutMs`, `responseTimeoutMs`, `strandBackfill`, `controlBackfill`, `controlCohort` across `packages/integration-tests/src`), so nothing depended on the old 3 000 ms catch-up failing fast.

No pre-existing failures surfaced.

## Known gaps, for the reviewer

- **The band this fixes has no end-to-end coverage.** The argument that the catch-up now lands over a relay between 375 ms and 1 250 ms one-way is arithmetic plus a **bare-libp2p** measurement — no cadre scenario runs a relayed catch-up at a slow link and observes blocks arriving. The nearest committed relayed coverage is `blind-relay-phone-to-phone-e2e`'s 10 ms arm, which is far below where the old budget broke. This is the single biggest thing left unproven, and `debt-relay-scenarios-never-see-link-latency` is the existing ticket in that area.
- **`RELAY_RESERVATION_ROUND_TRIPS = 4` is a judgement, not a measurement.** The protocol work measured is 2 round trips (dial the relay, request the reservation). 4 was chosen so the drive can also contain a discovery-driven repeat of both legs, and so its own ceiling (2 000 ms one-way) stays above the stack's 1 250 ms one. The visible consequence is that the drive's deadline **dropped from 10 000 to 8 000 ms**, which shortens `CadreNode.start()`'s wait against an unreachable relay by 2 s. Worth a second opinion on whether 4 is the right count or whether the reservation drive should simply not be derived.
- **`PUSH_TRANSFER_ALLOWANCE_MS = 6 000` is unmeasured** and carries a `NOTE:` saying so at its site. It is the residue of the 10 000 ms the response deadline shipped as, picked so the default value did not move. Nobody has measured how long a 1 MiB chunk takes to cross a relayed mobile link.
- **`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` changed value** (30 000 → 32 000) because it is now `CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS` (4) whole per-address budgets. The count comes from that constant's own pre-existing comment ("two to four addresses a phone can dial"); the old flat 30 000 left only 6 s after three dead addresses, which covers the 1.6 s direct dial it cited but not the relayed dial the per-address limit exists to cover. That arithmetic error is corrected in the comment.
- **The default declaration does not reach libp2p's ceiling.** 2 000 ms derives 8 000 ms for a relayed dial, covering one-way delays up to 1 000 ms, while libp2p abandons the connection at about 1 250 ms one-way. A deployment in that 250 ms band must declare its own `linkRoundTripMs` (about 2 200-2 500). Stated in `link-budget.ts`; whether the default should simply be 2 500 is a fair question for review.
- **`PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES = 3` is reasoned, not swept.** At the default backoff it fires about 35 s in.
- **A tripwire, parked as a `NOTE:` in `peer-join-backfill.ts`:** the backoff re-arm fires whether or not the peer is still connected, because this module subscribes only to `connection:open`. A peer that disconnected mid-backoff costs one extra dial attempt. Cheap at the connection counts these meshes hold; the fix if it ever matters is a `connection:close` subscription, not a shorter backoff.
- **`linkRoundTripMs` is mirrored only into `@serfab/cadre-host` and the reference apps by passing `NetworkConfig` through** — neither declares its own copy of the field, same as `cohortQueryTimeoutMs`. Only `@serfab/cadre-cli`'s file config needed the explicit mirror, and got it.
- **The ceiling above 1 250 ms one-way is untouched**, by design: `tickets/blocked/how-slow-a-relayed-link-does-sereus-carry` owns it. `link-budget.ts`'s module doc is where a reader who widens these numbers and still cannot connect at 1 500 ms one-way lands.

## Things worth attacking in review

- Whether `resolveLinkRoundTripMs` throwing from deep inside a budget computation lands anywhere useful. The claim is that it surfaces where the libp2p node is built (`CadreNode.start()` / `addStrand`), matching `cohortQueryTimeoutMs`. That claim is argued, not tested — the control path reaches it through `controlDialBudget()` and the control catch-up construction, and a bad declaration on a host that runs neither would go unnoticed until the first dial.
- Whether the control catch-up's spread order is right: `cadre-node.ts` puts `...peerJoinPushBudget(...)` **before** `...this.config.controlBackfill`, so a host's explicit `controlBackfill.dialTimeoutMs` wins. Same shape on the strand side. The `debounceMs: 250` that precedes it is untouched.
- `resumeStrand` retaining `network` was checked, not assumed: `resumeStrand` spreads the retained `launchConfig`, `buildStrandRuntime` reads `config.network?.linkRoundTripMs` for both the catch-up and the per-relay supervisors, so a hibernation wake picks up the declaration with no new plumbing.
