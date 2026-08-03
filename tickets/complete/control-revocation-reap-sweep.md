---
description: Machines now clean up the leftover member records of people whose access was revoked while they were offline, on the regular ~15-second timer, and only while connected to at least one other machine.
files: packages/cadre-core/src/control-database.ts (REAPABLE_TABLE_SET/isReapableTable ~376, reapRevokedRow ~1500, reapRevokedRows ~1584), packages/cadre-core/src/cadre-node.ts (runReconcileControlCohort ~1785), packages/cadre-core/test/control-revocation-reap.spec.ts (sweep describe ~437), packages/cadre-core/test/cadre-node-control-cohort.spec.ts (injectCohort + reap describe ~305), docs/architecture.md (lines 41, 204)
---

# Reap sweep — enumerate held tombstones, drop the rows they retire

## What shipped

Replication carries a `Revocation` tombstone but cannot carry the delete it stands for:
replaying `delete … where PeerId = X` on a node where X is already gone is a no-op. So a
node that converged on a removal *while still holding the removed row* kept that row
forever — inert to every reader (the retired-stamp read filters drop it) but never
removed. The prereq ticket added the schema branch letting any node holding row +
committed tombstone delete that row with no owner key, plus the single-row
`ControlDatabase.reapRevokedRow`. Nothing called it. This ticket added the enumeration
and its scheduling.

**`ControlDatabase.reapRevokedRows(selfPeerId): Promise<number>`** walks
`queryRevocations()`, early-returns 0 on an empty table, and calls `reapRevokedRow` for
each tombstone — skipping tables with no reap branch (`Strand`, `OwnerKey`, via a new
`isReapableTable` narrowing predicate) and this node's own `CadrePeer` / `DeviceToken`
row. Enumerates unlocked, deletes per-row locked, since `reapRevokedRow` takes the
non-re-entrant write lock itself. Per-row failures are logged and skipped; per-row
teardown guard returns the count so far.

**Scheduling**: `CadreNode.runReconcileControlCohort` calls it after
`refreshDelegateGrants()` and *before* the sibling enumeration, gated on
`getControlConnectionCount() > 0`, wrapped in try/catch.

The two placement decisions are the load-bearing ones. **Before the enumeration**,
because a cadre whose only sibling row is the tombstoned one reads as zero siblings
(`listMembers()` filters retired stamps) and takes the pass's cold-start early return —
placed after, the reap would never run for the smallest and most likely case.
**Connected-only**, because a reap is a write and a write committed alone is local-only
and forks this node's own revision history — the exact condition this line of work exists
to stop creating. Nothing is urgent, since the stale row already reads as absent.

**Docs**: `docs/architecture.md` line 41 (the `Revocation` table row) and line 204
("Delete-while-alone durability") both rewritten — the reap is now driven, with the
connectivity gate, the skip-self rule, the `Strand` exclusion, the still-load-bearing
read filters, the O(tombstones) cost, and an explicit statement that this does **not**
close `forked-control-collection-sync-livelocks` (content convergence is not revision
convergence).

## Review findings

### Checked and clean — no finding

- **Authorization model.** The sweep introduces no new authority: every delete still runs
  through `reapRevokedRow`, whose stamp guard and schema branch the prereq ticket's
  negative suite pins. Nothing here can delete a row no committed tombstone names.
- **Table dispatch.** `isReapableTable` is a `Set` membership test, so a tombstone whose
  `TableName` arrived by replication carrying an unexpected string is skipped rather than
  reaching a `GUARDED_KEY_COLUMN` lookup. Verified the three reapable tables match the
  three schema `AuthorizedDelete` reap branches exactly (`control-schema.ts:131`
  ValidationKey, `:331` CadrePeer, `:450` DeviceToken; `:264` records Strand's deliberate
  absence).
- **Skip-self correctness.** Traced the identity actually used: `selfPeerId` is
  `controlNode.peerId.toString()`, and both `CadrePeer.PeerId` (`registerSelf`) and
  `DeviceToken.PeerId` (`registerDeviceToken:2605`, `retouchSelfDeviceToken:2260`) are
  that same control peer id. The skip therefore covers the rows it claims to. Also
  confirmed the stated rationale holds: `registerSelf`'s insert-if-absent guard reads
  through the *unfiltered* `queryStampId`, so keeping the self row is what keeps it on the
  update path.
- **Lock discipline.** Enumerate-unlocked / delete-per-row-locked matches
  `reissueAuthoredMembershipRows`. No path takes the non-re-entrant write lock twice.
- **Overlap with `drainPendingRevocations`.** Re-derived independently: the drain updates
  `Revocation.ReissuedAt`, the sweep deletes guarded rows; disjoint tables, and both take
  the write lock per statement. The call-site comment forbidding a mutex is correct.
- **Interaction with the owner's re-touch sweep.** `reissueAuthoredMembershipRows`
  re-touches `Sig`-null rows from `queryCadrePeers`, which already drops retired stamps —
  so a reaped row was invisible to it before the reap. No conflict.
- **Teardown.** Per-row `initialized`/`db` guard plus the node-level `_running` re-guard
  after the call. No resource is held across the sweep.
- **Docs.** Read `docs/architecture.md` (both edited sites — accurate and complete),
  `docs/STATUS.md` (correctly **not** edited: its `Revocation` / `resolveDeviceToken`
  claims at lines 237-244 only assert the retired-stamp read gate exists and is
  exercised, which stays true because the filters remain load-bearing *after* this
  change; line 769 is a lint-exemption list, unaffected), and `docs/cadre-consistency.md`
  (contains no revocation-reap content — nothing to update).

