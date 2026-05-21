---
description: Threaded five `ClusterConsensusConfig` knobs (`commitBroadcastRetryInitialMs` default 250, `commitBroadcastRetryBackoffFactor` default 2, `commitBroadcastRetryMaxIntervalMs` default 8000, `commitBroadcastRetryMaxAttempts` default 5, `commitBroadcastImmediateRetries` default 1) through `CoordinatorRepo` into `ClusterCoordinator`, and extracted the post-majority broadcast into `broadcastMergedRecord(record, peerIds)` with a `1 + commitBroadcastImmediateRetries` per-remote-peer in-line retry loop. Local cluster invocation is unchanged — one attempt only. The 14 ClusterCoordinator specs (11 pre-existing + 3 new for the in-line retry path) pass; the full @optimystic/db-p2p suite is 443 passing / 5 pending / 0 failing. The unit-level fix is correct and well-tested, but the Tier 2 e2e is now *worse* than baseline (3-of-3 deterministic vs 3-of-16 flake) — three follow-up `fix/` tickets capture the underlying network-layer work needed to validate the shortened retry budget in practice.
files: ../optimystic/packages/db-core/src/cluster/structs.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/cluster-coordinator.spec.ts
---

## What landed

### Config plumbing (`ClusterConsensusConfig`)

Five optional fields added to `@optimystic/db-core/src/cluster/structs.ts:57-66`:

| Field | Default | Replaces |
|---|---|---|
| `commitBroadcastRetryInitialMs` | 250 | hard-coded 2000 |
| `commitBroadcastRetryBackoffFactor` | 2 | hard-coded 2 |
| `commitBroadcastRetryMaxIntervalMs` | 8000 | hard-coded 30000 |
| `commitBroadcastRetryMaxAttempts` | 5 | hard-coded 5 |
| `commitBroadcastImmediateRetries` | 1 | (new behavior) |

`coordinator-repo.ts:89-94` mirrors all five into the `policy` literal with matching `?? <default>`; `cluster-coordinator.ts:58-64` mirrors them again as a defensive default for direct-construction callers (notably the test, which passes a `baseCfg` without the new fields). Defaults are duplicated by design — not a DRY violation.

### In-broadcast immediate retry

`cluster-coordinator.ts:562-606` is the new `broadcastMergedRecord(record, peerIds)` helper. It replaces the inline `Promise.allSettled` block that used to live at the call-site in `commitTransaction` and preserves the same return shape (`{ failures: string[] }`), so the downstream `scheduleCommitRetry` path is structurally unchanged.

Per peer:
- Local cluster: one attempt only. Local failures are not retried.
- Remote peer: `1 + commitBroadcastImmediateRetries` attempts in a tight loop. On non-terminal failure, emits `cluster-tx:consensus-broadcast-retry` with `{ messageHash, peerId, attempt, error }`. On terminal failure (all attempts exhausted), emits `cluster-tx:consensus-broadcast-error` with `attempts` included.

### Total retry budget: 60 s → 7.75 s (by design)

`250 + 500 + 1000 + 2000 + 4000 = 7.75 s` after the shortened initial + lower cap vs the prior `2000 + 4000 + 8000 + 16000 + 30000 = 60 s`. The ticket's design rationale: after 7 s of broadcast retries, the post-majority broadcast is unrecoverable from the coordinator's side, and the cleaner outcome is to let peer-side gossip / read-repair / next-write paths take over rather than hold state for a full minute.

### Tests (`cluster-coordinator.spec.ts`)

Mock client extended with `commitPhaseCalls` counter and `failOnCommitCall: number | null` (fail on Nth commit-phase call). New `describe('ClusterCoordinator broadcast in-line retry')` block adds:

1. **Recovers when first broadcast attempt fails but in-line retry succeeds** — `failOnCommitCall = 2` (call 1 = commit succeeds, call 2 = broadcast attempt 1 fails, call 3 = broadcast retry succeeds). Asserts all 3 commits in record, `commitPhaseCalls === 3`, no `txState.retry` set, no extra calls after 400 ms.
2. **Schedules a 250 ms retry when both broadcast attempts fail** — `failCommit = true`. Asserts `updateCalls === 4` (1 promise + 1 commit-fail + 2 broadcast attempts both fail), `txState.retry.intervalMs === 250`, failing peer in `pendingPeers`.
3. **Honors custom config** — `commitBroadcastRetryInitialMs: 100`, `commitBroadcastImmediateRetries: 2`. Asserts 5 calls (1 + 1 + 3) and `txState.retry.intervalMs === 100`.

