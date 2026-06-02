---
description: After the cluster-tx stream-reset throw is fixed (prereq), the Tier-2 web e2e writes succeed but the three multi-tab specs (cross-tab-activity, disconnect-mid-session, two-tab-convergence) still fail — tab B does not see tab A's new messages within the assertion budget. Root cause is replication/keyspace, not transport: the `pend` and `commit` of one logical edit are separate cluster transactions whose cohorts are selected independently, so ~25% of cluster members reach commit-consensus without the matching pend. Post-fix they tolerate this (instead of resetting the stream) but do NOT apply the commit, leaving the block under-replicated; cross-tab reads then return a stale-but-present revision and lazy read-repair can't recover it because no reachable peer holds the newer rev.
prereq: web-e2e-tier2-cluster-tx-stream-reset-rootcause
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/_helpers.ts
---

## Background

This is the **second** root cause uncovered by
`web-e2e-tier2-cluster-tx-stream-reset-rootcause`. That ticket fixed the
`ClusterMember.handleConsensus` throw that reset the cluster stream during
2-phase commit (the masked error was `Pending action <id> not found for
block(s): <blockId>` / `Consensus pend|commit failed: stale revision`). With
that fix the browser coordinator no longer reports `Some peers did not
complete: … cause=The stream has been reset`, and **writes now succeed**
(verified: a target-spec run shows tab A's sends all landing with real
message-ids and no error banner).

But the three multi-tab specs still fail — now on **convergence**, not on the
write: tab B never sees tab A's freshly-sent row within the 20–30 s budget, and
`two-tab-convergence` / `cross-tab-activity` simply time out at 60 s.

## Observed evidence (from a debug e2e run, `OPTIMYSTIC_E2E_DEBUG=1`)

- `cluster-member:consensus-*-diverged` (the new tolerate-don't-throw log) fires
  **~25–36% of member consensus-executions** (30 events across 121
  coordinator-starts, on both the browser and all three service peers). So a
  large fraction of commits reach consensus on members that lack the matching
  pend, and are now silently *not applied* locally.
- `get:missing` = 0 across the whole run: reads always find *some* revision of
  the block — i.e. the log/index block is present but **stale**, not absent. So
  the legacy "missing ⇒ cluster-fetch" trigger never fires.
- `cluster-fetch:synced` = 0: lazy read-repair never pulled a newer revision —
  consistent with no reachable peer holding it (under-replication) and/or the
  10 s read-repair window not having elapsed within a 4 s poll.
- A residual handful of transport-level `StreamResetError` remain in the
  browser's `batch-coordinator retry:setup-failed` logs, but they are *retried
  through* (no `Some peers did not complete`), so they are not the blocker.

## Why it happens (hypotheses to confirm)

1. **Pend and commit are independent cluster transactions** (`CoordinatorRepo.pend`
   and `.commit` each call `executeClusterTransaction` → `getClusterForBlock`
   fresh). The cohort chosen for the commit need not equal the cohort that ran
   the pend — especially as the coordinator differs (service peers coordinate
   too) or the FRET keyspace shifts. A member in the commit cohort but not the
   pend cohort cannot apply the commit.
2. **`findCluster` always includes `self`** and the browser tab is a cohort
   member for some blocks, so up to 1/N of a block's "replicas" live in an
   ephemeral browser tab whose storage no other tab can read. Those replicas are
   useless for cross-tab convergence and disappear on tab close, and the *other*
   tab's cohort for the same block contains a *different* browser self.
3. **Browser-tab peer-ids are never pruned** from the service peers' FRET
   keyspace / peerStore for the mesh lifetime, so cohort membership for a fixed
   block drifts across specs.

## Expected behavior

- The three multi-tab specs converge: a message sent on one tab becomes visible
  on the other within the assertion budget, and edits/deletes propagate both
  ways. Full Tier-2 sweep is 16/16, stable across repeated runs.
- A cluster member that reaches consensus on a commit/pend it cannot apply
  locally actively **reconciles** (fetches the committed block from a cohort
  peer that holds it) rather than only tolerating the miss and deferring to a
  read-repair that has nothing to pull from.

## Candidate directions (for the fix agent to evaluate — not a committed plan)

- **Pin the cohort/coordinator for a block across the pend→commit sequence** so
  the same members handle both phases (the ticket-1 notes call this "making the
  coordinator's `findCluster` membership deterministic/stable for a given block
  id regardless of transient browser-tab churn").
- **Active reconciliation in `ClusterMember.handleConsensus`**: when a member
  tolerates a divergent commit (missing pend) it should pull the committed
  revision from a cohort peer (via the sync / block-transfer / restore path)
  so replication is restored and subsequent reads find it. Today the member
  only logs `consensus-commit-diverged` and relies on lazy read-repair, which
  cannot help when no reachable peer has the newer rev.
- **Exclude ephemeral/browser peers from being counted as durable cluster
  replicas**, or evict disconnected browser-tab peer-ids on per-spec teardown
  (`_helpers.ts`).
- **Read-repair tuning** for the multi-tab read path (window/sample) so present-
  but-stale index blocks refresh fast enough for the test budget — secondary to
  fixing replication, since read-repair is only useful once a peer actually
  holds the newer revision.

## Acceptance

- Full Tier-2 sweep passes 16/16 consistently across repeated runs
  (`OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`,
  single worker), with `cross-tab-activity`, `disconnect-mid-session`, and
  `two-tab-convergence` green.
- New `db-p2p` regression coverage (mesh-harness or coordinator-repo level)
  demonstrating that a member which misses the pend phase ends up holding the
  committed revision after consensus (replication restored), and that a
  cross-cohort pend→commit converges.
- `@optimystic/db-p2p` build + tests pass.
