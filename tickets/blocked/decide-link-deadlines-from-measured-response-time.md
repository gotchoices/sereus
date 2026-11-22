description: Sereus sizes its network time limits as fixed multiples of a declared link speed, so on a phone link whose send queue grows with traffic, requests are given up on while their answers are only queued, and each one re-sent makes the queue longer. Proposes that each limit also stretch to the response time actually measured from that peer, the way TCP sizes its retransmit timer. The maintainer accepted this rule; the time limits belong to two other projects, Optimystic and FRET, so it now waits on their releases.
architecture: docs/network/deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds
files: docs/network/deadlines.md ("Dial budgets are counted in round trips, not milliseconds", "What Optimystic derives, and what cadre-core states on top", "Deadlines below cadre"), packages/cadre-core/src/link-budget.ts (`cohortReadDeadlineMs`), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (its doc comment holds the measurement), ../optimystic/packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, read only), ../Fret/packages/fret/src/rpc/outcome.ts (`rttMs`, read only), ../Fret/packages/fret/src/service/fret-service.ts (`applySuccess`, read only)
----

**Re-checked 2026-11-20 on `@optimystic/*` 1.29.0: still blocked.** Neither 1.28.0 nor 1.29.0 changes how link deadlines are derived; upstream `feat-link-deadlines-stretch-to-measured-response-time` is still in its backlog.

**Re-checked 2026-11-12 on `@optimystic/*` 1.27.0: still blocked.** 1.27.0 does not change how link deadlines are derived.

# Size link deadlines from measured response time, with the declared link as the floor

**Blocked: a dependency outside this repo.** The maintainer accepted the principle below on 2026-11-03, and its text is now in `docs/network/deadlines.md` → "Limits and accepted tradeoffs", marked as not yet followed. Unblocks when Optimystic and FRET, which own the deadlines that fire, release per-peer estimators. Passed to Optimystic's session the same day: its backlog holds `feat-link-deadlines-stretch-to-measured-response-time`, and FRET has no ticket yet.

**Open question, raised by Optimystic's session from reading `ProtocolClient.exchange` (not from a run).** The exchange aborts the stream when the deadline fires, so a late answer gives no sample. When every request to a peer is abandoned, as with all 53 read-repair consults in the measurement below, an estimate fed only by answers stays at the floor and nothing stretches. RFC 6298 doubles its timer on expiry, and the accepted text does not say what an expiry does. If the estimators need that, the accepted text gains a sentence, which the maintainer should see. FRET's ping is not checked for the same behaviour.
 Sereus's remaining work is then "Sereus's side once accepted" below, without the paragraph, and the phone arm under "How to confirm".

GitHub gotchoices/sereus#48.

**Re-checked 2026-11-07 on `@optimystic/*` 1.26.0: still blocked.** `feat-link-deadlines-stretch-to-measured-response-time` is still in Optimystic's backlog, and 1.26.0's notes name no deadline change.

## What the phone-link measurement shows

From the phone arm of `strand-workload-on-a-phone-link.integration.ts` (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy; two-member strand, 8 rounds of one write and a six-table read), run 2026-10-17 on sereus 1.16.0, Optimystic 1.15.0 (`28e6e044`), p2p-fret 1.1.0 (`6c04166`). The scenario's doc comment has the full counts and how each was taken.

- **The clean workload alone overruns the deadline.** One round with nothing timing out (measured on loopback) puts 472-476 frames on the busiest socket: 9.5 s at the cap's 20 ms a frame. The smallest deadline a strand read or write waits on that follows the declared link is the 7 s a cohort peer gets to answer a read (`cohortQueryTimeoutMs`, two declared round trips). The busy event loop releases fewer than 50 frames a second, so 9.5 s understates.
- **On the phone link the queue then grew.** The busiest socket carried 17.2 s of frames per round that crossed the link, 45% beyond the clean workload. Worst observed send wait: 17.3 s during the rounds, 27.6 s over the whole arm.
- **Every request with a fixed deadline missed it.** All 53 read-repair consults the strand nodes sent during the rounds found the other member silent at 7 s, and all 224 in the 180 s after. FRET's 2 s maintenance ping failed 67 times against the strand nodes. The pinged side's 10 s ping handler reset 9 connection-monitor pings, and each reset aborted a connection.
- **Outcome.** The writes of rounds 1-3 failed. FRET marked both strand nodes `dead`, the remaining five rounds each committed alone, and the two sides ended holding different rows that did not converge in 180 s.

