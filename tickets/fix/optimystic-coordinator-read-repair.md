---
description: After `web-e2e-tier2-consensus-broadcast-race` shortened the ClusterCoordinator's post-majority broadcast retry budget from 60 s to 7.75 s, peers that miss the commit-record broadcast now have no path to catch up. The original design assumed peer-side gossip / read-repair / next-write paths would mask this, but those paths don't exist yet. Browser trace from the Tier 2 e2e shows `cluster-tx:consensus-broadcast-error` × 13 with no follow-up reconciliation: tab B's 4 s message poll never observes the row tab A just wrote because tab B's peer is permanently stale on that block until the next write touches it. This is the dominant cause of the now-deterministic 3-of-3 failure on the historically-flaky Tier 2 specs.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-core/src/cluster/structs.ts
---

## Problem

A successful `cluster-tx:commit-majority-reached` event guarantees ≥ N×0.51 peers stored the commit locally, but the post-majority broadcast fans the merged record out to **all** peers so each can independently verify and execute. When that broadcast fails to a subset of peers, those peers hold a stale view of the affected blocks forever (until a subsequent write happens to touch the same blocks). Polling readers on those peers observe stale data indefinitely.

## Expected behavior

On read, a peer that detects it may have missed a recent commit for a block — or, more pragmatically, on every read of a block whose last-known commit timestamp is older than some threshold — should query a peer in the cluster (preferably the coordinator from the most recent commit it saw, or any cluster member) for the latest merged record for that block and reconcile locally.

## Specifications

- A read-path hook that, on a get of `BlockId X`, optionally validates the local view against a remote authority before returning. The trigger heuristic is open — could be `(now - lastLocalCommitMs) > policy.readRepairWindow`, could be on every read in a `readRepairMode: 'paranoid'`, could be probabilistic.
- A mechanism for the read-repair fetcher to identify which peer(s) to ask. The cluster set is known via `keyNetwork.findCluster(blockId)`; the most-recent coordinator for that block is the natural authority but not currently tracked across reads.
- A merge step that diffs the local record against the remote and applies any commits the local view is missing. The existing `ClusterRecord` merge logic in `cluster-coordinator.ts` is the right shape; the read-repair path likely reuses it.
- A config knob to disable / tune the behavior. Default should be on for browser peers (high broadcast-failure rate) and probably off / lazy for service peers (which see broadcasts more reliably).
- Logging events (`cluster-tx:read-repair-triggered`, `cluster-tx:read-repair-applied`, `cluster-tx:read-repair-noop`) so the Tier 2 e2e debug log can confirm the path runs.

## Acceptance

- Reproduce: with `OPTIMYSTIC_E2E_DEBUG=1`, run the 3 historically-flaky Tier 2 specs (the ones listed in `tickets/complete/web-e2e-tier2-cluster-supermajority.md`); they currently fail 3-of-3. With read-repair landed, they should pass deterministically because tab B's message poll will trigger a read-repair that pulls in the row tab A wrote.
- Unit test that a peer with a stale `ClusterRecord` for a block correctly fetches and merges the latest record on read.
- Existing 14 ClusterCoordinator specs continue to pass.

## Context

This ticket was spawned during review of `web-e2e-tier2-consensus-broadcast-race`. See that complete ticket for the full trace analysis and the design rationale for the shortened retry budget.
