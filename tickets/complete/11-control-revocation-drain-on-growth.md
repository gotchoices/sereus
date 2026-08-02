----
description: A revocation made while a machine was offline now gets queued and re-sent to the other machines once that machine reconnects, and it survives a restart. Reviewed, three defects fixed in the review pass; the live-network proof is still blocked on two upstream defects.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, docs/architecture.md
----

# Complete: revocation tombstones drain on cohort growth

## What shipped

A guarded delete (`removePeer`, `clearDeviceToken`, `deleteStrand`,
`deleteValidationKey`) that commits while the node holds zero control connections is
local-only — it never broadcast. The row itself can never be replayed (it is gone), so
durability rides on the `Revocation` tombstone the same transaction wrote, which the
prereq ticket made re-writable via an owner-signed monotonic `ReissuedAt` bump.

- `ControlDatabase` gained a `GuardedDeleteListener` seam, notified after every
  committed guarded delete. One listener covers all four guarded tables because they
  share one implementation (`deleteGuardedRow`).
- `CadreNode.noteGuardedDelete` queues the tombstone identity in `pendingRevocations`
  (keyed by retired `StampId`) when the delete committed alone. `noteControlWrite`'s
  old `'remove'` arm is gone: `pendingPeerWrites` is `Map<string,'authorize'>` only,
  and a remove merely clears a stale queued authorize.
- `drainPendingRevocations` runs inside the 0→≥1 control-connection growth-edge drain.
  On the first growth of a node lifetime it sweeps every locally-held tombstone
  (`queryRevocations`), covering deletes from before this process started; afterwards
  it drains only the in-session queue. The sweep flag is success-gated. Re-issue goes
  through `SeedBootstrapService.reissueRevocations`, which requires the owner key so
  the write context carries the signature `Revocation.Authorized` re-checks everywhere.
- `docs/architecture.md` "Delete-while-alone durability" bullet rewritten from an open
  gap to ✅ plus its named residuals.

## Review findings

Read the five implement commits' combined diff (`049aba0..33f18fa`) before the handoff
summary, then re-read the live files. Checked: drain step ordering, sweep flag
lifecycle, per-stamp clear semantics, `noteControlWrite`'s rewritten remove arm,
monotonic `reissuedAt` derivation, listener lifecycle across `start()`/`stop()`,
owner-gating, type safety, DRY, and whether the docs match the code.

### Fixed in this pass (minor)

- **`stop()` did not reset the revocation state — a real correctness defect.**
  `stopRecordRefresh()` resets the whole write-while-alone bookkeeping so a
  `stop()`→`start()` cycle re-arms the growth edge, but the two new fields were left
  out. `reissuedHeldRevocations` stayed `true`, so the second lifetime **skipped the
  first-growth sweep entirely** — precisely the case the sweep exists for (a removal
  that committed alone before this lifetime started). The integration scenario cannot
  catch it because it constructs a fresh `CadreNode` on every restart. Both fields now
  reset alongside the others, the comment explains why the sweep flag must, and
  `cadre-node-control-replication.spec.ts` gained a regression test that drives
  `stopRecordRefresh()` between two drains and asserts the second one sweeps again.
  The `pendingRevocations` doc comment also claimed it was "not cleared on stop, like
  `pendingPeerWrites`" — `pendingPeerWrites` *is* cleared on stop; corrected.
- **Drain ordering contradicted its own stated rationale.** Step 2's comment argued
  revocations go "ahead of the `CadrePeer` re-touches" because those can livelock for
  tens of seconds after a collection fork while the tombstone lives in an unforked
  collection — but step 1 (`registerSelf`) is itself a `CadrePeer` write and ran first.
  The revocation drain is now step 1; the comment states the ordering is load-bearing,
  not cosmetic.
- **Payload type duplicated three times** (listener signature, `pendingRevocations`
  value, `noteGuardedDelete` parameter). Replaced with one exported
  `RevokedRowRef = Omit<RevocationRow, 'reissuedAt'>` in `control-database.ts`,
  re-exported from `index.ts`.

### Recorded as tripwires, not tickets

- Sweep cost. Folded into the existing `NOTE:` on `drainPendingRevocations`: it is
  O(all tombstones ever) updates **plus one ed25519 signature each** in one
  transaction, and the `Math.max(...rows.map(…))` spread hard-caps around 10^5 rows
  (V8 argument limit) before size becomes merely a latency problem. Fine while
  revocations stay rare for a cadre-sized party; if the table grows, bound the sweep
  with a persisted high-water mark.

