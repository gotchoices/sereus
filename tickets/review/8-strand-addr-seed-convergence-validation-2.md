----
description: Review the concurrency fix that lets two parts of a node safely write to its control database at the same time, validated by a new two-node network test where a second node joins a founder's strand using only an RPC-fetched seed.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts
difficulty: hard
----
Final stage of the strand-addr seed convergence work (scenario built in
`strand-addr-seed-convergence-scenario`, executed/fixed across
`strand-addr-seed-convergence-validation` and `...-validation-2`). The scenario
run exposed a real cadre-core concurrency bug; the fix is now complete and all
suites are green. This ticket is the adversarial review pass over that fix.

## The bug (two symptoms, one race)

A founder node with a STABLE identity (same Ed25519 key = node identity + owner
signing key) has two independent writers of its own `CadreControl.CadrePeer`
row that can run concurrently when the first control connection opens:

1. Background: the 0→≥1 control-connection growth edge fires
   `CadreNode.drainPendingControlReplication` → `registerSelf()` →
   `SeedBootstrapService.insertSelfPeerRecord` (owner-signed CadrePeer INSERT).
2. Foreground: the application (here, the test) calls
   `CadreNode.authorizePeer(<own peer id>)` → `SeedBootstrapService.authorizePeer`
   (another CadrePeer INSERT for the same PeerId).

Quereus tracks transaction state per `Database` (`getAutocommit()`), and a
write's implicit transaction spans awaits inside `exec`. Two interleaved local
writers therefore either trip `ControlDatabase.assertCommitBoundary` (symptom 1,
the original scenario failure: "a transaction is open on entry to the mutation
body") or, once serialized, the losing insert hits the `CadrePeer.PeerId` UNIQUE
constraint (symptom 2, observed after the lock landed). Both are latent
production failures for any stable-identity owner authorizing a peer near its
first control connection — not test bugs.

## The fix (two layers — the main review surface)

**Layer 1 — database-wide local-write mutex** (`control-database.ts`):

- `ControlDatabase.withWriteLock<T>(fn)` — promise-chain mutex (`writeQueue`
  field). Failure-proof tail: a rejected write never poisons the queue.
- Every public write method runs its statement(s) under it:
  `mutateCadrePeer` (entry assert, body, return assert, membership notify — all
  inside the lock), `updateSelfPeerRecord`, `updateSelfDeviceToken`,
  `insertOwnerKey`, `insertStrand`, `insertValidationKey`,
  `insertFormationInvite`, `redeemInvitation`, `recordFormationUsage`,
  `deleteStrand`, `deleteValidationKey`, `deleteDeviceToken`
  (`deleteCadrePeer` is covered via `mutateCadrePeer`).
- `SeedBootstrapService` wraps its one direct control-DB write outside any
  wrapper (`insertSelfDeviceToken`'s `db.exec`) in
  `controlDatabase.withWriteLock(...)`; its CadrePeer writes were already inside
  `mutateCadrePeer` bodies.
- **Invariants to verify in review:**
  - The lock is NOT re-entrant. Private bodies (`deleteGuardedRow`,
    `inTransaction`, `execFormationUsageInsert`) stay BARE because they only run
    inside already-locked public entry points — locking them would
    self-deadlock. Doc comments on both state this.
  - Reads are deliberately unlocked (they take no transaction); the membership
    listener notified inside `mutateCadrePeer`'s locked region only READS — a
    listener that wrote through a locked method would deadlock.
  - `assertCommitBoundary` remains as the tripwire for a future writer that
    bypasses the lock (its NOTE says exactly this).
  - Pre-write reads stay outside the lock (`canonicalDatetime`,
    `nextUseNumber`, stamp reads). Pre-existing documented caveat unchanged:
    concurrent redemptions of the SAME token must serialize at the caller
    (UseNumber is read-then-insert).

**Layer 2 — idempotent CadrePeer insert** (`seed-bootstrap.ts`
`insertCadrePeerRow`): the lock only serializes the two legitimate first-row
writers; the loser then needs to not throw. The existence check
(`queryCadrePeerStampId`) runs INSIDE the locked `mutateCadrePeer('peer-insert')`
body — so it sees the winner's committed row; a pre-lock check would re-open
the read-then-insert window — and no-ops, leaving the existing row (voucher,
addresses, self-`Sig`) untouched. Re-touching a live row remains
`reauthorizePeer`'s job. Both `authorizePeer` and `insertSelfPeerRecord` share
this body, so both directions of the race are covered.

**Review this edge:** if foreground `authorizePeer(self)` WINS the race, the
self row is seated with `Sig = null` (owner can't produce the peer's
self-signature) and `registerSelf`'s losing insert no-ops — the row stays
unresolvable until the next periodic `registerSelf` refresh takes the
`updateSelfPeerRecord` branch and adds the `Sig`. Self-healing, but the window
is the heartbeat interval. Not observed in any scenario run (the startup
registerSelf timer fires ~1s in, long before authorize in practice). Judge
whether that window deserves hardening or a tripwire note.

## Validation state (all post-fix, this machine, 2026-07-30)

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn lint` — clean (repo-wide).
- `yarn workspace @serfab/cadre-core test` — GREEN twice (before and after the
  seed-bootstrap idempotency edit): 76 files, 1199 passed, 1 skipped, ~50 s.
  No unit test depended on concurrent-write interleaving.
- Scenario `yarn workspace @serfab/integration-tests test
  src/scenarios/strand-addr-seed-convergence.integration.ts` — GREEN three
  consecutive runs; test body 1.8 s / 2.9 s / 2.9 s (suite wall ~9–13 s).
  Auto-dial convergence was stable across all three runs — no manual dial
  anywhere in the scenario (hard rule from the spec, upheld). The predicted
  next failure points (empty RPC seed, auto-dial convergence timeout) never
  materialized once the race was fixed.
- Full integration suite NOT run inline (>10 min; out-of-band/CI per the
  workflow rules).

## Carried context for the reviewer

- Data replication A↔B is deliberately NOT asserted by the scenario: the
  bootstrap-mode founder commits via a purely local transactor, so a
  data-convergence assertion needs both nodes networked — a possible follow-up
  scenario; do not build it in this review.
- Push-wake harness helpers were copied into this scenario, not shared —
  already tracked in `integration-test-harness-helper-consolidation`, with a
  `NOTE:` at the copy site.
- Phase 1 of the original plan (observable `StrandInstance.mode`) landed two
  commits back; its unit-spec stub updates were mechanical.
- Reviewer stance: the implement pass's tests are a floor. Obvious probe
  candidates: a unit test driving two concurrent `ControlDatabase` writers
  (none exists — the fix is validated only by the integration scenario), and
  the sig-null edge above.
