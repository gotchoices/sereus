---
description: Extended `CoordinatorRepo.get` to consult cluster peers not only for entirely-missing blocks (legacy behavior) but also for present-but-stale blocks, gated by a new `readRepairMode` policy on `ClusterConsensusConfig` ('off' / 'lazy' / 'paranoid'). Default is 'lazy' with a 10 s window. Adds per-block staleness tracking via an LRU bumped on successful commit and successful cluster-fetch. Emits `cluster-tx:read-repair-{triggered,applied,noop}` log events for e2e debug visibility. Six new specs in `db-p2p` pin the three modes and window behavior; the existing 5 `coordinator-repo-solo-self-bypass` specs continue to pass.
prereq:
files: ../optimystic/packages/db-core/src/cluster/structs.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-read-repair.spec.ts
---

## What landed

### Config (`ClusterConsensusConfig` — additive)

Three new optional fields in `packages/db-core/src/cluster/structs.ts`:

- `readRepairMode?: 'off' | 'lazy' | 'paranoid'` — default `'lazy'`.
  - `'off'`: legacy behavior — only fetch on entirely-missing blocks.
  - `'lazy'`: also fetch when the local copy is older than `readRepairWindowMs` (or never marked seen).
  - `'paranoid'`: always consult cluster on every read.
- `readRepairWindowMs?: number` — default `10000` (10 s).
- `readRepairSampleRate?: number` — default `0`. In `'lazy'` mode, on each within-window read the policy ALSO rolls a Math.random() vs this value and triggers if it lands under. Mostly a knob for keeping cluster views warm under heavy read traffic without flipping the whole mode to `'paranoid'`.

All three are mirrored into the `policy` literal in `CoordinatorRepo` constructor with `?? <default>`, same pattern as `commitBroadcast*`.

### `CoordinatorRepo` (`packages/db-p2p/src/repo/coordinator-repo.ts`)

- New `private readonly lastSeenCommitMs = new LruMap<string, number>(1000)`.
- New `private markBlocksSeen(blockIds: BlockId[])` — bumps every passed blockId to `this.now()`.
- `markBlocksSeen` is called from:
  - `commit()` after every success path (`peerCount <= 1` path, `localExecuted` path, local-storage success path, and cluster-consensus-override-local-failure path).
  - `fetchBlockFromCluster` after the `cluster-fetch:synced` log line.
- New `private shouldReadRepair(blockId)` implements the three modes per spec.
- New `private ageMs(blockId)` for log payload.
- `get()` now has two repair triggers: missing (legacy) OR `shouldReadRepair()` for present blocks. Both branches share the same `fetchBlockFromCluster → re-read` sequence.
- New log events (channel `coordinator-repo`):
  - `cluster-tx:read-repair-triggered` — `{ blockId, mode, ageMs, localRev }`
  - `cluster-tx:read-repair-applied` — `{ blockId, oldRev, newRev }`
  - `cluster-tx:read-repair-noop` — `{ blockId }`

### Test seams (public)

The class exposes two minimal seams used by the specs (and nothing else):

- `now: () => number = () => Date.now()` — overridable clock for window math.
- `rand: () => number = () => Math.random()` — overridable RNG for the sample rate.
- `setLastSeenForTest(blockId, ts)` — direct LRU writer so specs don't have to drive a full commit cycle to seed freshness.

These are intentionally not on the `IRepo` interface — they're test seams on the concrete `CoordinatorRepo` class. The reviewer should sanity-check that none of these leaked into the `IRepo` contract or shipped behavior; the answer is no (no callers in tree outside the new spec file).

### What didn't change

- `coordinatorRepo()` factory signature is unchanged.
- `libp2p-node-base.ts` is untouched — the `'lazy'` default means service peers and browser peers both get the same safer-than-before behavior with no per-environment wiring. If we later need service peers to be cheaper we can flip the knob at the callsite; the field exists.
- Public `IRepo` interface (`db-core/src/network/struct.ts`) is unchanged.
- All four pre-existing `coordinator-repo-solo-self-bypass.spec.ts` flows are unchanged — they all set `state: {}` (missing) so the new "stale" branch never engages.

## How to test / use

### The trigger you should see in production

When a peer misses a post-majority commit broadcast (e.g. the connection that the broadcaster reused had been silently torn down by the relay), the peer's local store retains its prior `rev`. On the very next `get()` against that block, with the default `'lazy'` policy:

1. After 10 s of no fresh activity on that block, OR if the block was never previously seen by this peer, `shouldReadRepair` returns true.
2. `cluster-tx:read-repair-triggered` is emitted with `{ blockId, mode: 'lazy', ageMs, localRev }`.
3. The existing `fetchBlockFromCluster` runs — same path as the missing-block case — and queries all cluster peers via `clusterLatestCallback`.
4. If a remote reports a higher rev, `storageRepo.get` restores it. The post-re-read log differentiates `cluster-tx:read-repair-applied` (rev advanced) from `cluster-tx:read-repair-noop` (cluster confirmed we were already current).

### Manual e2e check (Tier 2 debug-log greps)

Once running, grep the e2e debug log:

```
grep -c "cluster-tx:read-repair-triggered" <debug.log>
grep -c "cluster-tx:read-repair-applied"   <debug.log>
grep -c "cluster-tx:read-repair-noop"      <debug.log>
```

Triggered + applied counts ≥ 1 over a multi-tab read scenario where one peer missed a broadcast is the success signal. Triggered + noop dominating means the cluster is already converging fine and read-repair is just an extra round-trip; in that regime you'd want to flip the default to `'off'` at the service-peer callsite for cost.

