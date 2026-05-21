---
description: Tighten the post-majority commit-broadcast recovery in `ClusterCoordinator` so the visible inconsistency window after a `cluster-tx:consensus-broadcast-error` shrinks well under the e2e poll cycle. Add an in-broadcast immediate retry per failed peer, drop the scheduled-retry initial interval from 2000 ms to 250 ms (with exponential backoff preserving total budget), and surface both as `ClusterConsensusConfig` knobs so tests/e2e can tune. Fix is scoped to `cluster-coordinator.ts`; no protocol or schema change.
files: ../optimystic/packages/db-core/src/cluster/structs.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/cluster-coordinator.spec.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts
---

## Goal

Eliminate the 3-of-16 Tier 2 distributed-spec flake caused by
`cluster-tx:consensus-broadcast-error` on the post-majority
broadcast (`cluster-coordinator.ts:537`). After commit-majority is
reached, the coordinator broadcasts the merged commit record to all
peers; at least one per-peer broadcast intermittently throws, and the
scheduled retry sits on a 2 s initial interval which is wide enough
for a polling tab to sample the missed peer inside the gap.

The mechanism is documented in the source ticket
(`tickets/fix/web-e2e-tier2-consensus-broadcast-race.md`) and in the
prior complete ticket
(`tickets/complete/web-e2e-tier2-cluster-supermajority.md`,
"Tier 2 e2e — supermajority bug fixed; different residual race").
The supermajority math itself is fixed and **not in scope here**.

## Design

Two changes, layered. **Pick the minimum that makes the symptom go
away**; the second is the safety net.

### 1. In-broadcast immediate retry (cheapest fix)

In `ClusterCoordinator.commitTransaction`, the post-majority broadcast
already uses `Promise.allSettled` over per-peer `update(record)`
calls (cluster-coordinator.ts:531–541). On per-peer failure, do **one
immediate in-line re-attempt** before deciding whether to schedule the
slower retry path.

Most observed `consensus-broadcast-error` events are transient stream
errors against peers that **just** completed a successful
`:commit-response` in the same transaction — i.e., the connection is
known-good seconds earlier. A single in-line retry, with no delay,
re-uses the libp2p connection (`peerNetwork.connect` opens a fresh
stream against the existing connection) and almost always succeeds.

Implementation shape:

```ts
// inside commitTransaction, replace the existing Promise.allSettled
// broadcast block (~lines 531–541) with a helper that:
//  1. Tries `update(record)` once.
//  2. On throw, awaits one extra `update(record)` attempt.
//  3. Logs both attempts under `cluster-tx:consensus-broadcast-retry`
//     so the trace remains diagnosable.
//
// The local cluster path is unchanged (no re-attempt — local is
// in-process and either succeeds or throws fatally).
```

Only **one** in-line retry; further failures fall through to
`scheduleCommitRetry` exactly as today. Don't introduce backoff inside
this loop — that's what `scheduleCommitRetry` is for.

### 2. Drop scheduled-retry initial interval to 250 ms

Today the timer-driven retry starts at `retryInitialIntervalMs = 2000`
(cluster-coordinator.ts:40), backoff ×2, cap 30000, max attempts 5.
Total budget is `2 + 4 + 8 + 16 + 30 = 60 s`.

Replace with `250 ms` initial, backoff ×2, cap 8000, max attempts 5.
Total budget `250 + 500 + 1000 + 2000 + 4000 = 7.75 s`. **First retry
lands inside one app-side poll cycle (the messages refresh cadence in
`packages/reference-app-web/src/lib/messages.svelte.ts` is 4 s).**

The total budget is shorter, intentionally — if the first 7 s of
retries don't land, the post-majority broadcast is unrecoverable from
the coordinator's side anyway, and the cleaner outcome is to let
peer-side gossip / read-repair / next-write paths take over rather
than holding state for a full minute.

### 3. Plumb both as `ClusterConsensusConfig` fields

Add to `packages/db-core/src/cluster/structs.ts:40` (the existing
`ClusterConsensusConfig` interface):

