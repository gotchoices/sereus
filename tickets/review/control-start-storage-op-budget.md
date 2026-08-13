description: Starting a device's control database performs about 1,500 tiny storage operations, and that count is what makes startup slow on a busy disk — a new test now measures it and fails if it grows.
files: packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/src/control-database.ts
difficulty: medium

# Review: storage-operation budget for a control-database start

## What was built

**New spec** `packages/cadre-core/test/control-start-storage-op-budget.spec.ts` (one test,
~420ms of test body, ~11s wall clock including vitest import cost). It wraps the `IRawStorage`
handed to `CadreNode` in a counting passthrough, starts a control node twice against the same
storage, and asserts a budget on each start.

**Tripwire comment** at the `loadSchema` call site in `packages/cadre-core/src/control-database.ts`
(`NOTE:` at the `await this.loadSchema()` in `initialize`), stating the measured counts, that
duration scales with per-operation storage latency, and naming both the blocked ticket and the new
spec.

Nothing else changed. No production behaviour was touched — the only `src` edit is a comment.

## The measurement

Measured on this machine (Windows 11, `packages/cadre-core`), 2026-08-12, over `MemoryRawStorage`:

| phase | ops | distinct blocks | dominant method |
|---|---|---|---|
| cold start (empty storage, 8 tables + 1 index created) | **1541** | **21** | `getMetadata` 720 over the same 21 blocks (~34× each) |
| warm restart (catalog hydrate) | **315** | **22** | `getMetadata` 160 over 22 |

The cold figure is **identical** to the one the blocked ticket measured over `FileRawStorage`, so
the count is a property of the storage layer's call pattern rather than of the backend. The warm
figure is new — it had never been measured; the ticket asked for it.

Budgets set modestly above: cold ≤ 1700 ops / ≤ 24 blocks, warm ≤ 360 ops / ≤ 25 blocks.

**Determinism:** three consecutive isolated runs produced byte-identical per-method breakdowns, and
the spec also passed inside the full 94-file suite run (i.e. under parallel load). That is what
justifies budgets this close to the measurement.

## How to validate

```bash
cd packages/cadre-core
yarn vitest run test/control-start-storage-op-budget.spec.ts    # passes; prints both breakdowns
yarn vitest run                                                  # full suite: 94 files, 1505 passed, 1 skipped
yarn typecheck                                                   # clean
cd ../.. && yarn lint                                            # clean
```

The spec `console.log`s one line per phase in the blocked ticket's `calls/distinct-blocks` shape,
so re-measuring after any change is just reading the run output — no instrumentation to re-add.

Things worth exercising by hand, because they are the parts a reviewer cannot take on trust:

- **The ceiling bites.** Lower `COLD.opBudget` to e.g. 1000 → the failure message names the count,
  the budget, the measurement date, and the blocked ticket.
- **The floor bites** (anti-vacuity). Raise `COLD.ops` to e.g. 9000 → verified during
  implementation: `expected 1541 to be greater than 4500`, with a message telling the reader either
  the storage is no longer in the path or the amplification improved and the budget should be
  tightened. This guards the scenario where a config/wiring change silently stops routing through
  the spec's storage, which would otherwise make a ceiling-only budget pass while measuring nothing.
- **The warm phase is genuinely warm.** The spec runs genesis (`ensureOwnerKey`) on the first node
  *after* taking the cold snapshot, then asserts `hasOwnerKey()` / `getOwnerKeys()` on the second —
  so a warm start that came up on an empty database fails rather than quietly measuring a second
  cold start.

## Known gaps — please push on these

Written as a starting point, not a finish line:

- **Warm count is `MemoryRawStorage`-only, and the instance is shared across the restart.** The
  cold count was cross-checked against `FileRawStorage` (identical), the warm one was not. The
  file-backed warm start built by `control-database-solo-warm-start.spec.ts` constructs a *fresh*
  handle over the same directory, so only bytes cross the boundary; whether that path issues the
  same 315 operations is unmeasured. If a reviewer thinks the warm budget should be pinned on the
  file shape instead of (or as well as) the memory one, that is a fair call — it costs wall clock,
  which is why it was not done speculatively.
- **The distinct-block assertion is a union across all methods**, not the per-method table the
  blocked ticket shows. The per-method breakdown is printed but not asserted, so a change that
  shifts redundancy *between* methods while holding the totals passes silently. Deliberate — a
  per-method budget would be far more brittle for little extra signal — but it is a judgement call.
- **Adding a control table trips the ops budget, not only the block budget.** The failure message
  for distinct blocks says "check what was added rather than widening the total budget", but the
  ops assertion fires first and its message talks about slowdown. A reviewer may want the two
  messages to cross-reference each other.
- **Only `node.start()` is inside the budget.** Genesis writes, `registerSelf`, strand storage and
  `stop()` are all outside it. Start is where the reported stall lives, but nothing here pins the
  cost of a control *write*.
- **The wrapper is a hand-written passthrough, not a `Proxy`.** Chosen so a new method on
  `IRawStorage` fails the build here rather than silently going uncounted — the cost is 14 methods
  of boilerplate. If a reviewer prefers the `Proxy`, note that it would need casts and would give
  up that compile-time guard.
- **`listBlockIds` / `getApproximateBytesUsed` are conditionally installed**, mirroring
  `KvRawStorage`, because callers feature-detect them. Worth a second pair of eyes: if that
  mirroring is wrong, the node under measurement behaves differently from a real one.

## Not in scope (unchanged from the implement ticket)

- Fixing the amplification. It lives in `@optimystic/db-p2p`; the decision is carried by
  `tickets/blocked/optimystic-block-read-amplification-on-control-start.md`.
- Any caching layer over `IRawStorage` (a per-block read cache was measured upstream at 23% and
  judged not worth its invalidation risk).
- Touching the hang-detector budgets in `control-database-solo-warm-start.spec.ts`.

## Review findings

- Tripwire recorded as a `NOTE:` at the `await this.loadSchema()` call site in
  `packages/cadre-core/src/control-database.ts` — measured counts, the latency-multiplier
  relationship, and pointers to both the blocked ticket and the new spec. That is where someone
  debugging a slow launch actually lands.
