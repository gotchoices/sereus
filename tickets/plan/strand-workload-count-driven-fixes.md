description: Once the phone-link test from GitHub #48 has measured which time limits fire and how often, decide how to stop a slow link from filling up with retries: cut the traffic Sereus causes itself, propose retry backoff to Optimystic, or move to time limits based on each peer's measured response time, and follow up on why the two sides ended with different data.
prereq: strand-workload-on-a-phone-link-scenario
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (its doc comment holds the measurement), packages/quereus-plugin-sereus/src/cluster-size.ts (`STRAND_CLUSTER_POLICY`), packages/cadre-core/src/link-budget.ts, docs/architecture.md ("The declared value" ~1984), docs/cadre-consistency.md, tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md, tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md, tickets/blocked/optimystic-write-made-alone-owes-no-one.md
----

# Fixes the phone-link measurement calls for

GitHub gotchoices/sereus#48. The prereq commits the reporter's scenario and runs its phone arm once with debug logging; it appends the results below under `## Measured`. Plan from those counts. If that section is missing, the measurement did not run: say so in the next-stage ticket rather than planning from the code alone.

`strand-workload-deadline-fixes` (this ticket's predecessor) settled what did not need the counts:

- `blocked/fret-maintenance-deadlines-below-the-declared-link`: FRET's maintenance ping (2 s) and the tick budgets around it are fixed below the declared link, and three missed pings mark the other member `dead`, which removes it from every cohort. That is one route to the diverged end state, on any link slower than about 1 s one way.
- `implement/strand-deadline-ladder`: the table of every limit a strand's reads and writes run under, in `docs/cadre-consistency.md`.
- A pointer on `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline` to this scenario.

## What reading the code showed (2026-10-16, Optimystic `28e6e044`, FRET `6c04166` = p2p-fret 1.1.0)

**Cannot fire in this workload.** The inbound authorization timeout (both of cadre's predicates are synchronous, and it is already an option), and Optimystic's cohort-topic frame read and signature collection (only on nodes with `strandReactivity`, off in the scenario). A `read timed out` in this scenario's log is FRET's own RPC.

**The commit retry is bounded per chain.** `processBatches` (`db-core/src/utility/batch-coordinator.ts` ~111-164) retries a failed batch until the transaction expires, but each retry excludes the failed coordinator, and once every peer and self are excluded `findCoordinator` throws `No coordinator available (all candidates excluded)` (`db-p2p/src/libp2p-key-network.ts` ~1224). On a two-member strand a chain is B, then self. What remains: the retry fires at once with no backoff, and the self-coordinated retry sends the same cluster transaction to the same slow B. The read path's `get:retry` is one extra round (`db-core/src/transactor/network-transactor.ts` ~275-310). Above Optimystic, `control-write-retry.ts` and the app retry too.

**`Transaction expired` is a consequence, not a cause.** It fires when a transaction outlives its own budget, 170 000 ms at the default declaration.

**The read-repair window is settable here.** `readRepairWindowMs` (Optimystic default 10 000 ms; cadre sets neither policy's) starts a background cohort consult on a read of a held block last checked more than the window ago (`db-core/src/cluster/structs.ts` ~387-404). Loopback rounds are 0.1 s apart, phone rounds 11-169 s, so on the phone every table read of every round can start one consult per held block. `STRAND_CLUSTER_POLICY` can set it. Cost: a held copy that missed a commit broadcast is noticed later. On a two-member strand each member is in every block's cohort, so a commit reaches the other member by broadcast and read repair is the backstop for a missed broadcast.

## The design question

Every deadline cadre and Optimystic derive is a multiple of the declared round trip. On the phone arm the delay is not a fixed round trip: each frame waits 20 ms behind every frame queued before it, so the delay grows with the traffic, and frames were measured waiting 10-22 s. A deadline derived from the declaration (FRET's ping at 7 s, once the FRET ticket lands) still fires at a 20 s queue, and each firing adds a retry. Decide from the counts between:

- **Reduce the traffic.** Fewer consults (the read-repair window), fewer retries, backoff on the retries that remain. Settles inside the current principle. Pick this if the counts show consults and retries are a large share of what the link carries.
- **Deadlines from measured response times** (the issue's direction 2: a per-peer smoothed response time and its variance, as TCP sizes its retransmit timer; FRET already records each ping's `rttMs`). This changes the principle in `docs/architecture.md` "The declared value", that every link deadline is a count of declared round trips. If the counts say it is needed, route it to `blocked/` with proposed text for that section, not to an implement ticket.
- **Declare the phone link.** A phone deployment states a larger `linkRoundTripMs`. Cheap, but the declaration is fixed and the queue is not, so it moves the point of collapse rather than removing it.

## Outputs expected

- An implement ticket for what cadre can set itself (likely the strand read-repair window, if the `read-repair consult` count is a large share of the traffic), naming the phone-arm run as its check.
- One `blocked/` proposal per upstream root cause the counts confirm: Optimystic retry backoff (and per-peer bounding) if `commit retried` and `get retried` are a large share; the cohort-topic deadlines only if a reactivity-on run shows them. Extend `blocked/fret-maintenance-deadlines-below-the-declared-link` with the measured `contact strike` and `revived` counts rather than filing a second FRET ticket.
- The diverged end state, if the measurement reproduces it: check first whether the `contact strike` → `commit:solo-cohort` chain (the FRET ticket) and `blocked/optimystic-write-made-alone-owes-no-one` together account for it. File a follow-up only for what neither covers.
- Update the deadline ladder's table (`strand-deadline-ladder`, landed by then) for any value a resulting ticket changes.