The decision rule this was filed under (`strand-workload-count-driven-fixes`): when one clean round already occupies the socket for at least half the 7 s read deadline (here 9.5 s against 3.5 s), the work alone builds a queue that crowds a deadline counted in declared round trips, and cutting retries cannot be enough. Cutting them still helps: retries were 48% of the requests beyond the clean workload with FRET's and libp2p's pings excluded, 28% with them (`complete/optimystic-retries-do-not-back-off`, shipped in Optimystic 1.16.0).

## Accepted text

A new paragraph in `docs/network/deadlines.md` → "Limits and accepted tradeoffs":

> **Measured response time.** A deadline over an open connection to a peer is the larger of its count of declared round trips and the same count of that peer's measured response time. The measured time is a smoothed average plus four times its smoothed variation, as TCP sizes its retransmit timer (RFC 6298): each answered request updates it, and an answer to a request that was sent more than once does not, since it cannot be matched to one attempt. The declared value stays the floor and the starting estimate before any sample exists, so a deadline never falls below what the declaration gives, and a peer not yet heard from is waited on exactly as today. A ceiling bounds the stretch (RFC 6298 allows one no lower than 60 s), so a peer that stopped answering is still given up on. A deadline that opens a connection stays declared: before the connection exists there is no response from that peer to measure.

Why: the declaration is fixed, and a send queue is not. Where a link's cost is per frame, the queue grows with traffic, so a deadline counted in declared round trips gives up on requests whose answers are only queued. Each request given up on is re-sent, which lengthens the queue that made it late. A deadline that follows the measured response time stretches as the queue does, so the request is answered instead of re-sent. That removes the feedback instead of moving the traffic level at which it starts.

**Who would hold the estimator.** The deadlines that fired here are Optimystic's per-peer cohort read (`cohortQueryTimeoutMs`), its consensus request response (`responseTimeoutMs`), and FRET's maintenance ping (`MAINTENANCE_RPC_TIMEOUT_MS`), so Optimystic and FRET would each keep a per-peer estimate. FRET already records each answered request's `rttMs`, but from after the stream opens; a sample for this purpose should start when the request is issued, so that it includes the wait to open the stream behind the queue. This ticket proposes the principle, not the mechanism; each project designs its own estimator.

**Sereus's side once accepted:** the paragraph above; `docs/network/deadlines.md` → "Deadlines below cadre" marks each row that stretches as the upstream releases land; cadre-core's `cohortReadDeadlineMs` becomes the floor Optimystic stretches above. cadre-core's own dial budgets stay declared (they open connections).

## Alternatives, and why they were not taken

- **Declare a larger link on phone deployments** (`linkRoundTripMs`). The declaration is fixed and the queue is not, so a larger one only raises the traffic at which the queue overruns it, and it stretches every deadline for every peer all the time, including dials to peers that are really gone. A phone run with a larger declaration was not made.
- **A fixed queueing allowance added to every deadline.** The same failure, a constant against a queue that grows with traffic, and its cost is paid on every link.
- **Only reduce traffic.** Retry backoff (`complete/optimystic-retries-do-not-back-off`, in Optimystic 1.16.0) and joining a turn's WebSocket sends into one frame (`backlog/feat-websocket-sends-coalesced-per-turn`, which cut a Galaxy S7's sends by 62%) both shorten the queue, and both are worth having. But the clean workload is already past the deadline: at 62% fewer frames a round would occupy the socket about 3.6 s, at the bar, and an app with more tables or more rows is past it again.

## Related tickets