### Deviation from the ticket — reviewed and kept

The implement handoff flagged that it added a per-row try/catch the ticket's pseudocode
did not have, and offered to delete it. **Keep it.** It is not defensive padding: a
`reapRevokedRow` against a live never-tombstoned row throws a schema constraint error
(pinned by `control-revocation-reap.spec.ts:223`), so a throwing row is reachable, not
hypothetical — and without the catch, one such row would abort the sweep at that point on
*every* subsequent pass forever, starving every tombstone behind it. Rows are independent
and the node-level try/catch is still the outer net.

### Minor — fixed in this pass

- **Sweep-level coverage stopped at `CadrePeer`.** The added tests proved the skip rules
  and the `CadrePeer` reap, but nothing proved a `DeviceToken` or `ValidationKey`
  tombstone actually reaches `reapRevokedRow` *through the sweep*, nor that the returned
  count aggregates past 1 (that count is what the reconcile pass logs). Per-row coverage
  for those tables existed, but the sweep's own dispatch was untested for them. Added
  `reaps every reapable table in one pass, and counts each row it removed` to
  `control-revocation-reap.spec.ts` — seats a sibling `DeviceToken` and a
  `ValidationKey`, tombstones both, asserts the sweep returns 2 and both rows are gone.

### Major — none

No finding rose to a new ticket. The one thing that looks like a gap — no live-network
proof — is not this ticket's to fix: the scenario that would carry it
(`control-delete-while-alone-convergence.integration.ts`) already dies in setup on
`tickets/blocked/control-db-cross-node-convergence-halted.md`, so a new integration
scenario would only add to the pre-existing-failure ledger. The handoff declared this
honestly and `docs/architecture.md` now states it in the doc itself.

### Tripwires — recorded at the code, not filed as tickets

- **Membership-gate refresh fanout.** `reapRevokedRow` routes `CadrePeer` deletes through
  `mutateCadrePeer`, which fires the membership-change listener — two table scans per
  call, awaited serially. A sweep clearing K rows therefore fires K redundant refreshes
  (the snapshot cannot change; `queryCadrePeers` already dropped those rows). Harmless
  today because K is the unreaped backlog, which a party burns to 0 on its first
  connected tick and holds there. `NOTE:` at `control-database.ts` in the `peer-reap`
  branch of `reapRevokedRow`, with the fix (hoist to one refresh after the sweep).
  This also explains the double `refreshMembershipGate` on a reaping pass — the pass
  refreshes at its top and the reap invalidates it; same K-bound, same fix.
- **Connectivity gate sampled once per sweep.** `getControlConnectionCount() > 0` is
  checked before the loop, so a disconnect landing mid-sweep lets the remaining rows
  commit alone — the fork the gate exists to prevent. Bounded by sweep duration, which is
  bounded by the same K. `NOTE:` at the `cadre-node.ts` call site, with the fix (move the
  check into the loop via an injected predicate).

### Observed, measured, deliberately not filed

`packages/cadre-core/src/cadre-node.ts` is **4759 lines** (`wc -l`). That is large, and
no board ticket claims it. Not filed: this diff added 36 of those lines, the debt is
entirely pre-existing, and *where* to cut a 4759-line orchestrator is a design decision a
human should make rather than a shape a review can settle. Recorded here so the next
reader who touches this file has the number.

## Validation

```
packages/cadre-core:
  npx vitest run test/control-revocation-reap.spec.ts test/cadre-node-control-cohort.spec.ts
    → 45 passed (44 before, +1 added this pass)
  npx vitest run test/control-revocation-reap.spec.ts test/cadre-node-control-cohort.spec.ts \
      test/cadre-node-control-replication.spec.ts
    → 73 passed
  npx vitest run test/control-membership-hub.spec.ts test/control-database-offline-peers.spec.ts \
      test/device-token-registry.spec.ts
    → passed
repo root:
  yarn typecheck                          → exit 0
  yarn lint                               → exit 0, 0 warnings
  yarn workspace @serfab/cadre-core build → exit 0
```

**One pre-existing failure surfaced**, in a file this ticket never touched:
`control-revocation-replay.spec.ts:1061` expects an `AuthorizedReissue` CHECK rejection
on an unsigned `update CadreControl.Revocation set ReissuedAt = 1` and instead gets
`context.OwnerKey isn't a column` — a Quereus plan-time failure when a statement omits
`with context` while a constraint references `context.*`. It reproduces with that file
run alone, and this ticket changed no schema and no `Revocation` update path. Written up
in `tickets/.pre-existing-error.md` for the triage pass. Nothing was skipped or loosened.

## Known gaps carried forward from implement

- **No live-network proof** — unit-level only (sweep against a real `ControlDatabase`
  with a real schema; scheduling against a stubbed one). Blocked as described above.
- **`close()` mid-sweep is read, not run.** The per-row guard exists and returns the
  partial count, but forcing a close between two per-row reaps deterministically needs a
  seam the class does not expose.
- **Content convergence only.** Two nodes agreeing on content says nothing about their
  storage revisions reconciling — see `forked-control-collection-sync-livelocks` and
  `strand-unique-index-sync-stale-revision`. Nothing here closes the retry livelock, and
  `docs/architecture.md` now says so explicitly.
- **The sweep re-walks every tombstone every ~15 s** while connected. Fine at cadre scale;
  the empty-table early return makes a never-revoked party a single scan. `NOTE:` on
  `reapRevokedRows` — persist a node-local high-water mark if `Revocation` ever grows.
