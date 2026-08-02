----
description: A revocation made while a machine was offline now gets queued and re-sent to the other machines once the node reconnects, including after a restart. Review the queue/drain wiring and the honesty of the documented gaps — the end-to-end network proof is currently blocked on an upstream defect.
files: packages/cadre-core/src/cadre-node.ts (noteControlWrite, noteGuardedDelete, drainPendingRevocations, runDrainControlReplication step 2, pendingRevocations, unpublishStrand doc+log), packages/cadre-core/src/seed-bootstrap.ts (reissueRevocations wrapper), packages/cadre-core/src/control-database.ts (GuardedDeleteListener seam, reissueRevocations), packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, docs/architecture.md (~198-204), tickets/.pre-existing-known.md, tickets/blocked/control-db-cross-node-convergence-halted.md, tickets/blocked/forked-control-collection-sync-livelocks.md
difficulty: hard
----

# Review: revocation tombstones drain on cohort growth

## What shipped

`control-revocation-reissuable-tombstone` (prereq, complete) made the
`CadreControl.Revocation` row re-writable — an owner-signed, monotonic `ReissuedAt`
bump that changes no semantics but re-broadcasts the row — and made membership reads
treat a retired stamp as absent. This ticket wired the **caller** side, so a guarded
delete (`removePeer`, `clearDeviceToken`, `deleteStrand`, `deleteValidationKey`) that
commits while the node is alone actually reaches the cohort later:

- `ControlDatabase` notifies a `GuardedDeleteListener` after every committed guarded
  delete (seam added in commit 20cf4f8).
- `CadreNode.noteGuardedDelete` queues the tombstone identity
  (`{tableName, rowKey, stampId}` keyed by stamp) in `pendingRevocations` when the
  delete committed with zero control connections. `noteControlWrite`'s old `'remove'`
  arm is gone — `pendingPeerWrites` is now `Map<string, 'authorize'>` only; a remove
  clears a queued authorize and logs when alone.
- `drainPendingRevocations` runs as step 2 of `runDrainControlReplication` (the
  0→≥1 control-connection growth edge, single-flight), before
  `reconstructAuthoredMembership`. On the **first** growth after a process start it
  sweeps ALL tombstones the node holds (`queryRevocations`) — covering deletes from
  before this process started — then per-session it drains only queued entries. The
  sweep flag is success-gated; a throw leaves entries queued for the next edge.
  Re-issue goes through `SeedBootstrapService.reissueRevocations` (added), which
  requires the owner key so the write context carries the owner signature that
  `Revocation.Authorized` re-checks on every node. Non-owner nodes drop queued
  entries rather than retry forever.

## Validation done (floor, not ceiling)

- `packages/cadre-core`: `npx vitest run test/control-database-offline-peers.spec.ts
  test/cadre-node-control-replication.spec.ts` → **2 files, 33/33 green** (~122 s;
  re-run this session after final edits). Covers: queueing via the committed-delete
  seam, sweep-covers-all-exactly-once, no-re-sweep, queued-row-only second drain,
  throw-leaves-queued + sweep-retry, non-owner drop, remove-clears-queued-authorize,
  and the offline-peers spec's new contract (remove-while-alone → `pendingPeerWrites`
  entry absent, tombstone queued under the removed row's stamp).
- `yarn workspace @serfab/cadre-core build` exit 0; root `yarn lint` exit 0.
- Whole cadre-core suite (run 3): 15 failed / 1357 passed — ALL 15 classified: 8 were
  the old-contract offline-peers assertions (fixed in run 4), the rest are
  pre-existing quereus-v4.6.0 failures tracked in `tickets/.pre-existing-known.md`
  (see gaps below). Not re-run whole-suite this session; the delta since is
  comment/log/board edits only.

## Honest gaps — what a reviewer should probe

1. **The feature is UNPROVEN end-to-end.** The integration scenario
   `control-delete-while-alone-convergence.integration.ts` (two tests: reconnect
   convergence; restart durability of the first-growth sweep) was written to spec,
   but **both tests die at ~15 s in Phase 1 setup** (authorize X / converge to B —
   before any delete or drain code runs) with the
   `control-db-cross-node-convergence-halted` fingerprint
   (`SyncRetryExhaustedError … default/CadrePeer at rev 3 (resp. 4), requested rev 1`,
   upstream optimystic). Listed in `.pre-existing-known.md`; the scenario currently
   proves nothing about this feature either way. Do not skip/loosen it.
