---
description: Threaded a `superMajorityThreshold` knob through the browser `StartNodeOptions` and the optimystic `reference-peer` CLI (`interactive`, `service`, `run`). Default in distributed-mode browser → `0.51`; e2e fixture passes `--super-majority-threshold 0.51` to bootstrap + service peers. Added a focused unit test in `@optimystic/db-p2p` that locks the `Math.ceil(peerCount * threshold)` math for the 3-peer / 0.67 vs 0.51 cases. The underlying `cluster-tx:supermajority-failed` bug is fixed (debug-log confirmed), but **the Tier 2 e2e suite is not 16/16**: 13/16 pass, 3 still fail with a different, timing-related failure mode (`cluster-tx:consensus-broadcast-error` → retry race). That residual is out of scope for this ticket and warrants a separate fix.
files: ../optimystic/packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/reference-peer/README.md, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md
---

## What landed

### Browser (`packages/reference-app-web/src/lib/optimystic.ts`)

- Added `superMajorityThreshold?: number` to `StartNodeOptions`.
- `startNode` now computes
  `superMajorityThreshold ?? (isDistributed ? 0.51 : undefined)` and
  forwards via `clusterPolicy: { superMajorityThreshold }` on the
  `createLibp2pNode` config. Solo mode keeps `undefined` so the
  `libp2p-node-base` default (`0.67`) stays in play for the 1-peer
  cluster (where it doesn't matter).

### `reference-peer` CLI (`../optimystic/packages/reference-peer/src/cli.ts`)

- New `parseSuperMajorityThreshold(options)` — rejects non-finite, ≤ 0,
  or > 1 values. Error text: `--super-majority-threshold must be a
  number in (0, 1]`.
- `--super-majority-threshold <number>` is now registered on
  `interactive`, `service`, and `run` (verified via `--help`).
- The parsed value is forwarded via `clusterPolicy: {
  superMajorityThreshold }` on the `createLibp2pNode` call, only
  constructed when the flag is present (so `allowDownsize` /
  `sizeTolerance` keep their library defaults).
- Startup logs `🎯 Super-majority threshold set to <value>` and
  `logDebug('super-majority threshold override set', { ... })` —
  mirrors the existing `--cluster-size` style.

### E2E fixture (`packages/reference-app-web/e2e/fixtures/reference-peer.ts`)

- Bootstrap (`interactive --offline`) and each service peer's argv now
  carry `--super-majority-threshold 0.51` immediately after
  `--cluster-size 3`. Both halves of the mesh agree on the same
  threshold so every cluster member's `getTransactionPhase` computation
  matches the coordinator's expectation.

### Unit test (`../optimystic/packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts`)

- New 3-row parametric `describe` over `(threshold, approvals,
  expected)`:
  - `(0.67, 3) → commit` — unanimous, passes the strict default
  - `(0.67, 2) → supermajority-failed` — confirms `ceil(3*0.67) = 3`
    demands unanimity
  - `(0.51, 2) → commit` — confirms the new e2e knob does what we want
- The non-approving verdict is `silent` (returns the record unchanged
  with no signature added) — **not** `reject`. The real bug surfaces
  when a peer's `getTransactionPhase` lands in `Promising` instead of
  `OurPromiseNeeded`, so it returns successfully without co-signing.
  Using `reject` would short-circuit on the `rejected by validators`
  path instead and would not exercise the supermajority counter.

### Docs

- `../optimystic/packages/reference-peer/README.md` — documented
  `--super-majority-threshold` next to `--cluster-size` with the
  rounding rationale (`ceil(3 * 0.67) = 3` → unanimity).
- `packages/reference-app-web/README.md` — extended both the
  "connecting to a local bootstrap" recipe and the "reproduce e2e
  locally" snippet with `--super-majority-threshold 0.51` and the
  one-sentence why.

## Validation evidence

| Check | Result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p build` | ✅ exit 0 |
| `yarn workspace @optimystic/db-p2p test` | ✅ 440 passing, 5 pending |
| `yarn workspace @optimystic/db-p2p test:verbose --grep "super-majority threshold math"` | ✅ 3/3 |
| `yarn workspace @optimystic/reference-peer build` | ✅ exit 0 |
| `yarn workspace @optimystic/reference-peer test` | ✅ 4/4 (existing distributed-diary mesh tests) |
| `reference-peer interactive/service/run --help` | ✅ `--super-majority-threshold <number>` listed on all three |
| `yarn workspace @serfab/reference-app-web typecheck` | ✅ exit 0 |
| Tier 2 e2e (`--grep "Tier 2"`) | ⚠️ **13/16 passing, 3 failing** — see below |

## Honest gap on Tier 2 acceptance

The ticket's stated acceptance was **16/16 Tier 2 passing**. The actual
result locally is **13/16 passing, 3 failing**. The same three specs that
were failing before the change still fail:

- `e2e/distributed/two-tab-convergence.spec.ts`
- `e2e/distributed/cross-tab-activity.spec.ts`
- `e2e/distributed/disconnect-mid-session.spec.ts`

**The cluster-tx:supermajority-failed bug this ticket targets IS fixed.**
Evidence:

1. Re-ran the failing specs with `OPTIMYSTIC_E2E_DEBUG=1` and captured
   the full browser debug trace (`%TEMP%/tier2-debug.log`, 357KB).
   Searched for `supermajority-failed` / `Failed to get super-majority`
   in two separate Tier 2 runs (one with debug, one without): **zero
   matches**. Before this change the same scenarios fired
   `supermajority-failed` reliably on every commit attempt.
2. Every `cluster-tx:start` in the debug trace progresses through
   `:promise-summary` → `:commit-majority-reached` → `:complete`
   without error. The threshold-counting path is taking the happy
   route now that `ceil(3 * 0.51) = 2` leaves a peer of slack.

The remaining flake is a **different** failure mode:
`cluster-tx:consensus-broadcast-error` — after commit-majority is
reached, the coordinator broadcasts the merged commit record to all 3
peers and one peer's broadcast fails. That schedules a retry on a 2s
initial interval (`scheduleCommitRetry` → `retryCommits`,
`cluster-coordinator.ts:584`). Between the failed broadcast and the
retry succeeding, tab B can query the peer that missed the broadcast
and not see the message. Across three runs the failure mode varied
(once at A→B convergence, once at edit propagation, once at A's own
local optimistic write — the last suggests something more than just
the broadcast race), so this isn't a clean single-cause regression.

This is not in this ticket's scope (the ticket explicitly fixes
"option 1", the threshold math). It needs its own fix ticket. Notes
for that follow-up:

- The retry window (initial 2s, exponential backoff) is comparable to
  the e2e timeouts (20s–30s polls), so under-resourced runs can lose
  the race.
- `cluster-tx:consensus-broadcast-error` happens even when the
  per-peer `:commit-response` succeeded earlier in the same
  transaction — the post-majority broadcast must be re-dialling and
  losing the connection.
- The browser's `NetworkTransactor.get:retry` path is firing
  frequently in the same trace, so reads are also flapping. Worth
  checking whether the browser's circuit-relay reservation is being
  recycled mid-transaction.
- The intermittent failure at the local optimistic write
  (line 22 of `two-tab-convergence.spec.ts`) is the most suspicious
  observation — that path doesn't touch the network at all, so a
  failure there points at a `MessageApp` / Svelte reactivity race
  triggered by concurrent cluster-tx work. Could be a re-entrant
  refresh dropping the local mutation; worth `localExecuted` /
  `executedTransactions` audit on the cluster-repo side.

## What to verify in review

1. **Threshold default value choice.** `0.51` is borderline — it makes
   `ceil(3 * 0.51) = 2` (good) but is one rounding tick away from
   collapsing to 1 if someone misreads the formula. `0.6` (→ 2) gives
   more headroom; `0.51` matches `simpleMajorityThreshold` for
   symmetry. Both are defensible — confirm the intent.
2. **Browser default behavior.** Solo mode keeps `undefined`
   (libp2p-node-base default `0.67`); distributed mode defaults to
   `0.51`. The asymmetry mirrors the existing `clusterSize: 1 vs 3`
   default in `optimystic.ts:136`. If the reviewer prefers symmetric
   defaults (always pass an explicit value, or always rely on the
   library default), the call site is a single ternary.
3. **CLI `clusterPolicy` construction is gated.** The flag-not-present
   path produces `clusterPolicy: undefined`, so the library defaults
   for `allowDownsize` / `sizeTolerance` are preserved. If anyone
   later adds another `clusterPolicy` knob without checking, they
   could accidentally make the threshold flag mandatory. Worth a
   one-line comment if you'd rather make that invariant explicit.
4. **Unit-test verdict shape.** The `silent` verdict (returns record
   unchanged) is the right shape for the bug being locked in, but if
   the spec catalogue grows you might want `silent` + `reject` +
   `approve` covered (the existing
   `cluster-coordinator.spec.ts`'s `MockClusterClient` does
   `approve`/commit-fail). The new file uses its own mock to keep
   scope tight.
5. **Tier 2 follow-up.** Should a new `fix/` ticket be filed now for
   the `consensus-broadcast-error` race? The mechanism is clear from
   the debug log but the right fix (retry tuning, eager re-dial,
   coordinator-driven read repair, ...) is open.

## Reproducing locally

```bash
# Build dependencies
yarn --cwd C:/projects/optimystic workspace @optimystic/db-p2p build
yarn --cwd C:/projects/optimystic workspace @optimystic/reference-peer build

# Unit test
yarn --cwd C:/projects/optimystic workspace @optimystic/db-p2p test:verbose \
  --grep "super-majority threshold math"

# Tier 2 e2e
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"

# Tier 2 with cluster-tx debug trace
$env:OPTIMYSTIC_E2E_DEBUG = "1"
yarn workspace @serfab/reference-app-web test:e2e --grep "two-tab convergence"
```
