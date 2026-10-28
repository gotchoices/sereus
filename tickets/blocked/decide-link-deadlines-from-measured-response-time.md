description: Sereus sizes its network time limits as fixed multiples of a declared link speed, so on a phone link whose send queue grows with traffic, requests are given up on while their answers are only queued, and each one re-sent makes the queue longer. Proposes that each limit also stretch to the response time actually measured from that peer, the way TCP sizes its retransmit timer; needs a human to accept the design rule.
architecture: docs/architecture.md#dial-budgets-are-counted-in-round-trips-not-milliseconds
files: docs/architecture.md ("The declared value" ~2066, "What Optimystic derives" ~2074), docs/cadre-consistency.md ("Deadlines Below Cadre"), packages/cadre-core/src/link-budget.ts (`cohortReadDeadlineMs`), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (its doc comment holds the measurement), ../optimystic/packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, read only), ../Fret/packages/fret/src/rpc/outcome.ts (`rttMs`, read only), ../Fret/packages/fret/src/service/fret-service.ts (`applySuccess`, read only)
----

# Size link deadlines from measured response time, with the declared link as the floor

**Blocked: a change to a stated design principle.** `docs/architecture.md` → "Dial budgets are counted in round trips, not milliseconds" makes every link deadline a count of the *declared* round trip (`NetworkConfig.linkRoundTripMs`, 3 500 ms by default). Unblocks when a human accepts or edits the principle text below. The mechanisms then go upstream as proposals to Optimystic and FRET, which own the deadlines that fire.

GitHub gotchoices/sereus#48.

## What the phone-link measurement shows

From the phone arm of `strand-workload-on-a-phone-link.integration.ts` (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy; two-member strand, 8 rounds of one write and a six-table read), run 2026-10-17 on sereus 1.16.0, Optimystic 1.15.0 (`28e6e044`), p2p-fret 1.1.0 (`6c04166`). The scenario's doc comment has the full counts and how each was taken.

- **The clean workload alone overruns the deadline.** One round with nothing timing out (measured on loopback) puts 472-476 frames on the busiest socket: 9.5 s at the cap's 20 ms a frame. The smallest deadline a strand read or write waits on that follows the declared link is the 7 s a cohort peer gets to answer a read (`cohortQueryTimeoutMs`, two declared round trips). The busy event loop releases fewer than 50 frames a second, so 9.5 s understates.
- **On the phone link the queue then grew.** The busiest socket carried 17.2 s of frames per round that crossed the link, 45% beyond the clean workload. Worst observed send wait: 17.3 s during the rounds, 27.6 s over the whole arm.
- **Every request with a fixed deadline missed it.** All 53 read-repair consults the strand nodes sent during the rounds found the other member silent at 7 s, and all 224 in the 180 s after. FRET's 2 s maintenance ping failed 67 times against the strand nodes. The pinged side's 10 s ping handler reset 9 connection-monitor pings, and each reset aborted a connection.
- **Outcome.** The writes of rounds 1-3 failed. FRET marked both strand nodes `dead`, the remaining five rounds each committed alone, and the two sides ended holding different rows that did not converge in 180 s.

The decision rule this was filed under (`strand-workload-count-driven-fixes`): when one clean round already occupies the socket for at least half the 7 s read deadline (here 9.5 s against 3.5 s), the work alone builds a queue that crowds a deadline counted in declared round trips, and cutting retries cannot be enough. Cutting them still helps: retries were 48% of the requests beyond the clean workload with FRET's and libp2p's pings excluded, 28% with them (`complete/optimystic-retries-do-not-back-off`, shipped in Optimystic 1.16.0).

## Proposed text (the recommended default)

A new paragraph in `docs/architecture.md`, after "**The declared value.**":

> **Measured response time.** A deadline over an open connection to a peer is the larger of its count of declared round trips and the same count of that peer's measured response time. The measured time is a smoothed average plus four times its smoothed variation, as TCP sizes its retransmit timer (RFC 6298): each answered request updates it, and an answer to a request that was sent more than once does not, since it cannot be matched to one attempt. The declared value stays the floor and the starting estimate before any sample exists, so a deadline never falls below what the declaration gives, and a peer not yet heard from is waited on exactly as today. A ceiling bounds the stretch (RFC 6298 allows one no lower than 60 s), so a peer that stopped answering is still given up on. A deadline that opens a connection stays declared: before the connection exists there is no response from that peer to measure.

Why: the declaration is fixed, and a send queue is not. Where a link's cost is per frame, the queue grows with traffic, so a deadline counted in declared round trips gives up on requests whose answers are only queued. Each request given up on is re-sent, which lengthens the queue that made it late. A deadline that follows the measured response time stretches as the queue does, so the request is answered instead of re-sent. That removes the feedback instead of moving the traffic level at which it starts.

**Who would hold the estimator.** The deadlines that fired here are Optimystic's per-peer cohort read (`cohortQueryTimeoutMs`), its consensus request response (`responseTimeoutMs`), and FRET's maintenance ping (`MAINTENANCE_RPC_TIMEOUT_MS`), so Optimystic and FRET would each keep a per-peer estimate. FRET already records each answered request's `rttMs`, but from after the stream opens; a sample for this purpose should start when the request is issued, so that it includes the wait to open the stream behind the queue. This ticket proposes the principle, not the mechanism; each project designs its own estimator.

**Sereus's side once accepted:** the paragraph above; `docs/cadre-consistency.md` → "Deadlines Below Cadre" marks each row that stretches as the upstream releases land; cadre-core's `cohortReadDeadlineMs` becomes the floor Optimystic stretches above. cadre-core's own dial budgets stay declared (they open connections).

## Alternatives, and why they were not taken

