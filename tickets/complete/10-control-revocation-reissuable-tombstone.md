----
description: A node can now re-broadcast a member-removal it recorded while offline or alone, so the removal reaches the rest of the group once other machines come back — and a removed member no longer leaks out through the bootstrap bundle handed to new joiners.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-revocation-reissue.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/membership-gate-helpers.ts, docs/architecture.md, docs/STATUS.md
----

# Re-issuable revocation tombstones — shipped

## What landed

When an owner removes a member, the removal is recorded as a **tombstone** row in
`CadreControl.Revocation`. A tombstone that commits while the node is alone commits locally and
is never broadcast, so every other machine still believes the removed member is a member. A
delete cannot be replayed later (the row is already gone locally), so the tombstone is the only
half of the removal that can still carry it to the rest of the party.

The fix gives the tombstone one legal thing to change: a `ReissuedAt` counter an owner can bump
with a fresh signature. Bumping it is a write, and a write replicates, so the stranded tombstone
reaches the cohort on the next growth edge. The counter carries no meaning — retirement is
decided by the tombstone's *existence*, never by its value.

Four constraints keep that seam honest, each pinned by name in the tests:

- `NoDelete` — retirement is permanent; not even an owner may withdraw a tombstone.
- `FreshTombstone` — every tombstone seats at counter 0, so an owner cannot pre-seat a saturated
  counter and freeze its own later re-issues.
- `ReissueOnly` — an update may move the counter and nothing else, upward only. The identity
  clause is what stops an "update" being a way to re-point a tombstone at a different row.
- `AuthorizedReissue` — an owner signs a `reissue`-tagged digest over
  `(TableName, RowKey, StampId, ReissuedAt)`. A distinct action tag from the insert-side
  `remove`, so neither signature replays as the other.

Write path: `ControlDatabase.reissueRevocations` signs each row outside the lock (a retry must
re-present the exact bytes, never re-mint), then one UPDATE per row in a single transaction; any
constraint refusal rolls the whole batch back and propagates.
Drain: `CadreNode.drainPendingRevocations` sweeps every locally-held tombstone on the first
successful pass per process (the only cover for a removal made before this process started), and
only in-session queued ones thereafter.

Alongside the write side, the **revocation filter moved into the database read layer**:
`ControlDatabase.queryCadrePeers` and `queryPeerRecord` drop rows whose `StampId` is retired
before any caller sees them, so every membership reader inherits the exclusion instead of each
re-implementing it. `queryCadrePeerStampId` and `queryRevocations` stay deliberately raw — the
delete and insert-if-absent write guards need to see a physically present row, and the drain
enumerates the tombstones themselves.

## Review findings

### Fixed in this pass (minor)

- **The seed bundle still carried removed members.** `SeedBootstrapService.queryPeers` read
  `CadrePeer` with a raw `select`, so it never inherited the relocated filter. Seeds are an
  *address* surface — `applySeed` writes every seed peer's addresses into the joiner's libp2p
  peerstore and dials the owner-flagged ones — so a removed member's addresses were being handed
  to every new joiner, directly contradicting the invariant this ticket's own tests assert ("a
  revoked peer must not be dialed, RPC'd, or handed out as an address"). Now reads through
  `queryCadrePeers`. This was exactly the hole the implement handoff predicted; it was the only
  one. Covered by a new unit case in `seed-bootstrap.spec.ts` (whose fake control DB was switched
  from a raw-`eval` stub to the real reader's surface, so it can no longer hand `queryPeers` a row
  the database would never return) and by two assertions on the real-database
  authorize → remove → re-admit test in `control-revocation-reissue.spec.ts`.
