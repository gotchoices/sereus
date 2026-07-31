description: While one shared-settings change is stuck waiting on a slow machine, all reads of the shared settings on that machine hang too — they only answer once the stuck change gives up, instead of answering immediately from local data.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-database.ts
difficulty: hard
----

# Control reads block behind a stalled control write

## Observed (deterministic reproducer exists)

In the integration scenario `control-write-degraded-cohort-member.integration.ts`, case
"a control read answers locally while a write is stalled": with node C's inbound cluster
protocol handler held open forever, node A issues `authorizePeer` (which stalls ~20 s before
failing with the expected super-majority error). While that write is in flight, a plain read
on the same node — `ControlDatabase.hasOwnerKey()` — does not answer within 15 s. It answers
only after the stalled write settles.

This was first seen as an unreproducible red flag in an earlier measurement run; it now
reproduces on every run under the suite's deterministic coordinator pin (`pinCoordinator([A])`
in that scenario). Expected behavior: reads serve the last committed local state immediately,
regardless of any in-flight write. Measured settle time for the stalled write is ~20 s in the
test (two 10 s per-RPC response-deadline attempts); a write that hangs longer in production
would block reads for that whole time.

## What is already ruled out

- **Not cadre-core's write queue.** `ControlDatabase.withWriteLock`
  (`packages/cadre-core/src/control-database.ts:1097` area) deliberately does NOT serialize
  reads — reads take no lock. The blockage is below cadre-core.
- **Not the reproducer's coordinator pin.** The identical hang was observed in an earlier run
  with no pin at all (the original nondeterministic suite), so the harness patch is not the
  cause.

## Suspected mechanisms (verify, then fix at the right layer)

Both live in the `../optimystic` reference workspace:

- The stalled write pends a block shared with the read path (the failure output names block
  `dE8WH4l5OpEUH9Hl6C8bZzPkGY_OKzDsvCEg46ob99w` as `in-flight` — likely a collection log
  tail/header). A repo-level read of a block with a pending (in-flight) version may be waiting
  on the pend's outcome instead of serving the last committed revision.
- Alternatively, statement-level serialization inside the Quereus session used by
  `ControlDatabase` (one session shared by reads and writes) would queue the read behind the
  stalled write statement.

## Reproduce

```
cd packages/integration-tests
yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts --reporter=verbose
```

The "control read answers locally while a write is stalled" case fails with
`degraded-cohort control op hasOwnerKey (during stall) timed out after 15000ms`. (If the
in-flight implement ticket for that scenario has since marked the case as an expected-failure
reproducer, flip it back to a plain `it` to see the failure.)

## Done means

- Reads on a node with an in-flight (including stalled) control write answer from committed
  local state within the scenario's 15 s read deadline.
- The scenario case above passes as a plain `it` (un-mark the expected-failure annotation if
  present).
