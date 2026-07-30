description: Finish the paused code review of a concurrency fix that lets two parts of a node safely write to its control database at the same time. The code fixes are applied; what remains is adding the missing concurrency tests, a docs staleness check, and running lint and tests.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-membership-hub.spec.ts, docs/architecture.md, docs/STATUS.md, docs/cadre-consistency.md
difficulty: hard
----
Third continuation of the review of `strand-addr-seed-convergence-validation-2`
(implement commits `52bbb5c` + `7c3be3a`). The reading pass is long done; run 3 applied
the code fixes and then hit its budget before tests, docs, or validation.
**Do not re-read the diff or re-derive the analysis** — everything verified is recorded
in `tickets/complete/`-bound notes below and in the two prior tickets' history.

## Already done — do NOT redo

Landed in the working tree by run 3 (uncommitted at handoff, runner commits it):

- **`close()` now drains the write queue.** `await this.writeQueue;` at the top of
  `ControlDatabase.close()`, with a doc block explaining why (a queued closure
  evaluates `this.db!` only when it runs, so nulling the handle first would throw on a
  null handle) and a `NOTE:` that this makes `close()` wait on a stuck write.
- **`ControlDatabase.execWrite(sql, params)` added** next to `withWriteLock` — one
  locked single-statement write. The six repeated
  `withWriteLock(() => this.db!.exec(...))` sites (`updateSelfPeerRecord`,
  `updateSelfDeviceToken`, `insertOwnerKey`, `insertStrand`, `insertValidationKey`,
  `insertFormationInvite`) now call it, and `SeedBootstrapService.insertSelfDeviceToken`
  calls `controlDatabase.execWrite(...)` instead of reaching for `getDatabase()`.
  `SqlParameters` is imported as a type from `@quereus/quereus`.
- **Re-entrancy tripwire recorded** as a `NOTE:` on the `withWriteLock` doc comment:
  re-entry hangs silently and permanently and strands the whole queue; no cheap
  fail-fast exists.
- **Major finding filed** as `tickets/backlog/bug-self-peer-record-sig-null-race.md`
  (self peer row can keep a null `Sig` for a heartbeat when a self-authorize wins the
  race against the self-publish insert).
- **Integration scenario read and verified** —
  `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`.
  The no-manual-dial rule holds: the only `dial` is `connectControlNodes`, the
  documented test-only stand-in for control-cohort discovery on the CONTROL network;
  nothing dials a strand node, and the mesh forms from the RPC-resolved seed alone. The
  copied push-wake helpers carry the `NOTE:` pointing at
  `integration-test-harness-helper-consolidation`. No findings.

`insertCadrePeerRow`'s insert was deliberately NOT converted to `execWrite` — it is
already inside a locked `mutateCadrePeer` body and would self-deadlock.

## Remaining work

### Add the missing concurrency tests

There is still **no unit test anywhere that drives two concurrent `ControlDatabase`
writers**; the fix is validated only by the integration scenario. Add
`packages/cadre-core/test/control-write-lock.spec.ts`. Copy the harness from
`control-membership-hub.spec.ts` verbatim — it already builds an initialized
`ControlDatabase` + `SeedBootstrapService` from a real `CadreNode`, seats an owner key,
and (importantly) disarms the ~1s self-registration timer that would otherwise land
stray `CadrePeer` inserts mid-test. `signPeerRecord` and the `freshPeer()` helper come
from that spec's imports. `insertSelfPeerRecord` does not require the peer id to be the
node's own, so a `freshPeer()` identity is enough to stage the race. Cases:

- Two concurrent `insertStrand` calls with different ids — both rows land, neither
  throws. (Pre-fix this was the torn-transaction path.)
- Concurrent `insertStrand` + `authorizePeer` — no `assertCommitBoundary` throw. This is
  the original scenario failure reduced to a unit test; the regression that matters most.