- **Declare a larger link on phone deployments** (`linkRoundTripMs`). The declaration is fixed and the queue is not, so a larger one only raises the traffic at which the queue overruns it, and it stretches every deadline for every peer all the time, including dials to peers that are really gone. A phone run with a larger declaration was not made.
- **A fixed queueing allowance added to every deadline.** The same failure, a constant against a queue that grows with traffic, and its cost is paid on every link.
- **Only reduce traffic.** Retry backoff (`complete/optimystic-retries-do-not-back-off`, in Optimystic 1.16.0) and joining a turn's WebSocket sends into one frame (`backlog/feat-websocket-sends-coalesced-per-turn`, which cut a Galaxy S7's sends by 62%) both shorten the queue, and both are worth having. But the clean workload is already past the deadline: at 62% fewer frames a round would occupy the socket about 3.6 s, at the bar, and an app with more tables or more rows is past it again.

## Related tickets

- `blocked/fret-maintenance-deadlines-below-the-declared-link` derives FRET's maintenance deadlines from the declared link. That is the floor this proposal stretches above, and it is a defect on its own on a link inside its declaration.
- `complete/optimystic-retries-do-not-back-off` (Optimystic 1.16.0): RFC 6298 also doubles its timer after each timeout; that ticket applied the same idea to the re-send, and this one applies it to the deadline.
- `complete/optimystic-ping-handler-timeout-below-the-monitor-deadline` (Optimystic 1.16.0): the pinged side's handler now waits 60 s, so on the phone-shaped link the pinging side's own 30 s deadline is the one that fires (8 of 14 connection aborts in one run of the slow-relay frame-cap arm on 2026-10-20).

## If nothing is done

On a link whose per-frame cost queues one round's frames for longer than 7 s, which the harness's phone-shaped link does with a six-table app, every strand read consult is given up on and asked again, writes fail, FRET marks the other member `dead`, and the two sides write alone and end holding different data.

## Reversibility

The principle is one paragraph. Its mechanisms would be upstream options whose absence is today's behaviour (the declared count alone), so it can be reversed, at the cost of the upstream releases that carry it.

## How to confirm

The phone arm: `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`. With measured-response deadlines upstream, `cohort silent` and `FRET contact strike` should fall towards zero while both members are up, no round should commit alone, and the arm should converge.

## Measured with retry backoff and the 60 s ping handler (2026-10-20, `adopt-optimystic-1-17-0`)

One run of the phone arm on Optimystic 1.17.0 and p2p-fret 1.2.1, with `DEBUG` on `coordinator-repo`, `batch-coordinator`, `network-transactor` and the connection monitor (log `tickets/.logs/adopt-optimystic-1-17-0.phone.log` until pruned). It was slower than the 2026-10-17 run in every phase it reached, and was stopped by the command limit during round 4:

| | 2026-10-17 (Optimystic 1.15.0) | 2026-10-20 (Optimystic 1.17.0) |
|---|---|---|
| B writable after joining | 45.4 s | 41.4 s |
| B's seat | first attempt, 94.4 s | first attempt failed after 340.5 s (`Some peers did not complete … Failed to get super-majority`); second attempt 29.9 s |
| seated after joining | 163.9 s | 440.2 s |
| round 1 | 90.6 s | 322.2 s, its `Ledger` write failed |
| round 2 | 94.8 s | 173.8 s, its `Invoice` write failed |
| round 3 | 3.1 s | 154.0 s, its `Ledger` write failed |
| `aborting connection due to ping failure` | 9, over the rounds | 55, over the whole arm until it was stopped in round 4 |

The backoff was in effect (coordinator retries waited 3.5 s, or as long as the failed request was outstanding; silent consults held the next one for 3.5 s, 7 s, 14 s). This is one run against one, on a link whose earlier runs varied widely (the 2026-10-17 measurement's own first run failed in setup), so it is not attributed. The 2026-10-13 experiment on `complete/optimystic-ping-handler-timeout-below-the-monitor-deadline` saw the same direction with the handler raised alone: connections that stay up stay saturated. Measure a series before reading it as a regression.

## Optimystic 1.19.0 (2026-10-25, `adopt-optimystic-1-19-0`)

The phone-arm series was not run. The arm's last run took 3 464 s (`adopt-optimystic-1-17-0`), and one command here may run for 10 minutes, so a series needs a human or CI. 1.19.0 moves no deadline in `docs/cadre-consistency.md` → "Deadlines Below Cadre" (re-stamped at `f1f774ea`). Two of its changes bear on this arm: a write to several tables or indexes now sends one request per member per phase, not one per table, index and `unique` column (gotchoices/Optimystic#42), which shrinks the joiner's seat and membership commits, and a change event from such a commit waits up to 10 s for its other tables (`DEFAULT_CHANGE_HOLD_MS`). Neither changes how a deadline is sized, so the proposal stands as written.

## Optimystic 1.20.0 (2026-10-28, `adopt-optimystic-1-20-0`)

The phone-arm series was not run, for the same reason as at 1.19.0 (one run takes about an hour, one command here may run for 10 minutes). 1.20.0 moves no deadline in `docs/cadre-consistency.md` → "Deadlines Below Cadre" (re-stamped at `59679072`); its one new timing value, the reachability gate's 500 ms wake debounce (`DEFAULT_WAKE_DEBOUNCE_MS`), runs only with offline mode on. Two changes bear on this arm. A read none of whose coordinators answered a block now returns that block as unreachable instead of failing the whole read, so a slow link fails fewer whole reads. And a phone with strand offline mode on resolves its writes locally and sends them when its cohort answers, which takes the write's network wait off the app but not off the link. Neither changes how a deadline is sized, so the proposal stands as written.
