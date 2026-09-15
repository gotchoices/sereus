description: Nothing in the test suite counts how often the control database asks the other machines about its data, or how many commits founding a party costs, so a change that doubles that network work passes every check. Add a counting test over party founding, the membership reads that run on every request, and one idle maintenance pass, pinned at today's measured numbers.
files:
  - packages/cadre-core/test/cohort-consult-counter.ts (new — the counter)
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts (new — the budget spec)
  - packages/cadre-core/test/storage-op-counter.ts (pattern to mirror: snapshot/format helpers)
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts (two-sided budget pattern; its header's "Companions" paragraph gains a pointer to the new spec)
  - packages/cadre-core/test/control-db-node-helpers.ts (`controlNodeConfig`, `freshPartyId`, `scopedWithin`)
  - packages/cadre-core/src/control-database.ts:870 (`queryCadrePeers`), :1018 (`queryRevokedStamps`), :808 (`ensureOwnerKey`)
  - packages/cadre-core/src/cadre-node.ts:2577 (`reconcileControlCohort`), :4372 (`foundStrand`)
  - ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:754 (`get` — the per-block consult decision), :1176 (`fetchBlockFromCluster` — what is counted), `commit`
  - packages/integration-tests/src/harness/key-network-patch.ts (existing LIFO prototype-patch discipline to copy)
  - docs/testing.md (list the new budget beside the storage budgets, if it lists them)
difficulty: medium
----
# A consult and commit budget over party founding and the hot membership reads

## Why

The control database's cost has two halves. The storage budgets (`control-start-storage-op-budget.spec.ts`, `strand-solo-write-budget.spec.ts`) count `IRawStorage` operations **below** the write-through cache. The other half — how many times Optimystic's coordinator asks a block's cohort (the machines responsible for it) for the latest revision, and how many commits a flow issues — happens **above** that cache and never reaches raw storage. No spec counts it:

- `control-start-storage-op-budget.spec.ts` takes its snapshot before genesis on purpose ("Genesis AFTER the snapshot, so it costs the cold budget nothing"), so genesis is budgeted nowhere.
- `strand-solo-write-budget.spec.ts` wraps strand storage only.
- `packages/integration-tests/` asserts no consult or commit counts; its `callCount()` uses are anti-vacuity checks.

That is how the defect fixed by `revocation-ledger-marker` went unmeasured: reading a control table that has never been written consults the cohort on **every** read, and every membership lookup reads the never-written `Revocation` table first. This ticket builds the instrument, so that ticket's improvement is measured, not asserted.

## What a consult costs (context for reading the numbers)

Upstream Optimystic (`CoordinatorRepo.get`) consults a block's cohort in two cases:

- the block is **missing** locally: on every read, by design. The "remember a confirmed absence" memo was removed on 2026-09-15 (upstream ticket `drop-the-settled-absence-memo`, GitHub issue #20) because it served freshly written blocks as never created.
- the block is **held** but its read-repair window has lapsed: at most once per `readRepairWindowMs`, 10 s by default.

On a cohort of one, a consult is one local `findCluster` call (measured upstream at 0.009 ms), with no network work. On a party of several machines it is a round trip to every other cohort member. So the count is the portable signal; what one consult costs depends on the deployment.

## Measured baseline (2026-09-15, solo `CadreNode`, `profile: 'transaction'`, `MemoryRawStorage`, `controlCohort.reconcileMs: 3_600_000`)

Counted by wrapping `CoordinatorRepo.prototype.fetchBlockFromCluster` (consults) and `CoordinatorRepo.prototype.commit` (commits), using a throwaway spec that has since been deleted:

| phase | consults | distinct blocks | commits |
|---|---|---|---|
| `start()` (cold) | 24 | 18 | 2 |
| genesis (`insertOwnerKey`) | 14 | 3 | 4 |
| `queryRevokedStamps('CadrePeer')`, empty table, per call ×6 | 4, 2, 2, 2, 2, 2 | | 0 |
| `queryRevocations()`, empty, per call ×3 | 2, 2, 2 | | 0 |
| `getOwnerKeys()` (held table), per call ×6 | 1, 0, 0, 0, 0, 0 | | 0 |
| `queryCadrePeers()`, both tables empty, per call ×6 | 4 each | | 0 |
| `reconcileControlCohort()`, solo, per pass ×3 | 8 each | | 0 |
| `authorizePeer` #1 (Revocation empty) | 17 | 4 | 4 |
| `queryCadrePeers()`, 1 CadrePeer row, Revocation empty, ×6 | 2 each | | 0 |
| `authorizePeer` #2 (Revocation empty) | 5 | 2 | 4 |
| `removePeer` (files the first tombstone) | 7 | 2 | 6 |
| `queryRevokedStamps` / `queryCadrePeers` afterwards, ×6 | 0 each | | 0 |
| `authorizePeer` #3 (Revocation now held) | **0** | 0 | 4 |
| same reads 11 s later (window lapsed), ×3 | 2, 0, 0 | | 0 |

`foundStrand` was **not** measured in this pass (the original trace, taken before the upstream change, recorded 47 consults and 12 commits). Measure it here.

## Design

### `cohort-consult-counter.ts`

A counter shaped like `storage-op-counter.ts`:

- `installConsultCounter()` wraps `CoordinatorRepo.prototype.fetchBlockFromCluster` and `CoordinatorRepo.prototype.commit` (both exported from `@optimystic/db-p2p` via `export * from "./repo/coordinator-repo.js"`) and returns a handle.
- `fetchBlockFromCluster` is TypeScript-private. Reach it through a single documented `unknown` cast, and assert `typeof proto.fetchBlockFromCluster === 'function'` **before** wrapping, so a rename upstream fails loudly instead of installing a dead property.
- Tally per `CoordinatorRepo` instance (the `this` of each call) and per block id. The handle exposes:
  - `snapshot(instanceFilter?)`: `{ consults, distinctBlocks, commits, perBlock: Map<blockId, number> }`
  - `reset()`
  - `restore()` — idempotent, and it throws if another patch sits on top (LIFO), copying `key-network-patch.ts`
- Instance attribution: the control network's repo is the instance (or instances) seen while `start()` runs, before any strand exists; anything first seen during `foundStrand` is the strand's. Expose a way to label instances, so the spec can report control and strand separately.
- `formatConsultSnapshot(scope, phase, snap)` prints a greppable line such as `[consult-budget] genesis: consults=… distinctBlocks=… commits=…`.

### `control-founding-consult-budget.spec.ts`

Follow `control-start-storage-op-budget.spec.ts`: a `MEASURED_ON` date, a `Budget` per phase with measured values and a ceiling, provenance in the comments, and two-sided assertions whose messages embed the per-block breakdown (a failure must say which block grew).

Phases, each snapshotted separately on one solo node with `controlCohort: { reconcileMs: 3_600_000 }`, so the timer never fires mid-phase:

- cold `start()`
- genesis — `ensureOwnerKey(identity public key)` (the production call; `insertOwnerKey` measured the same path)
- `foundStrand(...)`, control and strand instances reported separately. Copy the config from an existing spec that calls `foundStrand`.
- per-call membership reads on the founded party: `queryRevokedStamps('CadrePeer')` ×6 and `queryCadrePeers()` ×6, asserting the **per-call array**, not only the total. Today every call after the first costs 2 (`Revocation` is missing locally), and that "every call" shape is the regression signal.
- one idle `reconcileControlCohort()` pass

Pin today's numbers. Where a phase's count depends on the 10 s read-repair window (held blocks), keep the phases fast and back-to-back, and say in the budget comment that the count assumes the phase finishes inside one window. Missing-block consults do not depend on timing; held-block consults do.

## Edge cases & interactions

- **Timing sensitivity.** A held block is re-consulted once its 10 s window lapses, so a slow machine that stretches a phase past 10 s adds consults. Run the spec three times and confirm identical per-phase counts. If a count moves between runs, find out which block moved before choosing headroom; do not paper over non-determinism with a wide ceiling (same rule as the storage budget).
- **Upstream rename of the private method.** The assert-before-wrap check catches a missing method; the floor (half the measured count) catches a method that exists but is no longer called.
- **Background timers.** `startRecordRefresh` wires a 7.5-minute heartbeat and the reconcile interval; the 1 s `selfRegistrationTimer` may run `registerSelf` during `start()` or genesis. With `reconcileMs` raised, the measured numbers above were stable. If `registerSelf` lands inside a measured phase non-deterministically, snapshot after awaiting it explicitly rather than widening the budget.
- **Prototype patch scope.** The patch is process-wide, but vitest isolates files into workers. Restore in `finally`, so a failed assertion cannot leak the patch into a later test in the same file.
- **Strand traffic.** `foundStrand` launches a strand node with its own `CoordinatorRepo`; its consults must not be charged to the control budget (instance attribution above).
- **Anti-vacuity.** A floor of half the measured count per phase, as in the storage budget. The founding floor must stay above zero even after `revocation-ledger-marker` lands. That ticket files its marker only while connected, so a solo spec never sees it and these solo numbers should not move. If they do, find out why before re-pinning.

## TODO

- Write `cohort-consult-counter.ts` (wrap, per-instance/per-block tally, LIFO restore, formatter).
- Write `control-founding-consult-budget.spec.ts` with the phases above; measure `foundStrand`; pin every phase with `MEASURED_ON`.
- Run the spec three times; record in the budget comment that the per-phase counts reproduced (or what moved and why).
- Add a one-line pointer to the new spec in the "Companions" paragraph of `control-start-storage-op-budget.spec.ts`, and in `docs/testing.md` if it lists the storage budgets.
- `yarn workspace @serfab/cadre-core test` (targeted spec plus the two storage budget specs) and `yarn lint`.
