description: Re-measure what a strand insert costs over a relay now that optimystic has cut a commit's consensus rounds (expected about 4 `/cluster` streams per insert instead of 9), and check for regressions the change could cause. Optimystic has asked for the stream counts and timings, and gotchoices/sereus#13 is waiting on them.
files:
  - tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md (the method and the "after" numbers this repeats)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (record the result here)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (topology)
  - packages/integration-tests/src/harness/ws-latency.ts (frame counts, `WS_FRAME_STATS=1`)
----

# Re-measure relay round trips at optimystic cadcb919

## What changed upstream

Optimystic main `cadcb919` (gate green at `e6e84aa1`, not yet published; `../optimystic` dist for db-core and db-p2p already rebuilt — do not rebuild or modify `../optimystic`):

1. `0022162b`/`16dd8ba1`: the commit round carries the coordinator's own commit vote, so in cohorts of 2–3 a remote member reaches commit majority on receipt and applies. The third round (broadcast) goes only to members that still need it. Upstream measured pend + commit on a two-node mesh at 4 remote calls, down from 6.
2. `f8dab0ca`/`e6e84aa1`: when one coordinator covers every block, the log tail and data blocks go in one commit (falls back to tail-first if that throws).

Upstream's expectation for our two-party insert: about 4 `/cluster` streams instead of 9. That is inferred, not measured.

## Do

Repeat the method in `complete/relay-round-trips-remeasure-optimystic-012573a2` (temporary scenario copying the blind-relay topology, counting TCP proxy with a gater on A, `newStream` counting per protocol, exchanges on A's proxied sockets). Check that A's strand paths only use the proxy port. Runs:

- Config 1 (both `transaction`, through the proxy, no delay), 2 runs × 5 reps. The key numbers: `/cluster` streams per insert from A and from B, exchanges, time.
- Delayed run, 150 ms each way on A's link, 3 reps: insert and read timings. Before: inserts 8.9–10.2 s (one 37.9 s outlier), reads 0.6–1.3 s.
- Config 2 (B `storage`), 3 runs × 4 concurrent pairs without the proxy, plus 1 control run with both `transaction`. Before: `TornActionError` in 7 of 16 storage-joiner pairs and 0 of 4 control. Record every error verbatim and whether the torn row landed.
- The frame count: `WS_FRAME_STATS=1 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e`, read at the declared boundaries (loopback journey end-of-test line and the latency arm's install line). Before: ~10.8–12.5k loopback, ~9.5–13.8k at 10 ms.

Delete the temporary scenario afterwards unless it can be turned into a committed, opt-in measurement cheaply; do not add it to the default test run.

## Regressions to watch for (from upstream)

- A cohort member that is away during a commit now also misses the log tail, and serves its older copy until the read-repair window lapses (10 s default). Look for any sereus scenario that reads right after a member returns and could now see stale data for up to 10 s. Run `yarn test` in integration-tests at least once and note any new failure or flake of that shape.
- In three-member cohorts only the coordinator keeps a publishable commit certificate (affects opt-in reactivity only).

## Report

Write the before/after table into the blocked ticket as a new dated "Upstream status" paragraph, and put the full numbers in this ticket's completion. Do not message optimystic or post on #13 — the tending agent relays the numbers.
