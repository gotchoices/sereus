description: The peer-discovery library under Sereus gives up on a liveness ping after a fixed 2 seconds, shorter than a ping takes on the slowest link Sereus supports, and then treats the other member as gone, so each side of a two-machine strand writes alone and the two can end up holding different data. Needs a change in FRET and Optimystic.
architecture: docs/architecture.md#dial-budgets-are-counted-in-round-trips-not-milliseconds
files: ../Fret/packages/fret/src/service/fret-service.ts (`MAINTENANCE_RPC_TIMEOUT_MS` ~475, `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` ~487, `STABILIZE_TICK_BUDGET_MS` ~506, `STABILIZE_PHASE_ONE_BUDGET_MS` ~533, `applyContactStrike` ~1007, `probeNeighborLatency` ~3283), ../Fret/packages/fret/src/rpc/protocols.ts (`RPC_TIMEOUT_MS` ~27), ../Fret/packages/fret/src/service/live-member.ts, ../Fret/packages/fret/src/index.ts (`FretConfig`), ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`fretService({...})` ~1161), ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (`assembleServingCohortOnce` ~1826), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR`, "WHAT THE LINK NEEDS OF IT"), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts
repro: static
----

# FRET's maintenance pings time out below the link Sereus declares, and a missed ping removes a member from every cohort

**Blocked on a dependency outside this repo.** FRET (`p2p-fret`) fixes its maintenance deadlines as constants, and Optimystic constructs FRET without passing it the link round trip it already receives from cadre. Unblocks when FRET accepts the option proposed below and Optimystic passes its `linkRoundTripMs` through, in released versions Sereus can adopt. Read at FRET `6c04166` (p2p-fret 1.1.0) and Optimystic `28e6e044`.

GitHub gotchoices/sereus#48.

## What happens

FRET keeps the ring of peers that Optimystic builds every block's cohort from. Each stabilization tick pings the near peers over the connection that already exists (`probeNeighborLatency`, `dial: 'never'`) under `MAINTENANCE_RPC_TIMEOUT_MS` = 2 000 ms. A ping that times out is a contact strike (`noteRpcFailure` → `applyContactFailure` → `applyContactStrike`). Strikes at least 500 ms apart count as a run, and at `deadAfterFailures` (default 3; Optimystic does not set it) the peer's state becomes `dead`. The `isLiveMember` predicate (`live-member.ts`) excludes `dead` peers from every ring view, including `assembleCohort`. Optimystic's `assembleServingCohortOnce` builds a block's cohort from `fret.assembleCohort` only, so a `dead` member is in no cohort, and on a two-member strand each side's cohort becomes itself: it commits alone (`commit:solo-cohort`). The peer comes back only on proof of life: a new `peer:connect`, or the dead arm's re-probe, which pings under the same 2 s.

A ping costs a protocol negotiation plus the echo, two link round trips by `link-budget.ts`'s counts. A `newStream` over a relayed circuit measured 3 016 ms at 1 500 ms one-way (`DEFAULT_CONNECTION_MONITOR`'s comment in `packages/cadre-core/src/types.ts`). At the 3-second round trip Sereus supports (`docs/architecture.md` → "Dial budgets are counted in round trips, not milliseconds"), a ping takes about 6 s against FRET's 2 s. So on a link that is working inside its declaration, the connection stays up, but FRET removes the other member from the ring and the strand writes alone on both sides. That is one way the diverged end state in #48 can come about. Above 1 s one-way, even a ping that costs one round trip misses 2 s.

The other fixed FRET values in the same path are below the declared link too:

| constant | value | bounds | at the declared default (3 500 ms round trip) |
| --- | --- | --- | --- |
| `MAINTENANCE_RPC_TIMEOUT_MS` | 2 000 ms | one ping or announce over an open connection | needs two round trips, 7 000 ms |
| `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` | 1 000 ms | one neighbour-snapshot fetch over an open connection | needs two round trips plus up to 64 KiB, at least 7 000 ms |
| `STABILIZE_PHASE_ONE_BUDGET_MS` | 3 000 ms | phase 1 of a tick (pooled pings, then snapshot fetches) | must be at least one ping plus one snapshot |
| `STABILIZE_TICK_BUDGET_MS` | 5 000 ms | one whole stabilization tick | must be phase 1 plus one ping |
| `RPC_TIMEOUT_MS` | 5 000 ms | FRET's default whole-RPC budget, and `readFramed`'s default (Optimystic's cohort-topic frame reads use it) | needs two round trips for one hop |

FRET's tick invariants (`test/stabilize-budget-invariants.spec.ts`) tie the tick, phase-1 and ping budgets together, so the ping cannot simply be raised alone: a ping cut off by the tick budget is `cancelled`, which records nothing, neither strike nor proof of life.

The redial that opens a connection already follows the link: FRET 1.1.0 runs it under `FretConfig.dialTimeoutMs`, which Optimystic sets from its derived libp2p dial timeout. This ticket is the same change for the deadlines over an open connection.

## Proposed change (the recommended default)

**FRET:** add `FretConfig.linkRoundTripMs?: number`, the round trip of the slowest link the deployment supports, in the same sense as Optimystic's `NodeOptions.linkRoundTripMs`. When it is given, FRET derives its link-bound budgets from it as round-trip counts, never below today's constants: a maintenance ping or announce at two round trips (protocol negotiation plus the echo), a snapshot fetch at two round trips plus the transfer, phase 1 at one ping plus one snapshot, the tick at phase 1 plus one ping, and `RPC_TIMEOUT_MS`'s default at two round trips per hop. The tick invariants then hold over the derived values at every declaration, and the spec checks them at several. When it is not given, every value is today's constant. One declaration rather than one option per constant, because the constants are coupled by those invariants and a host setting them one by one can break them; this is the principle Optimystic already follows (`resolveLinkDeadlines`).

**Optimystic:** pass `options.linkRoundTripMs` into `fretService({...})` in `libp2p-node-base.ts` beside `dialTimeoutMs`.

**Sereus:** nothing beyond adopting the releases. cadre-core already states `NetworkConfig.linkRoundTripMs` to Optimystic on the control node and every strand node. On adoption, `docs/architecture.md` → "What Optimystic derives" gains FRET's maintenance deadlines, and `docs/cadre-consistency.md`'s deadline ladder (`strand-deadline-ladder`) moves these rows from "fixed" to "follows the declared link".

## Alternatives, and why they were not taken

- **One option per FRET constant** (`maintenanceRpcTimeoutMs`, `stabilizeTickBudgetMs`, …). More flexible, but it leaves the invariants between them to every embedder, and Optimystic would need to restate FRET's arithmetic to set them consistently.
- **Raise `deadAfterFailures`.** Optimystic could pass it today. It delays the removal by more 2 s misses, but every ping on the slow link still fails, so the peer still goes `dead`, only later, and FRET never records proof of life from it.
- **Count Optimystic's own traffic as proof of life** (a request answered by the peer clears its strike run). Worth having on its own, but it is a change in how FRET judges liveness, not a deadline fix, and on an idle strand there is no such traffic.
- **Assign FRET's private static constants from cadre-core at start-up.** They are `private static readonly` in TypeScript but writable at run time. It would work without upstream changes, but it reaches into another project's internals and breaks silently on any FRET refactor. Not proposed as an interim.

## What this does not fix

On the phone link of #48 the delay is not the declared round trip: each outbound frame waits behind every frame already queued, and frames were measured waiting 10-22 s (`complete/optimystic-ping-handler-timeout-below-the-monitor-deadline`). A ping derived from a 3 500 ms declaration (7 s) still misses there. Sizing deadlines from the measured response time above the declared floor is proposed in `blocked/decide-link-deadlines-from-measured-response-time`; this ticket fixes the case where the link is inside its declaration, which is a defect on its own.

## How to confirm

`repro: static`. FRET logs each strike as `change: contact strike <n> on <peer>` and each revival as `<peer> revived` under `optimystic:fret:service:fret`. The phone arm of `strand-workload-on-a-phone-link.integration.ts` counts both (its measurement is in the scenario's doc comment). Strikes against the other strand member followed by `commit:solo-cohort` confirm the chain on the phone link. A cleaner check on the declared link alone: the same scenario's rounds with `installWsLatency({ delayMs: 1500, mode: 'pipelined' })` and no event-loop load, which is the supported link with no queue.

## If nothing is done

Every relayed strand member whose ping takes more than 2 s drops out of the other's cohorts, though the connection stays up. Writes then succeed alone on each side and are owed to no one unless Optimystic records the missing member (`blocked/optimystic-write-made-alone-owes-no-one`). They reconcile only when FRET revives the peer, which on a slow link needs a ping that answers within 2 s.

## Reversibility

An optional configuration field whose absence is today's behaviour. Fully reversible.

## Measured on the phone-shaped link (2026-10-17, `strand-workload-count-driven-fixes`)

The phone arm of `strand-workload-on-a-phone-link.integration.ts` (20 ms serial frame cap, event loop 70% busy), on sereus 1.16.0, Optimystic 1.15.0 and p2p-fret 1.1.0, over the three rounds that crossed the link (188.6 s). Every line below is under the namespace `optimystic:fret:service:fret`, which carries no node, so each is attributed by the peer id it names.

- **Contact strikes: 74.** 37 on A's strand node (so logged by B's), 30 on B's, 7 on the relay. At most 8 followed a failed redial (`redial to … failed`); the rest are maintenance pings that missed 2 s. No FRET stream opened successfully during the rounds, against one ping and one neighbours request from each strand node on loopback.
- **Marked `dead`: 5.** The relay at 10:38:08.0 and 10:39:05.9; B's strand node at 10:38:50.6 (A's next 4 consults then found a cohort of only itself); A's at 10:39:53.8 and B's at 10:39:55.5. The last two are where the run's divergence starts: each of the remaining five rounds, from 10:39:57.0, committed alone on its writer (`commit:solo-cohort`), and those five rows never reached the other side.
- **`revived`: 0, though both strand nodes came back.** They returned on a new connection after each connection-monitor abort, 4-5 s later: `peer:connect` sets the peer `connected` and then logs `contact run cleared`, which writes no `revived` line. 47 `contact run cleared` in all.
- **Strikes keep the loop at its fastest.** Each strike calls `noteChange`, which resets the stabilization interval to its 1 500 ms base, so while pings keep failing the ring maintenance never backs off: B's ring struck A's strand node about every 5 s, A's struck B's about every 6 s. With deadlines that follow the link, fewer pings fail and the loop can back off. No separate change is proposed.

Above the declared link the queue, not the declaration, sets how long a ping takes: the worst observed send wait was 17.3 s during the rounds. See "What this does not fix" above.

## Rechecked at p2p-fret 1.2.1 (2026-10-20, `adopt-optimystic-1-17-0`)

Unchanged: `MAINTENANCE_RPC_TIMEOUT_MS` is 2 000, `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` 1 000, `STABILIZE_TICK_BUDGET_MS` 5 000, `STABILIZE_PHASE_ONE_BUDGET_MS` 3 000 (`fret-service.ts` ~501-559) and `RPC_TIMEOUT_MS` 5 000 (`rpc/protocols.ts` 27), and `FretConfig` has no `linkRoundTripMs`. FRET 1.2.0 added a dead-verdict grace for long-lived peers (`maxDeadGraceMs`, up to 5 minutes); it delays only the `dead` verdict for a peer seen up 10 minutes or more, and does nothing for a strand member that joined recently.

## Rechecked at Optimystic 1.19.0 (2026-10-25, `adopt-optimystic-1-19-0`)

Unchanged. p2p-fret is still 1.2.1: `../Fret` has no newer tag, and its HEAD is the 1.2.1 release commit `439b85e`. db-p2p 1.19.0 still declares `p2p-fret` ^1.2.1, and between `v1.18.0` and `v1.19.0` `libp2p-node-base.ts` changed only its commit-certificate sink, so Optimystic still builds FRET without the link round trip.