- `fret-maintenance-deadlines-below-the-declared-link` (complete; p2p-fret 1.3.0 with Optimystic 1.23.0) derives FRET's maintenance deadlines from the declared link. That is the floor this proposal stretches above, and it is a defect on its own on a link inside its declaration.
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

The phone-arm series was not run. The arm's last run took 3 464 s (`adopt-optimystic-1-17-0`), and one command here may run for 10 minutes, so a series needs a human or CI. 1.19.0 moves no deadline in `docs/network/deadlines.md` → "Deadlines below cadre" (re-stamped at `f1f774ea`). Two of its changes bear on this arm: a write to several tables or indexes now sends one request per member per phase, not one per table, index and `unique` column (gotchoices/Optimystic#42), which shrinks the joiner's seat and membership commits, and a change event from such a commit waits up to 10 s for its other tables (`DEFAULT_CHANGE_HOLD_MS`). Neither changes how a deadline is sized, so the proposal stands as written.

## Optimystic 1.20.0 (2026-10-28, `adopt-optimystic-1-20-0`)

The phone-arm series was not run, for the same reason as at 1.19.0 (one run takes about an hour, one command here may run for 10 minutes). 1.20.0 moves no deadline in `docs/network/deadlines.md` → "Deadlines below cadre" (re-stamped at `59679072`); its one new timing value, the reachability gate's 500 ms wake debounce (`DEFAULT_WAKE_DEBOUNCE_MS`), runs only with offline mode on. Two changes bear on this arm. A read none of whose coordinators answered a block now returns that block as unreachable instead of failing the whole read, so a slow link fails fewer whole reads. And a phone with strand offline mode on resolves its writes locally and sends them when its cohort answers, which takes the write's network wait off the app but not off the link. Neither changes how a deadline is sized, so the proposal stands as written.

## Reporter's 1.19.0 phone-arm rerun (gotchoices/sereus#48, 2026-10-27; added 2026-10-30)

This is the phone-arm series this ticket asked for, run by the reporter on npm Optimystic 1.19.0 (Mac, Node 24.11). On a quiet machine (load about 3), both runs completed all 8 rounds with **no failed operation** and converged, a first. One run on a loaded machine (load 4-8) failed every round, with FRET marking the strand peer dead 27 times. The margin is still close on a busy phone.

- **What keeps the `it.fails` failing** on the quiet runs is the `DEBUG` fault count alone: 106 `cohort silent` (`cluster-fetch:peers-silent`, coordinator-repo, both strands), matched one for one by 106 `consult held`, plus 1 commit retry. These are background read-repair consults on held blocks that gave up on a peer that was up and answering everything else. They are deadline faults by this ticket's definition (a request abandoned while both members are up), not miscounted events, so the scenario's classification stands. They are this ticket's evidence that the consult deadline sits below the phone link.
- **Seating doubled** (220 s vs 1.16.0's 108-110 s) while rounds improved. Investigated in `joiner-seat-write-on-a-phone-link-doubled-since-1-16`; see the next section.

## The joiner's seat, one commit on Optimystic 1.20.1 (2026-10-30, `joiner-seat-write-on-a-phone-link-doubled-since-1-16`)

The phone arm's seating, run alone (`-t 'seats both parties'`), now measures each attempt at the joiner's seat transaction as its own window. Two runs on one Windows machine at about 60% CPU from other work. The full table is in the scenario's doc comment.

- **The seat is a two-member commit, and was one on 1.16.0 too.** Every attempt failed with `Failed to get super-majority: 1/2 approvals`, after 233.4 s and 227.3 s (run 1) and 285.6 s (run 2; its second attempt was still running at 360 s when the command limit stopped it). The 2026-10-17 run on 1.16.0 failed its seat with the same error. So the slower seat is a cost of the commit itself, not of the seat having stopped committing alone.
- **Nothing in sereus delays the start.** In run 1, the commit's first cluster transaction started 0.07 s after the joiner became writable.
- **One seat attempt is this ticket's case.** In run 1's first attempt, the joiner, which coordinated, sent the founder 26 cluster requests (promise, commit) and abandoned all of them to the 10.5 s response deadline, each 10.5-42 s after sending, then retried them. The founder abandoned 10 block fetches from the joiner the same way. In run 2's first attempt the link carried 11 747 frames: the busiest socket had 4 014 frames, 80 s at the cap's 20 ms a frame, and the worst send wait observed was 31.2 s. The strand nodes opened 53 cluster streams (joiner to founder) and 18 block-transfer streams (founder to joiner). The fault counts were cohort silent 20, stream reset 14, commit retried 2, ping failure 20, and FRET contact strike 96. No peer was marked dead and nothing was committed alone.
- **Not separated:** the joiner's 16 read-repair consults to the founder (started by the first-sync gate's reads before the joiner was writable, and all found silent) and the membership reconciler's join commit both share the link with the seat from its first moment. Whether either one is a large share of the 53 cluster streams was not measured.

