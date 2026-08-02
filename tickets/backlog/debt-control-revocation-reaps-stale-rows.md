----
description: When someone's access is revoked, machines that were offline at the time keep the person's old record forever — ignored, but never cleaned up, and the two machines' copies of the member list stay permanently out of step. Let a machine delete a record it can see has been revoked.
prereq: control-revocation-drain-on-growth
files: schemas/control.qsql + packages/cadre-core/src/control-schema.ts (CadrePeer.AuthorizedDelete, Revocation), packages/cadre-core/src/control-database.ts (deleteGuardedRow, queryRevokedStamps, queryCadrePeers), packages/cadre-core/src/cadre-node.ts (the growth-edge drain), tickets/blocked/forked-control-collection-sync-livelocks.md
difficulty: hard
----

## Situation

`control-revocation-reissuable-tombstone` + `control-revocation-drain-on-growth` make a
revocation converge: the owner-signed tombstone reaches every node, and every membership
read treats the retired row as absent. Two things they deliberately leave behind:

1. **The stale row itself is never removed.** A node that held the member's row when the
   revocation happened keeps it forever. It is inert — every read path filters it — but
   it is permanent garbage in a table that is supposed to be small, and it means "what
   rows exist" differs from node to node indefinitely.

2. **The member table stays forked.** The revoking node deleted the row; the others did
   not. That divergence is the trigger described in
   `tickets/blocked/forked-control-collection-sync-livelocks`, where later writes from the
   revoking node exhaust the storage layer's retry budget instead of reconciling. Closing
   the fork on the sereus side removes one route into that upstream wall (it does not fix
   the wall — `tickets/blocked/strand-unique-index-sync-stale-revision` reaches the same
   failure with no fork involved).

## What is wanted

A node that holds both a live guarded row and the tombstone retiring that row's stamp
should be able to delete the row locally, without needing the party owner's private key.

The authorization for that already exists and is already owner-signed: the tombstone
names the exact table, row key, and stamp being retired. So the guarded tables'
delete rule could gain a branch that authorizes a delete by the **existence of a
committed `Revocation` row naming this exact row incarnation** — the same shape as the
consent branch of `Strand.AuthorizedInsert`, which authorizes by the existence of a
`FormationUsage` row rather than by a signature. `RevocationRecorded` is satisfied
without filing a second tombstone, since the tombstone is what triggered the reap.

Once that lands, the retired-stamp filter added to `queryCadrePeers` /
`queryPeerRecord` becomes belt-and-braces rather than the load-bearing mechanism.

## Open questions for whoever plans this

- **Where does the reap run?** Candidates: the existing cohort-growth drain, the periodic
  cohort reconcile tick, or lazily whenever a read notices a filtered row. Cost is one
  scan of the tombstone set against live rows.
- **Which tables?** `CadrePeer` is the one with a fork problem. `DeviceToken`, `Strand`,
  and `ValidationKey` share `deleteGuardedRow` and would get the same branch for free, but
  `Strand` rows carry a member private key and a mistaken reap is destructive — decide
  per table rather than by default.
- **A reap performed while the reaping node is itself alone** commits local-only and
  diverges that node's revision history in turn, even though the two nodes now agree on
  content. Whether that matters is a question about the storage layer's reconcile
  semantics, not about this rule.
- **Widening a delete rule is security surface.** The branch must bind the stamp, not
  just the row key, or a stale tombstone from a previous incarnation would authorize
  deleting the current one.
