description: The database library under Sereus re-sends a request that went unanswered at once, with no wait, and on a slow link the request it replaces is usually still sitting in the same send queue, so every re-send makes the queue longer. Proposes waits that start at one link round trip and double; needs a change in Optimystic.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: ../optimystic/packages/db-core/src/utility/batch-coordinator.ts (`processBatches` ~111-164, read only), ../optimystic/packages/db-core/src/transactor/network-transactor.ts (`get`, the retry round ~275-310, read only), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock` ~939, `startHeldBlockConsult` ~1424, the exit that arms the window only for a provably permanent decline ~1657, read only), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (its doc comment holds the measurement), docs/cadre-consistency.md ("Deadlines Below Cadre": the coordinator retry, read retry and read-repair window rows)
repro: verified
----

# Optimystic's retries do not back off, so on a slow link each one lengthens the queue that made its predecessor late

**Blocked on a dependency outside this repo.** Unblocks when Optimystic ships the backoff proposed below in a version Sereus can adopt. Read at Optimystic `28e6e044` (1.15.0); recheck the cited sites after a bump.

GitHub gotchoices/sereus#48.

## What happens

Three places in Optimystic re-send a request that went unanswered, with no wait:

- **The coordinator retry** (`processBatches`). A failed batch is retried at once against the next coordinator, excluding every one already tried, until the transaction budget runs out or none is left. On a two-member strand the chain is the other member, then the node itself, and the self-coordinated retry sends the same cluster transaction to the same slow member, whose earlier request is likely still in the link's send queue.
- **The read retry round** (`NetworkTransactor.get`, `get:retry`). One extra round, at once, against coordinators not yet asked, for the blocks no coordinator answered authoritatively.
- **The read-repair consult after a silent one** (`CoordinatorRepo`). A consult that finds a cohort peer silent leaves the block's read-repair window unarmed, on purpose: the comment at the arming exit says re-asking can learn something, because a silent peer can recover. So the next read of that block starts a new consult as soon as the previous one ends. On a link where consults time out, a block that is read often is consulted once per per-peer deadline (7 s) plus the read interval, however long the window is.

The cause is the same in all three. The request being replaced was given up on at a deadline, not lost: its frames are usually still queued behind the socket's per-frame cost, so the replacement is queued behind them and adds to what the next request waits behind.

## Measured

The phone arm of `strand-workload-on-a-phone-link.integration.ts` (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy; a two-member strand), run 2026-10-17 on sereus 1.16.0, Optimystic 1.15.0, p2p-fret 1.1.0. Counts over the three rounds that crossed the link (188.6 s), both strand nodes. The scenario's doc comment has the full table and how each figure was counted.

- **Coordinator retries:** 12 started (`batch-coordinator retry peer=`); 8 were sent to the next coordinator and 4 found none (`No coordinator available … the remaining candidate peer(s) are foreign or not-yet-confirmed`). At three requests a retried write (pend, commit, and the broadcast to the other member), 24 requests. That is an upper bound: a retry coordinated by a node whose ring had already marked the other member `dead` commits alone.
- **Read retries:** none in this run. The reporter's runs on the same link logged 8 to 35 a run. They are included because the cause is the same.
- **Read-repair consults:** 54 sent during the rounds, and all 54 found the other member silent at 7 s. 31 of them were re-asks of a block whose previous consult had gone silent. In the 180 s after the rounds, all 224 consults were such re-asks, each block re-asked about every 8.2 s (one block was consulted 10.4, 18.5, 26.7, 34.9 … 141.4 s after its last check).
- **Share of the requests beyond the clean workload:** the three together, 55 requests: 47% of the excess with FRET's and libp2p's own pings excluded, 28% with them. Coordinator retries alone 21% and 12%; consult re-asks alone 27% and 16%.

A source under a quarter of the excess cannot by itself bring a queue that overran a deadline back under it. These three share one cause and one fix, so they are weighed together.

**What backoff cannot do alone.** One round of this workload with nothing timing out already occupies the busiest phone socket for 9.5 s, longer than the 7 s read deadline, so even with no retries the queue overruns it. That is `blocked/decide-link-deadlines-from-measured-response-time`. Backoff shortens the queue that proposal's deadlines would otherwise have to stretch over.

## Proposed change in Optimystic (the recommended default)

- **Coordinator retry and read retry round:** wait before each retry, starting at one declared link round trip (`linkRoundTripMs`, which Optimystic already receives) and doubling with each further retry of the same operation, inside the transaction budget. When the retry's request must reach a peer whose previous request just timed out (on a two-member cohort the self-coordinated retry always must), wait at least as long as that request was outstanding before sending again.
- **Read-repair consult after a silent one:** after a consult in which a cohort peer was silent, hold the next consult of that block for a wait that starts at one declared round trip, doubles with each consecutive silent consult, is capped (the reconcile pass bound, 35 s at the default declaration, is one candidate), and resets as soon as that peer answers any request. Reads served meanwhile carry the doubt they carry today (`unconfirmedAheadRev`), as they do inside the window: the wait spaces the consults, it does not change what a read reports.

The second keeps Optimystic's reason for leaving a silent consult unarmed (a recovered peer is asked again well inside a long window) while not re-asking on the very next read. On the measured link it would cut a frequently read block's consults from about 22 to about 7 in 180 s.

**Sereus's side once released:** adopt the release; update the "coordinator retry", "read retry" and read-repair window rows of `docs/cadre-consistency.md` → "Deadlines Below Cadre".

## Alternatives, and why they were not taken

- **Arm the read-repair window on a silent consult.** Optimystic rejected that deliberately: with a long window it hides a recovered peer's newer revision for the whole window.
- **A longer read-repair window for strands** (cadre could set `readRepairWindowMs` in `STRAND_CLUSTER_POLICY` today). The window spaces only consults that were answered, and on this link none were. A window as long as Optimystic's commit-broadcast retries (81 250 ms at the default declaration: seven 10 500 ms request deadlines plus 7 750 ms of waits between them) would have skipped at most 16 of the 54 consults, 14% of the excess with pings excluded and 8% with them. It would also be the first stated staleness bound for strand reads, which no doc states yet. Not filed for that reason.
- **Fewer coordinator attempts.** A two-member strand already makes only two; the problem is when they are sent, not how many.
- **Back off above Optimystic.** All three retries happen inside one Optimystic operation, where cadre cannot space them; cadre's control-write retry and an app's own retry sit above them and see only the final failure.

## If nothing is done

Every request given up on over a congested link is replaced at once by one queued behind it: here 28-47% of the traffic beyond the clean workload, depending on whether pings are counted. With measured-response deadlines upstream fewer requests would time out, but each one that still did would put its replacement straight back on the queue.

## Reversibility

Timings inside Optimystic; an initial wait of zero is today's behaviour. Fully reversible.

## How to confirm

The phone arm: `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' WORKLOAD_SHOW_DEBUG=1 yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`. In the debug log, consecutive `cluster-tx:read-repair-triggered` lines for one block after a `cluster-fetch:peers-silent` should be spaced by the backoff (their `ageMs` growing by more than 7 s plus the read interval), and `batch-coordinator retry peer=` lines should trail their failure by at least one declared round trip.
