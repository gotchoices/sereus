<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-30T23:31:45.149Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\10-control-delete-while-alone-tombstone.plan.2026-07-30T23-31-45-149Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: When an administrator revokes a peer's membership while their node is the only one online, that revocation can be lost — the removed peer may keep looking like a member to everyone else. Make membership revocations survive being made offline.
prereq: control-write-ensure-replicated
files: packages/cadre-core/src/control-database.ts (deleteGuardedRow — delete + Revocation tombstone in one transaction; queryRevokedStamps), packages/cadre-core/src/cadre-node.ts (noteControlWrite / drainPendingControlReplication / reissuePendingPeerWrites — the write-while-alone queue; listAuthorizedMembers / listMembers / isMember read paths), packages/cadre-core/src/control-schema.ts + schemas/control.qsql (CadrePeer, Revocation; kept in lockstep by control-schema-drift.spec.ts), packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts (the insert/update sibling scenario this one mirrors), packages/integration-tests/src/harness/node-fixtures.ts (bootPair / controlNodeConfig / connectControlNodes), docs/architecture.md (Control Network → delete-while-alone durability, ~line 199), ../optimystic/docs/internals.md (behind-member reconcile, ~lines 279-331)
difficulty: hard
----

## Problem

`control-write-ensure-replicated` closed the write-while-alone durability gap for
INSERT/UPDATE-shaped control writes. DELETEs were left open.

