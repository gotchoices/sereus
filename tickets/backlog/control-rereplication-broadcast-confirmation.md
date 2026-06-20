description: When a node tries to re-send a membership change it made while offline, it currently assumes the re-send worked and forgets about it — but if the only node it just connected to isn't one that actually stores the data, the change can silently fail to spread and never be retried. Make re-sends keep trying until the change has really propagated.
prereq: control-write-ensure-replicated
files: packages/cadre-core/src/cadre-node.ts (drainPendingPeerWrites / reissuePeerAuthorize / reconstructAuthoredMembership clear-on-exec semantics; handleControlConnectionChange edge trigger; reconcileControlCohort tick), packages/cadre-core/src/seed-bootstrap.ts (reauthorizePeer — no broadcast/cluster-size signal today)
----

## Problem

`control-write-ensure-replicated` re-issues a control write that committed
local-only (made "while alone") once the control cohort grows from 0→≥1
connections. The re-issue drains the in-memory queue and clears each entry as soon
as the underlying `db.exec` (`reauthorizePeer` UPDATE, or best-effort
`removePeer`) **returns successfully**.

The gap: a successful `db.exec` does **not** mean the write broadcast. Optimystic
only broadcasts when the block's cluster has ≥2 members. The drain's trigger —
`getConnections().length > 0` — is a coarse proxy for "no longer alone"; the
connection that fired the 0→≥1 edge may be a relay, a bootstrap node, or any peer
that is **not** in the affected block's cluster. In that case the re-issued write
commits local-only **again**, the `db.exec` still returns success, and the drain
**clears the queue entry anyway**. The write is now forgotten while still
unreplicated, and:

- the drain fires only on the connection **edge** (0→≥1), deliberately not on every
  reconcile tick, so there is **no retry** while the node stays continuously
  connected — only a full disconnect→reconnect re-arms it; and
- the first-growth `reconstructAuthoredMembership` pass is **one-shot** per process,
  so authority-authored rows it re-touches on a non-cluster edge are never revisited.

There are partial safety nets today (a peer eventually self-publishes/heartbeats its
own row; `registerSelf`'s periodic heartbeat re-publishes self rows while connected),
but an **authority-authored, self-`Sig`-null** membership row for a peer that is
slow/never to self-publish can be dropped from the queue without ever converging if
the first growth edge is a non-cluster connection.

## What "done" looks like

A write queued for re-replication stays queued (and keeps being retried) until it
has demonstrably propagated — not merely until one local re-commit returns.

Open design questions to resolve before implementing:

- **Confirmation signal.** Is there a seam to learn whether a commit actually
  broadcast (or the block's `getClusterSize(blockId)` ≥ 2)? If so, only clear a
  queue entry once the write committed against a cluster that broadcasts; otherwise
  leave it queued. This is the same precise-signal seam noted as future work in
  `control-write-ensure-replicated` (the `getConnections()===0` proxy would be
  replaced/augmented by `getClusterSize`).
- **Bounded retry cadence.** If no broadcast-confirmation seam exists, add a
  reconcile-driven drain that re-attempts while the queue is non-empty (bounded /
  backoff to avoid a re-touch storm — the ticket that shipped the edge-only trigger
  deliberately avoided draining on every tick). Decide the bound and backoff.
- **Reconstruction re-arming.** Decide whether `reconstructAuthoredMembership` should
  be allowed to re-run (or fold its rows into the retried queue) when an early growth
  edge was a non-cluster connection, rather than being strictly one-shot per process.

## Use cases / tests

- **Non-cluster first edge does not drop the write.** Authority writes while alone,
  then connects first to a relay/non-cluster peer (block cluster still ≤1): the
  re-issue must NOT clear the queue entry; once a real cluster member connects the
  write converges to a reader.
- **Continuous-connection retry.** A re-issue that re-commits local-only while the
  node stays connected is retried (on a bounded cadence) without requiring a full
  disconnect→reconnect.
- **No re-touch storm.** With nothing pending, the steady-state reconcile tick issues
  no re-touch writes.

## Notes

- Out of scope for `control-write-ensure-replicated`, which shipped the edge-only
  drain as the agreed first cut and explicitly flagged this retry/confirmation
  concern. Relates to (but is distinct from) the delete-durability follow-up
  `control-delete-while-alone-tombstone`: this ticket is about *retrying until
  propagated* regardless of write shape; that one is about making *deletes
  re-issuable at all* via a tombstone.
- Likely wants a precise `getClusterSize` / broadcast-result seam from the
  `../optimystic` workspace; scope that dependency during design.