## Re-checked on Optimystic 1.22.0 (2026-10-31, `adopt-optimystic-1-22-0`)

Still blocked. p2p-fret has no release after 1.2.1, and db-p2p 1.22.0 still requires ^1.2.1. No value in `docs/network/deadlines.md` → "Deadlines below cadre" moved between 1.20.0 and 1.22.0 (re-stamped at `0789edac`; the cited files were diffed between the tags). The 1.21.0 and 1.22.0 changes nearest this ticket only cut idle traffic: a peer-store rewrite throttled to once a minute per peer and protocol (gotchoices/Optimystic#40) and, with strand reactivity on, fewer status messages and read requests (#48, #49). Neither changes how a deadline is sized.

## The frame-capped joiner's first commit on Optimystic 1.29.0 (2026-11-21, `joiner-first-commit-capped-arm-takes-either-outcome`)

Five runs of the frame-capped arm of `joiner-first-commit-over-slow-relay.integration.ts` alone (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy; two-member closed strand over one dedicated relay), on one loaded Windows machine: three to measure the arm, two to confirm the rewritten arm passes whichever way the commit falls. The arm's own doc comment carries the figures.

- **The refusal is still the one this ticket describes, and it is now the minority outcome.** Three of the five runs committed the joiner's seat (35.4 s, 44.9 s, 35.3 s) and the founder held every row 0.0 s after the joiner stopped; two were refused (the one timed from the joiner's seat took 87.6 s to be refused): `PromiseShortfallError`, 1 of 2 approvals where 2 were needed, 0 rejections, the founder's strand node in `silentPeers`, `soloRefused` unset. The cohort was both members, the joiner approved its own pend, and the founder's leg answered nothing inside the deadline. Nothing was saved and the app was told. Read with this scenario's earlier record, the arm now commits in 7 of 11 recorded runs on 1.29.0 and is refused in 4.
- **Not a fix, the same race falling the other way more often.** 1.28.0's silent-member grace and relay reservation renewal would be expected to move it in exactly this direction, and when the commit is refused the fingerprint is unchanged. So the deadline this ticket proposes to size from measured response time is still the one that fires; it just fires less often on this arm.
- **The arm no longer requires the refusal.** It was `it.fails`, which turned the suite red whenever the commit landed. It is now a plain `it` that accepts either outcome and pins each: a commit whose rows must be readable on the founder after the joiner stops, or exactly the shortfall above. A refusal of any other shape, or a commit that reports success while the founder never sees the rows, still fails it. This arm is therefore no longer a signal for whether this ticket has landed; the phone arm under "How to confirm" is.
- **Also seen, not attributed:** the arm's first sync measured 151.3 s, 151.3 s, 170.1 s, 231.6 s and 239.2 s, against a header figure of "about 45 s" written when the earlier runs were taken. Five runs on one loaded machine is still not a series, and the figures in the scenario now say so.
- **One lead worth a look if this is ever picked up again:** in each of the two refused runs the joiner's strand node held TWO connections to the founder's strand node when its strand became writable; in each of the three that committed it held one (the arm logs the list). Two against three is a correlation on five runs, not a finding, and nothing was traced from either side of it. If duplicate strand-node connections are real, they would double the frames this link has to drain, which is this ticket's subject.