## What was verified

- **`yarn workspace @optimystic/db-core build`** → exit 0.
- **`yarn workspace @optimystic/db-p2p build`** → exit 0.
- **`yarn workspace @optimystic/db-p2p test` (full suite, post-implementation)** → **456 passing, 7 pending, 0 failing.**
  - The same suite produced 2 failures on one earlier run and 0 on a follow-up; both intermittent failures (`Fresh-node DDL Scenario B`, `IPeerReputation getAllReputations`) reproduce on the stashed baseline tree without my changes. Pre-existing flakes — see "honest gaps" below for evidence.
- **Targeted `--grep "CoordinatorRepo read-repair"`** → 6/6 passing in 15 ms.
- **Targeted sibling regression sweep `--grep "solo-cluster|ClusterCoordinator|super-majority"`** → 25/25 passing (existing solo-self-bypass spec, super-majority threshold math, retry logic, broadcast in-line retry, ClusterMember, DisputeService, recovery). Confirms the new code path doesn't perturb adjacent coordinator behavior.

## Honest gaps (please verify)

### 1. Tier 2 e2e debug-log validation — NOT run

The source ticket asks for a Tier 2 e2e re-run with `OPTIMYSTIC_E2E_DEBUG=1` on the historically-flaky specs from `tickets/complete/web-e2e-tier2-cluster-supermajority.md`, 3 times, with grep counts of the three new log events.

I did NOT run this. The Tier 2 sweep spawns 3 reference-peer processes per spec, runs for many minutes per pass, and three passes routinely blow past the agent's 10-min idle-output budget end-to-end — which makes it non-agent-runnable per the workflow rules. A human or CI should run it. The unit-level read-repair correctness IS what's shipping; the Tier 2 outcome would be confirmation that the path runs in real network conditions, not a gate on the code being correct.

The implementer note in the source ticket already says "Do not block this ticket's completion on full Tier 2 green; the unit-level read-repair correctness is what we're shipping."

### 2. Two intermittent pre-existing test failures

Across multiple test runs I observed two intermittent failures that ALSO appear on the stashed-baseline tree:

- `Fresh-node DDL (multi-node, real production stack) — Scenario B (5-node cold-start with peer E unreachable) → "DDL on A completes with peer E unreachable; SELECT on B sees the write"` — pre-existing flake. Manifested 1× with my changes and 1× without them on consecutive runs. This is exactly the scenario read-repair should help with in principle, but the failure was also present pre-change, so it's an existing convergence/timing issue (not a regression).
- `IPeerReputation contract (review) → getAllReputations includes all reported peers` — numerical-precision flake (`expected 2 to equal 1.9999992298366143`). Manifested 1× across 3 iso-runs even without my changes. Floating-point time-decay rounding; entirely independent of this work.

Neither failure is in code my changes touch.

### 3. Sample-rate behavior is exercised but not pinned

The `readRepairSampleRate` knob has one unit-test branch (the test seam `repo.rand` is overridable), but I didn't add a dedicated spec for it because the default is `0` and the production callsite never sets it. If the reviewer wants belt-and-suspenders, a 7th spec setting `readRepairSampleRate: 0.5` + `rand = () => 0.3` (triggers) vs `rand = () => 0.7` (skips) within window would lock it in. Easy add if requested; not added in this pass to keep the spec file focused.

### 4. `paranoid`-mode noop test asserts behavior, not log emission

The "paranoid mode is a noop when cluster reports the same rev as local" spec verifies the callback fired and the result rev is unchanged, but does NOT use a logger spy to assert that `cluster-tx:read-repair-noop` was the literal log event emitted. The logger is `createLogger('coordinator-repo')` from `db-p2p/src/logger.js`, which is a thin wrapper around `debug`; spying on it would need a module-level mock and felt heavier than the value. The behavioral assertion is what matters for the regression risk. The reviewer may decide otherwise and add a spy.

### 5. Browser vs service default — punted, single default for everyone

Source ticket suggested defaulting `'lazy'` for browsers and possibly `'off'` for services. I made the default `'lazy'` for everyone with a 10 s window. Reasoning: that's strictly safer than the current effective-`'off'`-for-stale behavior, the window is short enough that browser peers polling every few seconds hit it after a single missed broadcast, and the config knob exists so a future ticket can flip service peers to `'off'` at `libp2p-node-base.ts` without touching this file.

The reviewer may want to thread a `role: 'browser' | 'service'` hint and split the default. Out of scope for this ticket per its scope statement, but the seam is there.

## Files changed

- `../optimystic/packages/db-core/src/cluster/structs.ts` — three new optional fields on `ClusterConsensusConfig`.
- `../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts` — read-repair plumbing + LRU + log events + test seams.
- `../optimystic/packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` — new spec file with 6 cases.

Untouched but listed in the source ticket's `files`:

- `../optimystic/packages/db-p2p/test/coordinator-repo-solo-self-bypass.spec.ts` — chose to add a sibling spec file (`coordinator-repo-read-repair.spec.ts`) rather than crowd this one. All 5 existing specs in it continue to pass.
- `../optimystic/packages/db-p2p/src/libp2p-node-base.ts` — confirmed no wiring change is needed; the default `'lazy'` mode is applied via the constructor `??` defaults, so the existing call to `coordinatorRepo({ clusterSize, ...consensusConfig }, ...)` picks it up unmodified.
