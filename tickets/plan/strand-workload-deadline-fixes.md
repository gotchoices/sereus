description: Once the phone-link test from GitHub #48 has measured which time limits fire, decide and file the fixes: the settings Sereus can change itself, proposals to the Optimystic and FRET projects for the ones it cannot, and a written ladder of every time limit a strand's work runs under.
prereq: strand-workload-on-a-phone-link-scenario
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (its doc comment holds the measurement), packages/cadre-core/src/link-budget.ts, packages/quereus-plugin-sereus/src/cluster-size.ts (`STRAND_CLUSTER_POLICY`, `COHORT_READ_DEADLINE_MS`), packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime` ~830-900), packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR` ~644-683), docs/cadre-consistency.md, docs/architecture.md (~1984-2007, "The declared value" / "What Optimystic derives"), tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md
----

# Fix the deadlines and retries that the strand workload measured firing

GitHub gotchoices/sereus#48. The prereq commits the reporter's scenario and runs its phone arm once with debug logging; its results are appended below under `## Measured`. Plan from those counts. The original plan (the issue's maintainer reply) was: file each fixed deadline and the unbounded retry upstream, each derived from the declared link round trip or given an option, then pass the declared link to each from cadre, flip the arm to `it`, and record the deadline ladder in `docs/cadre-consistency.md`. Reading the code while planning the prereq corrected that list; the corrections are below and change what is worth filing.

## What reading the code showed (2026-10-16, Optimystic HEAD `28e6e044`, Fret `6c04166` = p2p-fret 1.1.0, read only)

**Cannot fire in this workload, so not worth filing on its evidence:**

- `DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS` (5 s, `db-p2p/src/inbound-authorization.ts` ~74). It bounds an asynchronous predicate, and both of cadre's predicates are synchronous (`CadreNode.authorizeInboundControlStream`; `StrandRevocationEnforcer.authorizeStream` ~378). It is also already an option (`NodeOptions.authorizeInboundStreamTimeoutMs`).
- Optimystic's cohort-topic frame read (`db-p2p/src/cohort-topic/stream-util.ts` `readFrame`, FRET's `readFramed` at its 5 s default) and `DEFAULT_SIGN_COLLECT_TIMEOUT_MS` (5 s, `cohort-topic/threshold-crypto.ts` ~43). Both run only on nodes built with `cohortTopic`, which cadre turns on only through `strandReactivity` (`strand-reactivity.ts`), off by default and off in the scenario. The issue saw `read timed out after 5000ms` from cohort-topic only in the Taleus runs, which presumably enable reactivity. They are real for a host that turns reactivity on over a slow link, but this scenario does not show it. A `read timed out` in this scenario's log is FRET's own RPC.

**Weaker than stated:**

- **The commit retry is bounded per chain.** `processBatches` (`db-core/src/utility/batch-coordinator.ts` ~111-164) retries a failed batch until the transaction's expiration, but each retry adds the failed coordinator to `excludedPeers`, `findCoordinator` honours the exclusion, and once every peer and self are excluded it throws `No coordinator available (all candidates excluded)` (`db-p2p/src/libp2p-key-network.ts` ~1224), which ends the chain. On a two-member strand a chain is therefore: B, then self. What remains is that the retry fires at once, with no backoff, and that the self-coordinated retry sends the same cluster transaction to the same slow peer B. The read path's `get:retry` is a single extra round (`db-core/src/transactor/network-transactor.ts` ~275-310). Above Optimystic, `control-write-retry.ts` and the app add their own retries.
- **`Transaction expired` is not a fixed deadline.** A cluster member throws it (`db-p2p/src/cluster/cluster-repo.ts` ~815) once the transaction's own expiration passes, and that expiration is the transaction budget derived from the declared link (170 000 ms at the default, `docs/cadre-consistency.md`). Three of them per run means three transactions spent over 170 s, a consequence of the congestion, not its cause.

**Settable in this repo today, no upstream change needed:**

