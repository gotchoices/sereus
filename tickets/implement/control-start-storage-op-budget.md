description: Bringing a device's control database up performs about 1,500 tiny storage operations, and that number is what makes startup slow on a busy disk — add a test that measures it and fails if it grows, so the cost stops being invisible.
prereq:
files: packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts
difficulty: medium

# Pin the storage-operation cost of a control-database start

## Why

`ControlDatabase` start time is not CPU-bound or network-bound — it is
**(number of raw-storage operations) × (per-operation storage latency)**. The measured count for a
cold start is **1541 operations** for 8 tables and 1 index, over at most 21 distinct blocks
(`getMetadata` alone: 720 calls / 21 blocks). At ~1 ms per operation that is the familiar ~1.5 s;
when per-operation latency rises to 50–90 ms — a loaded disk here, flash contention on a phone —
the same start takes 15–62 s and looks like a frozen app.

The amplification itself lives in `@optimystic/db-p2p` and cannot be fixed from this repo; that is
tracked in `blocked/optimystic-block-read-amplification-on-control-start.md`, which carries the
full measurement and the ruled-out hypotheses. **This ticket is not that fix.** It is the guard
that makes the cost visible and stops it growing silently, and it stands on its own regardless of
what is decided upstream.

Today nothing in the suite would notice if a change doubled the operation count: the only signal
is wall clock, which is fast enough on an idle machine to stay green while the device-facing
behaviour gets worse. A count is deterministic where a duration is not — no timing assertion in
the suite can do this job.

## What to build

A spec that counts every call into the raw storage during a control-database start and asserts a
budget. Shape (proven out during diagnosis, not committed):

```ts
// wrap whatever IRawStorage the node is given, count by method name and distinct first argument
function countingStorage(inner: IRawStorage, counts: Map<string, number>): IRawStorage
```

- Back it with `MemoryRawStorage` (already used by `control-database-solo.spec.ts`), not files —
  the operation COUNT is what is asserted, and an in-memory backend keeps the spec fast and free
  of filesystem noise.
- Assert on the **cold** start and on a **warm** restart against the same storage. Both paths
  showed the stall in the field (the worst case observed was a warm start:
  `hydrate: 7774ms (tables=8, indexes=1)` followed by `loadSchema: 7929ms`), and they have very
  different counts, so one budget cannot cover both.
- Budgets should sit modestly above the measured figure (cold: 1541 at time of writing; warm: not
  yet measured — measure it as part of this work) with the measured number and its date written
  into the assertion message, so a failure tells the next reader whether the count grew or the
  budget was always wrong.
- Assert the **distinct-block** count too, not only the total. The distinctive fact is the ratio
  (720 metadata reads over 21 blocks); a change that halves the redundancy should be able to
  tighten the budget, and a change that adds a whole new table should move the distinct count
  rather than silently eating headroom.

Keep it in `packages/cadre-core/test/`, next to the other control-database liveness suites, and
give the file a header comment saying what it protects and pointing at the blocked ticket — the
budget is meaningless without the reason.

## Tripwire to record

Add a `NOTE:` at the `loadSchema` call site in `packages/cadre-core/src/control-database.ts`
stating the measured operation count, that start duration scales with per-operation storage
latency, and naming the blocked ticket. That comment is where the next person debugging a slow
launch will actually land.

## Not in scope

- Changing how or when control DDL commits (the blocked ticket covers the real fix).
- Any caching layer over `IRawStorage`. A naive per-block read cache was measured at 23 %
  (1541 → 1189) and is not worth its invalidation risk.
- Widening or narrowing the existing hang-detector budgets in
  `control-database-solo-warm-start.spec.ts`.

## TODO

- [ ] Measure the warm-restart operation count the same way the cold one was measured, so the
      second budget is a number and not a guess.
- [ ] Add `packages/cadre-core/test/control-start-storage-op-budget.spec.ts`: counting
      `IRawStorage` proxy over `MemoryRawStorage`, cold start + warm restart, total-op and
      distinct-block assertions with the measured figures and date in the messages.
- [ ] Add the `NOTE:` tripwire at the `loadSchema` call site in `control-database.ts`.
- [ ] Run `yarn vitest run` from `packages/cadre-core` and confirm green.
