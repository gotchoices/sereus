description: Re-measure what strand inserts and reads cost over a relay after optimystic's three relay-traffic fixes (no push-back of received replicas, no re-fetch of held blocks during rebalance, one tail fetch instead of two for a contended write). Optimystic asked for current counts.
files:
  - tickets/complete/relay-round-trips-remeasure-optimystic-cadcb919.md (the method and the "before" numbers)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (record the result here)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (topology)
----

# Re-measure relay round trips at optimystic 9e5c1e85

## What changed upstream

Optimystic main at or after `9e5c1e85`. db-core, db-p2p and plugin dist are rebuilt and the gate is green; not published. Do not rebuild or modify `../optimystic`. If the stale-build guard trips, stop and report it.

1. `9270de5e`: a received replica (from a push, a reconcile or a read-repair) records its source as a holder, so it is not pushed back.
2. `dcf8ac32`: rebalance no longer fetches blocks it already holds. Optimystic believes our "27 `/db-p2p/block-transfer` after the first insert" were pushes, not this fetch, and wants a current count.
3. `9e5c1e85`: a write after another handle's commit fetches the log tail once instead of twice. Aimed at B's 3–6 `/repo` per insert at `cadcb919`.

The same tree also contains the new `NodeOptions.connectionMonitor` (unused by sereus, so it should not affect these numbers).

## Do

Repeat the method in `complete/relay-round-trips-remeasure-optimystic-cadcb919`, with the same runs and reps, so the columns compare directly. Include three things specifically:
- `/repo` streams per B insert (before: 3–6), and per A insert (before: 0–2).
- `/db-p2p/block-transfer` and `/db-p2p/sync` streams after the first `Message` insert of each run, and after later inserts (before: 0–6 block-transfer after the first). Say which side sent them.
- The delayed run (150 ms each way): insert and read times (before: A 4.5–5.1 s, B 5.1–5.9 s).

Keep the storage-joiner concurrent pairs and the `TornActionError` tally (before: 0 of 12), and record every error verbatim.

## Report

Add a before/after table to the blocked ticket as a new dated "Upstream status" paragraph, and put the full numbers in this ticket's completion. Don't message optimystic; the tending agent relays the numbers.