2. **The re-issue's DB layer may be broken under quereus v4.6.0.** The
   counter-only `update Revocation … set ReissuedAt = ?` dies with a false
   `UNIQUE constraint failed: Revocation.TableName, Revocation.StampId`
   (blocked: `10-revocation-reissue-same-pk-update-unique-collision`; spec fixes in
   implement: `10-control-revocation-reissue-test-fixes`). Until that clears, a real
   drain would log a ConstraintError and leave entries queued (unit-tested behavior).
   So the whole path is gated on TWO upstream/blocked items, and unit green is the
   only proof of the drain logic itself.
3. **DeviceToken question (from the ticket) — answered, verified this session:**
   nothing clears a `DeviceToken` without an owner signature. `clearDeviceToken`
   throws when no owner service is available (the delete is gated by
   `DeviceToken.AuthorizedInsert`, which covers insert AND delete); a non-owner
   `expireDeviceToken` only logs. Every DeviceToken tombstone is therefore
   owner-re-issuable.
4. **Residuals deliberately NOT closed** (documented in `docs/architecture.md`
   ~198-204, rewritten this session): the removed row is not physically deleted on
   nodes that already held it (rendered inert by the tombstone); clearing the queue
   on re-issue is not proof of broadcast
   (`tickets/backlog/control-rereplication-broadcast-confirmation`); the `CadrePeer`
   collection itself still forks on delete-while-alone —
   `tickets/blocked/forked-control-collection-sync-livelocks` is NOT closed, and its
   formerly-wrong "Alternative unblock" section was corrected this session (only
   unblock is upstream).
5. **Strand-specific nuance found while reconciling docs:** `queryStrands` reads raw
   (no retired-stamp filter — retirement guards the consent re-seat on INSERT), so a
   strand removal committed alone re-propagates its tombstone but siblings keep
   *running* the strand until the row deletion itself converges. Documented at
   `unpublishStrand`'s doc comment + alone-log (both updated); same residual class as
   item 4, no new ticket filed.

## Review pointers (where bugs would hide)

- Drain ordering: step 2 placement before `reconstructAuthoredMembership` in
  `runDrainControlReplication`, and the rationale comment there.
- Sweep flag success-gating vs. partial failure (some rows re-issued, one throws).
- Per-stamp clear semantics: entry cleared only after its own re-issue succeeds.
- `noteControlWrite`'s remove arm: clearing a queued authorize must not drop a
  needed re-issue (the tombstone queue is separate and keyed by stamp).
- The offline-peers spec boots its node the injected way — confirm its drive/assert
  path really exercises the listener wiring `start()` performs.

## Board/docs changes this session (run 5)

- Deleted `zz-scratch-delete-alone.integration.ts` (scratch experiment, replaced by
  the real scenario per its owning ticket's disposition).
- `.pre-existing-known.md`: new-scenario entry added under
  `control-db-cross-node-convergence-halted`; zz-scratch line + paragraph removed.
- `control-db-cross-node-convergence-halted.md`: scenario added to `files:` + failing
  table; stale zz-scratch/plan-ticket references fixed.
- `forked-control-collection-sync-livelocks.md`: "Alternative unblock" corrected
  (shipped work does NOT remove the fork), scenario references repointed, `files:`
  fixed.
- `strand-unique-index-sync-stale-revision.md` + scenario comment in
  `strand-unpublish-sibling-convergence.integration.ts`: stale plan-ticket references
  fixed.
- `docs/architecture.md` ~198-204: intro line + delete-while-alone bullet rewritten
  to ✅ with the residuals above.
- `cadre-node.ts` `unpublishStrand`: doc comment + alone-log updated (item 5).

## How to validate once unblocked

- Upstream convergence fix lands → `cd packages/integration-tests && npx vitest run
  src/scenarios/control-delete-while-alone-convergence.integration.ts` (~40 s;
  forward-slash path filter; `../quereus`/`../optimystic` may need `yarn build`
  first). Both tests must pass; remove the scenario's `.pre-existing-known.md` entry.
- Quereus UNIQUE-collision triage lands → `control-revocation-reissue.spec.ts` /
  `control-revocation-replay.spec.ts` go green (owned by
  `10-control-revocation-reissue-test-fixes`).