- **Two self-publish skip messages became misleading.** Because `queryPeerRecord` now filters, a
  node that has been revoked reads *its own* row as absent, and `CadreNode.publishSelfRecord`
  reported that as "not yet a CadrePeer member" or "own CadrePeer row vanished mid-publish" — both
  describing a race, when the truth is a permanent steady state that repeats every heartbeat.
  Traced the path to confirm it is safe and not just noisy: `insertCadrePeer`'s in-lock existence
  check reads raw, sees the physically present row, and no-ops, so nothing throws and nothing
  attempts an INSERT the `NotRevoked` check would refuse. Reworded both logs and commented the
  cause.
- **Stale references to the filter's old home.** `schemas/control.qsql` and its
  `control-schema.ts` mirror (the `Strand.NotRevoked` note) still named
  `CadreNode.listAuthorizedMembers` as the read-side mitigation; `docs/architecture.md` did the
  same in two places. Both corrected to `ControlDatabase.queryCadrePeers`, and architecture.md now
  also names the seed bundle as one of the surfaces that inherits the exclusion and says why
  `queryCadrePeerStampId` stays raw.
- **`docs/STATUS.md`'s release-readiness table** still showed `packages/cadre-core` at 5 failures
  behind `blocked/10-revocation-reissue-same-pk-update-unique-collision`, which has since been
  resolved and moved to `complete/`. The table is an explicitly dated snapshot, so rather than
  rewrite one row out from under the others, a dated correction note was added above it with the
  re-measured number. The other rows were not re-run and are left as of their original date.

### Appended to existing tickets (evidence, not new tickets)

- `backlog/bug-control-reads-not-retried-on-transient-failure` — the membership read's exposure
  doubled and nobody widened the ticket for it. `queryCadrePeers` used to be one unretried network
  read; it now issues the retired-stamp query *and* the peer scan, and both must succeed. Same for
  `queryPeerRecord`. The fix that ticket asks for is unchanged; only the hop count went up.
- `backlog/debt-cadre-node-single-file-size` — re-measured
  `wc -l packages/cadre-core/src/cadre-node.ts` → **5104**, up from the 4770 recorded there on
  2026-08-13. The revocation queue and drain arrived as four more methods on the same class.

### Tripwires recorded, not filed

- **Test fakes hand-mirror a production invariant.** Two files
  (`test/membership-gate-helpers.ts` and `test/cadre-node-authorized-surface.spec.ts`) reimplement
  `queryCadrePeers`'s filter inside a fake control database, and nothing enforces that the copies
  stay true — if the real filter changes shape, three gate suites keep passing against a contract
  the database no longer honours. Fine while the filter is one `Set.has` on `StampId`. Parked as a
  `NOTE:` at `queryCadrePeers` in `control-database.ts`, which is where a future editor of the
  filter will meet it.
- The sweep's cost (one UPDATE plus one owner signature per tombstone ever written, in one
  transaction, once per process) and the `Math.max(...)` spread's argument ceiling were already
  recorded as a `NOTE:` at `drainPendingRevocations` by the implementer, along with the fix (a
  persisted high-water mark). Left as written — the magnitude is still unmeasured and saying so is
  the honest state.
- The second query `queryCadrePeers` now runs per call is likewise already `NOTE:`d at its site.

### Checked and found clean

- **Point-lookup avoidance held.** Nothing in the diff added `TableName` to the `where` clause of
  `reissueRevocations` or the reissue/replay probes; all still key on `StampId` alone, with the
  comment explaining why intact.
- **No queue leak in the drain.** A stamp queued by `noteGuardedDelete` is always visible to
  `queryRevocations` — the listener fires only after the delete has *committed*, and `NoDelete`
  forbids a tombstone ever going away — so the per-stamp clear can never strand an entry. The
  sweep flag is set only after a successful pass, and a failure leaves both flag and queue for the
  next growth edge.
- **The constraint set has no hole I could find.** A captured `reissue` signature is replayable by
  a non-owner in principle (the context pair is supplied by the writer), but only at a counter
  value `ReissueOnly`'s strict monotonicity already refuses, and the counter carries no semantics
  either way. The digest-encoding pairing (TypeScript signs `String(reissuedAt)`, SQL digests
  `cast(new.ReissuedAt as text)`) is pinned end-to-end by the happy-path accept test, which would
  fail if the two encodings ever diverged.