`removePeer(X)` deletes the `CadrePeer` row and, in the same transaction, appends a
`Revocation` tombstone retiring that row's `StampId`
(`ControlDatabase.deleteGuardedRow`). When that transaction commits while the node
is alone (0 control connections ⇒ the block's cluster ≤1), Optimystic commits it
**local-only**: neither the delete nor the tombstone is broadcast, and the rest of
the cadre may keep treating X as a member.

The on-growth re-issue that rescues inserts/updates cannot replay a delete as-is:
`deleteGuardedRow` reads the row's stamp first, finds the row already gone locally,
and returns `false` without issuing any statement — so nothing broadcasts.

Security-relevant: a peer whose membership was revoked while the authority was
offline can remain a member elsewhere in the party.

## Research findings so far (read this before re-deriving anything)

**1. The schema already has a tombstone — `Revocation`.** The original premise of
this ticket ("add a `Removed`/`RemovedAt` soft-delete column to `CadrePeer`") is not
the only option and probably not the cheapest. Every guarded delete already writes an
append-only `Revocation` row (`TableName`, `RowKey`, `StampId`), owner-signed under
its own `'CadreControl.Revocation' / 'remove'` digest, and readers already honour it:

- `CadreNode.listAuthorizedMembers` drops any `CadrePeer` row whose `StampId` is in
  `queryRevokedStamps('CadrePeer')`.
- `CadreNode.resolveDeviceToken` does the same for `DeviceToken`.

So "tombstone the row" is already true; what is missing is getting that tombstone
**broadcast** when it was written alone.

`docs/architecture.md` (~line 199) already names this as the cheapest lever for this
ticket, with the caveat that a re-issue must carry the tombstone's own owner
signature in its write context, because `Revocation.Authorized` re-checks it on every
node.

**2. But a literal re-INSERT of the tombstone will not work.** The `Revocation` row
is already present locally after the alone commit, and its primary key is
`(TableName, StampId)` — re-inserting collides. `Revocation.Immutable` forbids update
and delete, so there is no in-place re-touch either, and `StampId` is the retired
stamp so it cannot be varied. **Any design that says "queue the tombstone insert and
replay it" must first answer what statement it actually issues.** This is the single
open question blocking the implement handoff.

**3. There may be no need for a new statement at all — unverified.** Optimystic's
`docs/internals.md` (~lines 279-331) states that a member which is *behind* on a block
holds no usable revision and therefore **pulls the committed revision from the
cohort** rather than applying a delta. If that holds for the control collection, then
*any* broadcasting write after cohort growth (the drain already calls `registerSelf()`
on the first growth edge, which is a `CadrePeer` write) would carry the earlier
local-only delete along with it — and this ticket collapses into "prove it with a
regression scenario, and guarantee a broadcasting write is issued whenever a `remove`
is queued". Settle this empirically before designing any schema change.

**4. The experiment to settle it was run and was INVALID — do not trust its result.**
A scratch integration scenario (`bootPair` → connect → `authorizePeer(X)` → converge
on B → close all connections on both sides → `removePeer(X)` → reconnect → does B drop
X?) reported convergence, **but the log showed A holding 1 control connection at
removal time**: something re-dialled between the both-sides-idle assertion and the
write, so the removal was never actually made alone. The result says nothing about the
alone case. A valid rerun needs the re-dial suppressed — candidates: pass a very large
`reconcileMs` through `controlNodeConfig` on both nodes (the option already exists),
gate dials on one side, or identify which side re-dials
(`CadreNode.reconcileControlCohort` vs. the peer's own cohort logic) and quiesce it.
Note the harness uses `MemoryRawStorage`, so the "survives a restart of the revoking
node" case has no persistence to restart onto and needs a different fixture.

Mechanics for a rerun: `cd packages/integration-tests && npx vitest run
src/scenarios/<file>.integration.ts` — a **package-relative, forward-slash** path filter does
work on Windows (verified 2026-07-31: one scenario ran in 38 s total). Prefer it over `-t
"<test name>"`, which matches the test name but still imports every scenario file, costing
~2 minutes of transform/import before anything runs. The suite has a stale-build guard —
`../quereus` and `../optimystic` may each need a rebuild before it will run.

## Remaining work for this plan pass

- Settle finding 3 with a **valid** isolation recipe. Its outcome decides everything
  downstream.
- If a later broadcast does NOT carry the delete: design the re-issuable removal.
  Compare (a) a soft-delete column on `CadrePeer` (monotonic `RemovedAt` bumped by an
  owner-signed UPDATE — re-issuable and reconstructable after restart, but a
  cross-cutting read-path change plus new constraint surface: monotonicity, whether
  re-authorization is an un-tombstone or a fresh insert, and tombstone GC) against
  (b) any statement that makes the existing `Revocation` row re-broadcast. Pick one,
  document the tradeoff, do not hand the choice to the implementer.
- Decide the same disposition for `DeviceToken` clears (`clearDeviceToken` /
  `expireDeviceToken`) and for `deleteStrand` / `deleteValidationKey`, which share
  `deleteGuardedRow` and carry the identical gap at lower severity.
- Keep `control-schema.ts` and `schemas/control.qsql` in lockstep if the schema
  changes (`control-schema-drift.spec.ts` enforces it).
- Emit the implement ticket(s) with an `## Edge cases & interactions` section
  covering: a removal racing a re-authorization; a node that converged on the re-add
  before the tombstone; re-authorizing a previously removed peer; a removal made alone
  followed by a restart before any cohort forms; and every membership read path
  (`isMember`, `listMembers`, `listAuthorizedMembers`, `resolvePeerAddrs`,
  `resolveDeviceToken`, cohort/seed derivation) agreeing on tombstoned rows.

## Use cases / tests

- **Revoke-while-alone converges.** Authority A removes peer X while no sibling is
  connected, then a reader B connects: B must observe X is no longer a member.
- **Revoke-while-alone survives restart.** A removes X while alone, A restarts, then
  connects to B: the revocation still propagates.
- **Re-authorization after tombstone.** A removed peer that is legitimately re-added
  becomes a member again through the sanctioned path, without a replayed stale row
  resurrecting it.
- **Reader treats tombstone as absent.** Every membership read path excludes a
  tombstoned row.

## Notes

- The proxy for "alone" remains `getConnections().length === 0` (a sound lower bound);
  a precise `getClusterSize(blockId)` seam would tighten it but is a separate concern
  (see `control-write-ensure-replicated`).
- The commit-alone is already logged loudly at `removePeer` time and a best-effort
  re-issue is attempted, so the gap is visible in logs today.