One existing spec was rewritten for the new behavior: `retries failed commit peer in the background` now asserts `updateCalls === 4` (was `=== 3`) because the broadcast performs 1 + 1 in-line retry when the peer is unreachable, and the post-await wait tightened from 2500 ms to 500 ms to match the new 250 ms default.

## Review findings

### What was checked

- **Implement-stage diff** — read first with fresh eyes via `git diff` against the optimystic working tree (the actual code changes live there; the sereus `ticket(implement): …` commit only moves ticket files). All four touched files match the design described in the ticket.
- **Unit-test coverage** — happy path, recover-on-retry, both-attempts-fail, custom config knobs honored.
- **Edge cases** — `commitBroadcastImmediateRetries: 0` (untested but trivially correct: `Math.max(0, 0) + 1 = 1` attempt, matching legacy behavior). Local-cluster failure (single-attempt path, logs `consensus-broadcast-error` without `attempts` field — minor inconsistency vs remote path, not worth a fix).
- **Build + tests** — `yarn workspace @optimystic/db-core build` clean, `yarn workspace @optimystic/db-p2p build` clean, `yarn workspace @optimystic/db-p2p test --grep "ClusterCoordinator"` 14 passing.
- **Type safety** — no `any` introduced. `success: true as const` discriminant on the result objects is well-typed; the `r.success` filter narrows correctly.
- **Resource cleanup** — `Promise.all` over the peer array; no streams leaked. `lastError` is captured by reference, not accumulated. No timers created in the helper; scheduled-retry timer lifecycle is unchanged.
- **Error handling** — all `update()` calls wrapped in try/catch; no thrown errors bubble past `broadcastMergedRecord`. Logging on every failure path. Errors are stringified safely (`err instanceof Error ? err.message : String(err)`).
- **DRY** — the `?? 250` (etc.) defaults appear in both `coordinator-repo.ts` and the `ClusterCoordinator` constructor. Intentional: the constructor defaults are the safety net for direct-construction callers (the test passes `baseCfg` without the new fields). Not flagged.
- **Documentation** — code comments accurately describe behavior (`broadcastMergedRecord` JSDoc explains the "connection is warm from prior commit phase" rationale). No external docs needed an update — the new config knobs are documented inline on `ClusterConsensusConfig`.

### What was found

- **One major regression, by design**: the Tier 2 e2e is now 3-of-3 deterministic on the historically-flaky specs (baseline was 3-of-16 flake). The implementer's analysis is accurate — the shortened total retry budget removes the safety net that was catching recoveries-after-15-s. The browser trace (`C:\Temp\tier2-run1.log`) confirms `cluster-tx:consensus-broadcast-retry` fires (proves the new helper is on the hot path) but every in-line retry also fails — the underlying `protocol-client dial:fail` rate is ~15 %, far above what a 2-attempt back-to-back retry can mask. This is the network-layer reality the ticket explicitly anticipated and flagged for follow-up; not a fix-in-this-pass finding.
- **Three follow-up `fix/` tickets filed** (per the implementer's own recommendation in the review handoff):
  - `optimystic-coordinator-read-repair` — addresses the immediate user-visible symptom (peers stuck on stale views after a missed broadcast).
  - `optimystic-circuit-relay-reservation-lifetime` — addresses the root-cause network instability (the ~15 % dial-fail rate).
  - `optimystic-cluster-coordinator-connection-caching` — secondary optimization; only helps if libp2p doesn't already reuse the commit-phase connection.
- **Unrelated working-tree state in `../optimystic`**: `packages/reference-peer/src/cli.ts`, `packages/reference-peer/README.md`, and the untracked `packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts` are leftover from the prior `web-e2e-tier2-cluster-supermajority` ticket and are documented in that ticket's complete file. Not flagged as a finding for this ticket.

### What was done

- 3 follow-up `fix/` tickets created (above).
- No inline edits to the implement-stage code. The implementation is correct and well-tested at the unit level; the e2e regression is a design tradeoff the source ticket explicitly accepted.
- Lint/build/test all clean.

### Categories with nothing to report

- **Performance**: no concerns. The helper runs `Promise.all` across peers (parallel) and the per-peer retry loop is sequential by design (the connection is the shared resource — parallel retries against the same connection wouldn't help and could amplify the failure).
- **Security**: no boundary changes. Error messages logged are libp2p / network errors, not user data.
- **Cross-platform**: no platform-specific APIs introduced. `setTimeout` was already in the scheduled-retry path; no new platform surface.
- **Scalability**: per-transaction memory is one extra integer for `commitBroadcastImmediateRetries`; per-call memory is a `lastError` capture. Negligible.
- **Maintainability**: the helper extraction makes the broadcast path easier to test (the diff added 3 specs that would have been awkward to write against the prior inline implementation).