- **Every other membership read routes through the filter.** `listMembers`, `isMember`,
  `listAuthorizedMembers`, the connection and stream gates, address resolution, push fan-out, and
  the `cadre-cli` admin server and `cadre-host` trust circle all read via `queryCadrePeers` /
  `queryPeerRecord`; `resolveDeviceToken` filters its own table through
  `queryRevokedStamps('DeviceToken')`. After the seed fix, the only raw `CadrePeer` reads left in
  `src/` are the two documented write-guard exceptions.
- `Strand` and `ValidationKey` still have no retired-stamp read filter. That is pre-existing and
  deliberate — the schema comment says why (neither has a per-request authorization surface) — and
  is not a regression from this diff.
- **No size ticket filed for `control-database.ts`** (2398 lines, `wc -l`). It is large, but it is
  one cohesive database facade rather than a catch-all, no open ticket claims it as a size
  problem, and a line count on its own is not evidence that it should be split.

### Major findings: none

No correctness, security, or data-integrity defect in the write path, the constraint set, or the
drain survived scrutiny — so no `fix/` or `plan/` ticket was opened. The one real defect found
(the seed bundle) was a single-site omission fixed inline, not a class needing an invariant.

### Known coverage boundary, deliberately not ticketed

Two owner devices sweeping concurrently is still not exercised with genuinely concurrent writers.
Not filed, because the ladder tops out below a ticket: `ReissueOnly` already makes the bad state
unrepresentable, the batch rollback on a stale counter *is* asserted, and the loser's recovery is
mechanical — counters derive from `Date.now()`, which strictly advances, so its next growth edge
succeeds. There is no invariant left to add and no instance to chase.

## Validation (2026-08-18, this pass)

From `packages/cadre-core`:

- `yarn test` → **100 files, 1553 passed, 1 skipped, 0 failed** (1552 before this pass, +1 for the
  new seed exclusion case)
- `yarn typecheck` → exit 0
- `yarn build` → exit 0

Downstream consumers of the changed seed path, after rebuilding `cadre-core`:

- `packages/cadre-cli` → 210 passed, 0 failed
- `packages/cadre-host` → 601 passed, 4 skipped, 0 failed

From the repo root: `yarn lint packages/cadre-core` → exit 0.

The one skip in `cadre-core` is `key-store.spec.ts`'s POSIX file-permission case, gated
`skipIf(platform === 'win32')` by pre-existing design. Nothing in this feature is skipped,
`todo`-marked, or has loosened assertions. No pre-existing failure surfaced, so
`tickets/.pre-existing-error.md` was not written.

The integration suite was **not** run. It belongs to `control-revocation-drain-on-growth` (already
in `complete/`) and several of its scenarios are red upstream for reasons recorded in
`tickets/.pre-existing-known.md`. So the end-to-end claim — a removal made while alone actually
reaches a peer that connects later — remains unproven at the network level; everything asserted
here is unit-level. That gap is inherited, not introduced.

Also inherited knowingly: a successful `reissueRevocations` exec proves the local commit landed,
not that it was broadcast — the connection that fired the growth edge may not be in the affected
block's cluster. Tracked as `backlog/control-rereplication-broadcast-confirmation`; a full
disconnect/reconnect, or the next process's sweep, re-covers it.

## History

The original spec ticket was deleted as it moved through the pipeline; read it from git history at
commits `d1aac1c`, `a0b0f82`, `4d470e1`. The reissue tests initially failed with a false
`UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` on a counter-only UPDATE that
never touched the primary key — a real upstream storage-engine defect, filed and resolved as
`10-revocation-reissue-same-pk-update-unique-collision`, cleared by the `@optimystic/*` 0.24 /
`@quereus/quereus` ^4.14 dependency wave. Several comments in the specs are shaped by that history.