```ts
/** Initial scheduled-retry interval for failed commit broadcasts, ms (default 250). */
commitBroadcastRetryInitialMs?: number;
/** Backoff factor for commit-broadcast scheduled retries (default 2). */
commitBroadcastRetryBackoffFactor?: number;
/** Max scheduled-retry interval, ms (default 8000). */
commitBroadcastRetryMaxIntervalMs?: number;
/** Max scheduled retry attempts before giving up (default 5). */
commitBroadcastRetryMaxAttempts?: number;
/** Immediate in-line retries per failed peer inside the broadcast (default 1). */
commitBroadcastImmediateRetries?: number;
```

All optional with defaults at the use site. `ClusterCoordinator`
constructor at `cluster-coordinator.ts:38–57` reads them from `cfg`
into private fields, replacing the current literals at lines 40–43.

`coordinator-repo.ts:82–90` does **not** need to mirror these into the
policy object — `Partial<ClusterConsensusConfig>` already plumbs them.
But add explicit `??` fallback lines for each new field so the
default lives in one place (the coordinator) and the policy object
remains shaped like a `ClusterConsensusConfig`. Mirror the pattern at
`coordinator-repo.ts:82–90`.

### What we are NOT doing in this ticket

The source ticket lists four design questions. Of those:

- **Re-dial vs piggyback** is partially addressed by the in-line
  retry (which reuses the libp2p connection on the second attempt
  without explicit caching). True connection caching across
  `ClusterCoordinator` phases is a larger refactor; defer.
- **Coordinator-driven read repair** (peer asks coordinator for
  latest record on read) is a protocol-level change. Defer.
- **Circuit-relay reservation lifetime** is browser-side, not
  in `cluster-coordinator.ts`. Defer to a separate browser ticket if
  the symptom survives the fix above.

If the e2e is still red after this ticket, follow up with the
read-repair / relay-reservation tickets — capture findings in the
review-stage handoff.

### Local-optimistic-write side note (out of scope, document only)

The source ticket flagged a separate, narrower observation: one
`two-tab-convergence` run failed at tab A's local optimistic write,
which doesn't touch the network. That points at a `MessageApp` /
Svelte reactivity race in
`packages/reference-app-web/src/lib/messages.svelte.ts:117–132`
(`addMessage`), not at consensus broadcast. **Do not fix it here.**
If the broadcast-race fix lands and the same failure mode persists,
file a fresh fix ticket targeting `messages.svelte.ts` specifically.

## Files

### Edit

- `../optimystic/packages/db-core/src/cluster/structs.ts` — add the 5
  optional fields to `ClusterConsensusConfig` (line 40 block).
- `../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts` —
  - Convert the 4 literal fields at lines 40–43 to constructor-set
    private fields, reading from `cfg` with the documented defaults.
  - Add a new `commitBroadcastImmediateRetries` private field, same
    pattern, default 1.
  - Extract the post-majority broadcast (lines 531–541) into a
    private helper that performs `commitBroadcastImmediateRetries`
    immediate in-line retries per peer before reporting failure.
  - Add a `cluster-tx:consensus-broadcast-retry` log site inside the
    helper, with `{ messageHash, peerId, attempt, error }`. Log the
    final outcome under the existing `:consensus-broadcast-error`
    only on terminal failure.
- `../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts` —
  extend the `policy` literal at lines 82–90 with `??` fallbacks
  for each new field.
- `../optimystic/packages/db-p2p/test/cluster-coordinator.spec.ts` —
  add a focused unit spec that mocks a 3-peer cluster, has one peer's
  broadcast throw on first attempt then succeed on second, and asserts:
  - Final `record.commits` includes all 3 peers (immediate retry
    landed).
  - No `setTimeout` was scheduled (i.e., `scheduleCommitRetry` was
    NOT called for the recovered peer).
  - A second spec: both attempts throw → `scheduleCommitRetry` is
    invoked with the failing peer, first timer at 250 ms.

### Read-only reference

- `packages/reference-app-web/e2e/distributed/{two-tab-convergence,cross-tab-activity,disconnect-mid-session}.spec.ts`
  — re-run after the fix lands; don't modify.
- `packages/reference-app-web/src/lib/messages.svelte.ts` —
  `REFRESH_INTERVAL_MS` cadence is the reference point for "250 ms first
  retry lands inside one poll cycle".

## Validation