- Concurrent `authorizePeer(p)` + `insertSelfPeerRecord(signPeerRecord(p, ...))` for the
  same fresh peer — resolves without throwing, exactly one row. Assert BOTH call orders:
  `insertSelfPeerRecord` first leaves `Sig` populated; `authorizePeer` first leaves `Sig`
  null. The second assertion deliberately pins the known window filed as
  `bug-self-peer-record-sig-null-race` — reference that slug in the test's comment so a
  future reader knows the null is documented, not accidental.
- A rejecting `withWriteLock` body followed by a normal write — the second succeeds
  (queue not poisoned).

### Docs staleness pass

- `docs/cadre-consistency.md` — already checked by an earlier run: the document is
  explicitly marked "Design exploration, not yet implemented" except its "What Ships
  Today" section, which covers replication breadth only and says nothing about local
  write serialization. Judge whether the local write lock belongs in "What Ships Today"
  or nowhere, and act on that judgement.
- `docs/architecture.md` and `docs/STATUS.md` — NEVER checked against this diff. Read
  the control-database / cadre-core sections and confirm they reflect the write lock and
  the idempotent `CadrePeer` insert.

### Validate

- `yarn lint` (repo-wide) and `yarn workspace @serfab/cadre-core test`. **Neither has
  been run since the run-3 edits** — the `execWrite` refactor, the `close()` drain, and
  the doc-comment change are all unvalidated. The implement pass reported both green at
  `7c3be3a` (1199 passed, 1 skipped, ~50 s); anything new is from the review's edits.
  Stream output with `tee` (idle-timeout rule).
- Do **not** run the full integration suite (>10 min wall clock; out-of-band per the
  workflow rules). Re-running the single scenario
  (`yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts`,
  ~9–13 s) is optional — it was green three consecutive runs at `7c3be3a`.

## Findings the completion ticket must record

Carry these into the `## Review findings` section of the `tickets/complete/` output,
along with whatever this run finds:

- **Verified clean, no action:** lock coverage is complete (every public write method of
  `ControlDatabase` runs under the lock; `loadSchema`'s `exec` is the only unlocked write
  and runs during `initialize()` before any caller exists); no unlocked control-DB writer
  exists outside the class (repo-wide `getDatabase()` sweep — every other hit is a strand
  database, a test, or a read); non-re-entrancy is respected by the private bare bodies
  (`deleteGuardedRow`, `inTransaction`, `execFormationUsageInsert`); the idempotency check
  is sound (`CadrePeer.StampId` is `text not null unique`, so the stamp read cannot
  false-negative on a live row); `withWriteLock`'s failure tail is correct (a failed write
  cannot poison the queue, and each caller still gets its own rejection).
- **Checked and accepted, no change:** `ensureOwnerKey` is check-then-act across the lock
  (`hasOwnerKey()` read, then `insertOwnerKey`). Two concurrent calls both read false; the
  loser's insert fails the schema's genesis branch rather than corrupting anything, and
  genesis runs once from a single caller at startup. Revisit only if a second genesis
  caller appears.
- **Minor, fixed inline:** `close()` write-queue drain; `execWrite` DRY collapse (also the
  concrete mitigation for the hazard `assertCommitBoundary`'s own `NOTE:` names — "a new
  method that forgets it").
- **Major, filed:** `backlog/bug-self-peer-record-sig-null-race`.
- **Tripwires parked:** re-entrancy consequence, as a `NOTE:` on the `withWriteLock` doc
  comment in `packages/cadre-core/src/control-database.ts`.
- **Integration scenario:** read, no findings (see "Already done" above).

## Carried context

- Data replication A↔B is deliberately NOT asserted by the scenario (the bootstrap-mode
  founder commits via a purely local transactor). A possible follow-up scenario; do not
  build it in this review.
- `tickets/backlog/debt-cadrepeer-writes-behind-control-database.md` already tracks moving
  the remaining `CadrePeer` SQL out of `SeedBootstrapService` and behind
  `ControlDatabase`. The new `execWrite` helper is complementary, not a substitute — do
  not fold one into the other.
- Output of this ticket is `tickets/complete/`, with the `## Review findings` section
  above. Empty categories are fine but must be stated explicitly with a reason.