### Checked and found sound (no action)

- Per-stamp clear (not `clear()`) after a successful re-issue: an entry queued
  concurrently mid-drain correctly survives to the next edge.
- `reissuedAt = Math.max(Date.now(), max(affected)+1)` satisfies the `ReissueOnly`
  strictly-upward CHECK for exactly the rows in the batch, including a second drain
  after a sweep already bumped them.
- Success-gated sweep flag: a throwing `reissueRevocations` leaves both the queue and
  the flag untouched, so the next growth edge retries the full sweep. Unit-tested.
- Non-owner drop is unreachable in practice (every guarded delete is owner-signed;
  `clearDeviceToken` throws without an owner service), and harmless where it is
  reachable — dropping the queue does not consume the sweep flag, so a node that
  gains its owner key later still sweeps.
- The listener fires inside `lockedWithRetry`'s body; it is synchronous and only
  writes a `Map`, so it cannot deadlock the write lock, and its throw is swallowed.
- Implement-stage review pointer #5 confirmed: `control-database-offline-peers.spec.ts`
  drives a real `node.start()`, so its assertions do exercise the listener wiring
  `start()` performs, not a hand-injected fake.
- Docs: read `docs/architecture.md` ~198, `unpublishStrand`'s doc comment, and the
  board edits the implementer made. All reflect the new reality, including the
  strand nuance (`queryStrands` reads raw, so siblings keep *running* a removed
  strand until the row deletion converges) and the two named residuals.

### Deliberately not filed

- The `GuardedDeleteListener`'s two defensive branches — the `try/catch` around the
  notify, and `setGuardedDeleteListener(null)` in `stop()` — have no direct unit test.
  Not filed: the notify's happy path and the no-op-delete case are covered end-to-end
  by the offline-peers spec against a real database, the swallowed-throw branch guards
  a synchronous `Map.set`, and the whole seam is a six-line mirror of the already-tested
  `MembershipChangeListener`. A ticket here would be over-filing.
- No new ticket for the two blocked items below; both are already tracked and neither
  is caused by this work.

## Validation

- `packages/cadre-core`: `npx vitest run test/cadre-node-control-replication.spec.ts
  test/control-database-offline-peers.spec.ts` → 2 files, **34/34 passed** (117 s;
  33 before, +1 regression test).
- Blast radius of the drain reorder: `npx vitest run test/cadre-node-control-cohort.spec.ts
  test/control-membership-hub.spec.ts test/seed-bootstrap.spec.ts` → **111/111 passed**.
- `yarn workspace @serfab/cadre-core build` exit 0; root `yarn lint` exit 0.
- The whole cadre-core suite was **not** re-run in the review pass (the implementer's
  run classified all 15 failures as pre-existing quereus v4.6.0 issues in
  `tickets/.pre-existing-known.md`). The review delta is confined to
  `runDrainControlReplication`'s ordering, two fields' reset, and a type alias; the
  specs above cover every caller of those.

## Still blocked (pre-existing, tracked)

- `control-delete-while-alone-convergence.integration.ts` (two tests) dies at ~15 s in
  Phase 1 setup — before any delete or drain code runs — on
  `tickets/blocked/control-db-cross-node-convergence-halted.md`. **The feature has no
  end-to-end network proof yet.** Once that clears:
  `cd packages/integration-tests && npx vitest run
  src/scenarios/control-delete-while-alone-convergence.integration.ts` (~40 s), then
  remove the scenario's `.pre-existing-known.md` entry.
- The DB-layer re-issue statement itself is red under quereus v4.6.0 (a false
  `UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` on a
  counter-only update) — `tickets/blocked/10-revocation-reissue-same-pk-update-unique-collision`,
  with test fixes owned by `10-control-revocation-reissue-test-fixes`. Until it clears,
  a real drain logs a ConstraintError and leaves entries queued (the unit-tested
  behavior), so unit green is the only proof of the drain logic.
- `tickets/blocked/forked-control-collection-sync-livelocks.md` is **not** closed by
  this work: the `CadrePeer` collection still forks on delete-while-alone. The
  tombstone makes the removed row inert on nodes that hold it; it does not erase it.