```powershell
# Unit-level confidence — fast, agent-runnable
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log
yarn workspace @optimystic/db-p2p test:verbose --grep "broadcast" 2>&1 | tee /tmp/broadcast.log

# Optimystic ref-peer still builds (signature changes flow through)
yarn workspace @optimystic/reference-peer build

# Browser side typechecks
yarn workspace @serfab/reference-app-web typecheck

# Tier 2 e2e — partial check; full sweep is ~10 min wall-clock so do
# not block on it inside the agent. Run the 3 historically-flaky specs
# three times in succession and confirm clean runs.
$env:OPTIMYSTIC_E2E_DEBUG = "1"
yarn workspace @serfab/reference-app-web test:e2e `
  --grep "two-tab convergence|cross-tab activity|disconnect mid-session" `
  2>&1 | tee /tmp/tier2-flaky.log
```

## Acceptance

- New `ClusterConsensusConfig` fields are optional and default to the
  values documented above.
- All existing `@optimystic/db-p2p` tests still pass (no regression in
  the 440-passing baseline noted in the prior complete ticket).
- The new in-broadcast retry unit spec passes in both
  "recover-on-retry" and "schedule-after-all-attempts" cases.
- Across three consecutive runs of the three historically-flaky Tier 2
  specs, zero failures attributable to
  `cluster-tx:consensus-broadcast-error`. If `consensus-broadcast-error`
  still appears in the trace, the new `:consensus-broadcast-retry`
  event must appear first and the next read at 4 s must observe the
  merged commit.
- The full 16-spec Tier 2 sweep — not agent-runnable as a routine
  check — should be **noted as a deferred validation item** in the
  review-stage ticket if the implementer cannot complete it inside
  budget. Hand the reviewer enough trace/logs to verify the
  in-broadcast retry path is firing.

## TODO

Phase 1 — config plumbing

- Add the 5 optional fields to `ClusterConsensusConfig`
  (`db-core/src/cluster/structs.ts:40`).
- Promote the 4 retry literals in `ClusterCoordinator` (line 40–43) to
  constructor-set private fields, defaulting from `cfg`.
- Add `commitBroadcastImmediateRetries` private field, default 1.
- Mirror the `??` fallbacks in `coordinator-repo.ts:82–90`.
- `yarn workspace @optimystic/db-p2p build` to confirm signature flow.

Phase 2 — in-broadcast retry helper

- Extract the post-majority broadcast (cluster-coordinator.ts:531–541)
  into a `private async broadcastMergedRecord(record, peerIds): Promise<{
  failures: string[] }>` helper.
- Inside the helper, per peer, attempt `update(record)` once. On throw,
  re-attempt up to `commitBroadcastImmediateRetries` times. Log
  `cluster-tx:consensus-broadcast-retry` on each retry attempt with
  `{ messageHash, peerId, attempt, error }`. Log
  `cluster-tx:consensus-broadcast-error` only on terminal failure.
- Wire the helper into `commitTransaction`; the existing
  `broadcastFailures` / `scheduleCommitRetry` branch consumes the
  helper's `failures` list.
- Re-run `yarn workspace @optimystic/db-p2p test` — no regressions.

Phase 3 — unit specs

- Add `cluster-coordinator-broadcast-retry.spec.ts` (or extend the
  existing `cluster-coordinator.spec.ts` if its scaffolding fits):
  - **Recover-on-retry**: 3-peer mock, one peer's `update` throws on
    first call, returns the merged record on second call. Assert
    final `record.commits` has 3 entries and no scheduled timer was
    set for that peer.
  - **Schedule-after-all-attempts**: same setup, but the peer throws
    on both attempts. Assert `scheduleCommitRetry` was invoked with
    the failing peer and the first timer interval is 250 ms.
  - **Custom config wins**: pass
    `commitBroadcastRetryInitialMs: 100, commitBroadcastImmediateRetries: 2`
    and verify both knobs are honored.
- Run `yarn workspace @optimystic/db-p2p test:verbose --grep "broadcast"` and confirm green.

Phase 4 — e2e re-validation

- Run the 3 historically-flaky Tier 2 specs three times in succession
  with `OPTIMYSTIC_E2E_DEBUG=1`. Confirm zero `consensus-broadcast-error`
  failures observed by specs.
- Capture the trace from one run and confirm
  `cluster-tx:consensus-broadcast-retry` appears whenever a
  per-peer broadcast threw (proving the in-line retry path is
  exercised).
- If the full 16-spec Tier 2 sweep can be done in budget, run it and
  note the result in the review ticket; otherwise mark it deferred
  for the reviewer.
