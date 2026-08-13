description: Starting a device's control database performs about 1,500 tiny storage operations, and that count is what makes startup slow on a busy disk — a test now measures it and fails if it grows.
files: packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/src/control-database.ts, docs/STATUS.md

# Complete: storage-operation budget for a control-database start

## What shipped

**`packages/cadre-core/test/control-start-storage-op-budget.spec.ts`** — one test that wraps the
`IRawStorage` handed to `CadreNode` in a counting passthrough, starts a control node twice against
the same storage, and asserts a two-sided budget on each start. Counts are tallied by method name
and by distinct block id.

**Tripwire `NOTE:`** at the `await this.loadSchema()` call site in
`packages/cadre-core/src/control-database.ts`, giving the measured counts, the fact that start
duration is that count × per-operation storage latency, and pointers to both the blocked ticket and
this spec. That is where someone debugging a slow launch lands.

**`docs/STATUS.md`** — the spec is now catalogued in the "Control DB liveness" section alongside the
other control-DB suites (added during review; see findings).

No production behaviour changed. The only `src` edit is a comment.

## The measurement

Windows 11, `packages/cadre-core`, over `MemoryRawStorage`. Reproduced independently during review
(4th run overall) — byte-identical to the implement-stage figures, and identical again inside the
full 94-file suite under parallel load:

| phase | ops | distinct blocks | dominant method |
|---|---|---|---|
| cold start (empty storage, 8 tables + 1 index created) | **1541** | **21** | `getMetadata` 720 over the same 21 blocks (~34× each) |
| warm restart (catalog hydrate) | **315** | **22** | `getMetadata` 160 over 22 |

The cold figure matches what the blocked ticket measured over `FileRawStorage`, so the count is a
property of the storage layer's call pattern rather than of the backend. Budgets sit modestly above:
cold ≤ 1700 ops / ≤ 24 blocks, warm ≤ 360 ops / ≤ 25 blocks. A **floor** at half the measurement
guards against the spec silently measuring nothing.

The amplification itself is not fixable from this repo — it is produced inside `@optimystic/db-p2p`
and the decision is carried by `blocked/optimystic-block-read-amplification-on-control-start`. This
spec is the guard that keeps the cost visible, not the fix.

## Validation

```
packages/cadre-core: yarn typecheck                       clean
packages/cadre-core: yarn vitest run                      94 files, 1505 passed, 1 skipped
repo root:           yarn lint                            exit 0
```

The budget spec passed standalone and inside the full parallel suite, before and after the review
edits. Ceiling-bites was re-verified by hand (temporarily lowering `COLD.opBudget` to 1000 and
reading the failure), then restored.

## Review findings

### Fixed in this pass

- **The spec printed its measurements nowhere under the documented command.** The handoff's
  re-measurement workflow was "read the `[storage-op-budget]` lines the run prints", and the
  implement ticket's own validation instructions were `yarn vitest run test/…`. That command emits
  **zero** such lines: vitest v4's default reporter shows a passing test's `console.log` nowhere, so
  the breakdown only appears under `--reporter=verbose`. Confirmed by running both reporters over
  the same pipe; these are the only two `console.log` calls in the whole `cadre-core` test tree, so
  the mechanism had no precedent to inherit. Worse, a *failing* run named the total but not which
  method grew — the diagnosis needed a second run behind a flag nobody had been told about. Fixed
  by threading the per-method breakdown into every assertion message (new `formatBreakdown`, reused
  by the printed line so the two cannot drift) and correcting the doc comment to name the flag.
  Verified: a tripped ceiling now prints the full `getMetadata 720/21, …` table under the default
  reporter.

- **The two ceiling messages did not cross-reference each other** — a gap the implementer flagged.
  Adding a control table trips the operations budget *first*, whose message talks about slowdown, so
  a reader would widen the wrong number. Each message now points at the other and says to widen both
  deliberately or neither.