- **`readRepairWindowMs`** (Optimystic default 10 000 ms; cadre sets neither policy's). In `lazy` mode, a read of a block this node holds starts a background cohort consult when the block was last checked more than the window ago (`db-core/src/cluster/structs.ts` ~387-404). Loopback rounds are 0.1 s apart, so loopback reads mostly start none; phone rounds are 11-169 s apart, so every table read of every round can start one consult per block. If the measured `read-repair consult` count is large, this window is where the extra traffic comes from, and `STRAND_CLUSTER_POLICY` can set it (with the cost: a stale held copy is noticed later).
- **`cohortQueryTimeoutMs`** (`cluster-fetch:peers-silent`): cadre's own, two declared round trips, 7 000 ms at the default 3 500 ms declaration (`cohortReadDeadlineMs` in `link-budget.ts`).

**Fixed upstream with no option (FRET):** `RPC_TIMEOUT_MS` = 5 000 (`packages/fret/src/rpc/protocols.ts` ~27, the default of `readFramed` and of `request.ts` ~259), `MAINTENANCE_RPC_TIMEOUT_MS` = 2 000 (`service/fret-service.ts` ~475, every maintenance ping) and `STABILIZE_TICK_BUDGET_MS` = 5 000 (~506). FRET takes no link declaration. A hypothesis worth checking against the `solo commit` count: on a saturated link FRET's 2 s maintenance pings to the other member fail, FRET drops it from the ring, the strand's cohort shrinks to self, and each side commits alone (`strand-instance-manager.ts`'s NOTE on `persistence` describes the same cohort shrink on a relaunch). That would explain the diverged end state.

**Already filed:** the ping handler's 10 s timeout, `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`. Its last addendum is the reason a deadline fix alone may not be enough here: with the handler raised to 60 s, pings over the saturated circuit outran the 30 s monitor deadline instead.

## The design question this ticket must settle

Every deadline cadre and Optimystic derive is a multiple of the **declared** round trip (default 3 500 ms). On the phone arm the delay is not a fixed round trip: each frame waits 20 ms behind every frame queued before it, so the delay grows with the traffic. `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline` measured outbound frames waiting 10-22 s on this link. Deriving FRET's fixed 5 s from the declared link would move it to some multiple of 3.5 s, which still fires at a 20 s queue, and each firing adds a retry to the queue. So decide, from the counts, between:

- **Reduce the traffic.** Fewer consults (the read-repair window above), fewer retries, backoff on the retries that remain. Settles inside the current principle (deadlines from the declared link).
- **Deadlines from measured response times** (the issue's direction 2: a per-peer smoothed response time and variance, as TCP sizes its retransmit timer). This changes the principle in `docs/architecture.md` "The declared value", that every link deadline is a count of declared round trips. If the counts say it is needed, route it to `blocked/` with proposed text for that section, not to an implement ticket.
- **Declare the phone link.** A phone deployment states a larger `linkRoundTripMs`. Cheap, but a declaration is fixed and the queue is not, so it moves the point of collapse rather than removing it.

## Outputs expected

- In-repo implement ticket(s) for what cadre can set itself (likely the read-repair window, if the counts point there), each naming the phone-arm run as its check.
- One `blocked/` proposal per upstream root cause the counts confirm, with the recommended option text: for FRET (its RPC and maintenance deadlines taking a link declaration or an option), for Optimystic (retry backoff, and the cohort-topic deadlines if a reactivity-on run shows them). Put a one-line pointer to this scenario on the existing ping-handler ticket rather than a new one.
- A follow-up for the diverged end state if the measurement reproduces it, after checking whether `blocked/optimystic-write-made-alone-owes-no-one` (a write made alone is owed to no one) already accounts for it.
- The deadline ladder in `docs/cadre-consistency.md` "Deadlines Over Optimystic's Reads and Commits": the deadlines a strand read and write run under, which follow the declared link and which do not. That section indexes cadre's own deadlines today; extend its table, keeping the reasoning at each constant.
