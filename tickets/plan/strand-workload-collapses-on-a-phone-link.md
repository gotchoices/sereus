description: On a phone-shaped link (20 ms serial frame cap, 70%-busy event loop), an app's ordinary writes and reads on a two-party strand fail, retry and re-ask until the link carries more traffic than the work needs; in one run the strand nodes ended disconnected holding different data. Several deadlines and retry loops in the stack are fixed or unbounded instead of following the declared link (GitHub #48).
architecture: docs/cadre-consistency.md
files: packages/integration-tests/src/scenarios/ (the reporter's `strand-workload-on-a-phone-link.integration.ts`, in the issue), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR` ~644-683), docs/cadre-consistency.md, docs/architecture.md (~1939-1965)
----

# A strand workload collapses on a phone-shaped link

kjeib's scenario in gotchoices/sereus#48 runs 8 alternating rounds (one side writes, the other reads every table) on the `blind-relay-phone-to-phone-e2e` pair.

- **Loopback:** 0.08-0.14 s per round, no deadline events.
- **Phone arm:** rounds of 11-169 s, 5 failed operations, 72-98 cohort-silent events, 32-88 stream resets and 3 transaction expiries. One run ended with 0 strand connections and diverged data.
- **A busy CPU alone** did the same work slower, with identical counts. The frame cap made the counts grow.

Verified at 70b2dc1d (Optimystic 1.15.0, p2p-fret 1.1.0). Dial and connection deadlines follow `linkRoundTripMs`; these do not:

- Optimystic's cohort-topic `readFrame` uses FRET's `readFramed` default `RPC_TIMEOUT_MS` = 5000 (`cohort-topic/stream-util.ts` ~46, NOTE ~64-69), with no option.
- Optimystic `DEFAULT_SIGN_COLLECT_TIMEOUT_MS` = 5000, `DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS` = 5000, `readRepairWindowMs` = 10 000.
- `batch-coordinator.ts` ~111-164: on any failure it re-finds a coordinator, excluding the failed peer, and retries until the transaction's expiration, with no backoff and no per-peer bound.
- The ping handler is still `@libp2p/ping`'s bare 10 s (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`). Its addendum: at 60 s the resets stopped, but pings ran past the 30 s monitor deadline on the saturated link.
- FRET `RPC_TIMEOUT_MS` = 5000 and `STABILIZE_TICK_BUDGET_MS` = 5000.

Part of the read traffic is `plan/strand-unwritten-app-tables-cost-a-cohort-read`: one table in the workload is never written.

## Plan

1. Commit the reporter's scenario, with the failing arm as `it.fails`, as the acceptance test.
2. With `DEBUG='optimystic:*'`, attribute the deadline events to the list above. Land the unwritten-tables fix first and remeasure, since it removes a class of consults.
3. File the remaining fixed deadlines and the unbounded retry with Optimystic, and FRET's RPC timeout with FRET. Each deadline should derive from the link round trip or take an option, and the retry needs backoff and a per-peer bound. Cadre passes the declared link to each once available.
4. Flip the arm to `it` when it passes, and record the deadline ladder in `docs/cadre-consistency.md`.
