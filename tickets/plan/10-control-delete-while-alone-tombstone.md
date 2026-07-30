description: When an administrator revokes a peer's membership while their node is the only one online, that revocation can be lost — the removed peer may keep looking like a member to everyone else. Make membership revocations survive being made offline.
prereq: control-write-ensure-replicated
files: packages/cadre-core/src/control-schema.ts (CadrePeer table — would gain a tombstone/soft-delete column + constraints), schemas/control.qsql (mirror — kept in sync by control-schema-drift.spec.ts), packages/cadre-core/src/cadre-node.ts (removePeer + drainPendingPeerWrites delete path, isMember/listMembers/queryCadrePeers filtering), packages/cadre-core/src/control-database.ts (queryCadrePeers/queryPeerRecord must exclude tombstoned rows), packages/cadre-core/src/seed-bootstrap.ts (removePeer → soft-delete write)
----

## Problem

`control-write-ensure-replicated` closed the write-while-alone durability gap for
INSERT/UPDATE-shaped control writes (authorize a peer, (re)publish a self record /
device token) by re-issuing them as idempotent monotonic updates once the cohort
grows. **DELETEs cannot be remedied the same way.**

`removePeer(X)` is a physical `delete from CadrePeer where PeerId = X`. When it
commits while the node is alone (0 control connections ⇒ the block's cluster ≤1),
the deletion is **local-only**: the row is gone locally, but the cohort — which may
still hold X's membership row from an earlier replicated insert — never learns of
the removal. On cohort growth the re-replication drain *attempts* a best-effort
re-issue of the DELETE, but the row is already gone locally, so the re-issued
`delete … where PeerId = X` matches nothing and produces no broadcasting
transaction. The removal does **not** propagate.

This is **security-relevant**: a peer whose membership was revoked while the
authority was offline can remain a member elsewhere in the party (and across a
restart of the authority, the intent to remove leaves no local trace at all — the
row is simply absent). `control-write-ensure-replicated` ships this as a documented
limitation: the alone-commit is **logged loudly** at `removePeer` time and a
best-effort re-issue is attempted, but full durability is deferred here.

## What "done" looks like

A membership revocation made while alone must converge to the rest of the cadre
once the cohort forms — and survive a restart of the revoking node in between.

The agreed approach is a **tombstone (soft delete)** the schema carries, rather
than a physical delete:

- `CadrePeer` gains a tombstone marker (e.g. a `Removed`/`RemovedAt` column, or a
  status enum) written under the existing authority signature. A revocation becomes
  an authority UPDATE that sets the tombstone + bumps `UpdatedAt` — which IS
  re-issuable on cohort growth exactly like an authorize re-touch, and IS
  reconstructable on restart (the tombstoned row is still present locally).
- Membership reads (`isMember`, `listMembers`, `queryCadrePeers`, `resolvePeerAddrs`,
  `resolveDeviceToken`, cohort/seed derivation) must treat a tombstoned row as
  **not a member** (filter it out), so a tombstone is observationally identical to a
  removal for every consumer.
- The schema constraints must keep a tombstone monotonic/irreversible enough that a
  removed peer cannot silently un-revoke itself (decide whether re-authorization is
  an authority-only un-tombstone or requires a fresh insert).
- Decide the same disposition for `DeviceToken` deletes (`clearDeviceToken` /
  `expireDeviceToken`), which have the identical physical-delete-while-alone gap but
  are lower-severity (a stale push token, not a membership leak).
- Keep `control-schema.ts` and `schemas/control.qsql` in lockstep
  (`control-schema-drift.spec.ts` enforces this) and account for GC/compaction of
  tombstones if the control tables are expected to stay small.

## Use cases / tests

- **Revoke-while-alone converges.** Authority A removes peer X while no sibling is
  connected, then a reader B connects: B must observe X is no longer a member
  (today this is the gap — B keeps X).
- **Revoke-while-alone survives restart.** A removes X while alone, A restarts, then
  connects to B: the revocation still propagates (the tombstone is reconstructable;
  a physical delete leaves nothing to reconstruct).
- **Re-authorization after tombstone.** A tombstoned peer that is legitimately
  re-added becomes a member again through the sanctioned path, without a replayed
  stale row resurrecting it.
- **Reader treats tombstone as absent.** Every membership read path excludes a
  tombstoned row.

## Notes

- Out of scope for `control-write-ensure-replicated` (which deliberately shipped the
  loud-log + best-effort + this follow-up). This is a schema change with cross-cutting
  read-path impact, so it warrants its own design/plan pass before implementation.
- The proxy for "alone" remains `getConnections().length === 0` (a sound lower
  bound); a precise `getClusterSize(blockId)` seam would tighten it but is a separate
  concern (see `control-write-ensure-replicated`).