- **`docs/STATUS.md` was not updated.** That file is the maintained catalog of the control-DB specs
  (`- [x]` per spec, and it records tripwire `NOTE:`s elsewhere — e.g. the one at
  `cadre-node.ts`'s `resolveCohortSeed`), and the blocked ticket explicitly describes this work as
  turning a throwaway measurement into "a permanent guard". A reader auditing control-DB coverage
  would not have learned the budget exists. Added an entry in "Control DB liveness" with the counts,
  the two-sided design, the `--reporter=verbose` caveat, and the pointer to the blocked ticket.

- **Minor type tidy.** The inline `{ ops; blocks; opBudget; blockBudget }` on `expectWithinBudget`
  duplicated the shape of `COLD`/`WARM`; extracted as a documented `Budget` interface, matching the
  file's own `MethodCount` / `OpSnapshot` style.

### Verified, no change needed

- **The passthrough is complete and faithful.** All 14 required `IRawStorage` members are forwarded
  and counted, and the two optional ones (`listBlockIds`, `getApproximateBytesUsed`) are
  conditionally installed. Checked against `db-p2p/src/storage/i-raw-storage.ts` and against
  `KvRawStorage` (`kv-raw-storage.ts:28-37`) — the conditional-install shape the implementer was
  unsure about mirrors the real class exactly, so the node under measurement is not behaving
  differently from a real one. Feature-detecting callers see the same truth they would without the
  wrapper.

- **The warm phase is genuinely warm, and the anti-vacuity guards bite.** Genesis runs after the
  cold snapshot and the second node asserts `hasOwnerKey()` / `getOwnerKeys()`, so a warm start that
  came up on an empty database fails rather than quietly measuring a second cold start. The floor at
  half the measurement catches the "storage silently out of the path" case that a ceiling-only
  budget would pass vacuously.

- **Determinism, which is what justifies budgets this close to the measurement.** Independently
  reproduced: identical totals and identical per-method breakdowns, standalone and under 94-file
  parallel load. Audited the background timers in `db-p2p` that could otherwise drift the count
  between `start()` returning and the snapshot — the storage-touching ones are on 60 s intervals
  (`cluster-repo.ts:288`, `libp2p-node-base.ts:1185`) against a ~400 ms measured window, and the 1 s
  cleanup tick drains an in-memory queue. No flake mechanism found.

- **No duplication.** `integration-tests/src/harness/block-store-probe.ts` also wraps `IRawStorage`
  but inspects contents rather than counting calls, in a different package for a different question.
  Nothing to share.

### Considered and declined

- **Per-method budgets** (implementer flagged as a judgement call). Still declined — they would be
  far more brittle for little extra signal. The concern behind it, that a change shifting redundancy
  *between* methods passes silently, is now materially reduced: the breakdown rides in every failure
  message, so the moment any budget trips the reader sees exactly which method moved.

- **A `Proxy` instead of the hand-written 14-method passthrough.** The boilerplate buys a
  compile-time guard — a new method on `IRawStorage` fails the build here rather than going silently
  uncounted — which a `Proxy` would give up along with requiring casts. The implementer's choice
  is the right one.

- **Budgeting control *writes*, `registerSelf`, strand storage or `stop()`.** Start is where the
  reported stall lives; extending the budget to writes is speculative scope with no reported symptom
  behind it. Not filed.

### Parked as a tripwire (not a ticket)

- **The warm figure is memory-only, and both starts share one live storage object.** Recorded as a
  `NOTE:` on the `WARM` constant in the spec. It is sound while the operation count stays a property
  of the repo layer's call pattern — which the cold cross-check against `FileRawStorage`
  demonstrates it is — and only becomes work *if* a change makes the warm path backend-sensitive (a
  decode step, a cache, anything only a file-backed restart exercises). The note names the remedy
  (`fileStorageProvider` in `control-db-node-helpers.ts`) and why it was not paid for speculatively.

### Empty categories

- **No new tickets filed.** Every finding above resolved inline; nothing rose to a class of defect
  needing an invariant, a generalized test, or a boundary check. The one architectural problem in
  view — the read amplification itself — already has a human-facing home in
  `blocked/optimystic-block-read-amplification-on-control-start`, and re-filing an instance of it
  would add queue length without adding information.

- **No pre-existing test failures.** The full 94-file suite was green, so
  `tickets/.pre-existing-error.md` was not written and nothing needed checking against
  `.pre-existing-known.md`.

- **No accepted-tradeoff `NOTE:`s were overridden.** None of the sites touched carried one.
