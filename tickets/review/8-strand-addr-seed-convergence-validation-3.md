description: Continue the paused code review of a concurrency fix that lets two parts of a node safely write to its control database at the same time. Most of the reading is done; what remains is applying the small fixes found, adding the missing concurrency tests, and running lint and tests.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/test/control-membership-hub.spec.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts
difficulty: hard
----
Resumes the review of `strand-addr-seed-convergence-validation-2` (implement commits
`52bbb5c` + `7c3be3a`). The prior review run read the whole diff and both touched
source files, then hit its token budget before writing any code. **No source edits
landed — the working tree is unchanged from `7c3be3a`.** Everything below is the
prior run's verified reading; do not re-derive it.

## What the fix is (already understood — skip re-reading unless a finding needs it)

Two layers, both in cadre-core:

1. `ControlDatabase.withWriteLock<T>(fn)` — a promise-chain mutex over a `writeQueue`
   field, serializing every local write on one `ControlDatabase`. Rationale: Quereus
   tracks transaction state per `Database`, and a write's implicit transaction spans
   the awaits inside `exec`, so two interleaved local writers either trip
   `assertCommitBoundary` or silently join each other's transaction.
2. `SeedBootstrapService.insertCadrePeerRow` became idempotent — an existence check
   (`queryCadrePeerStampId`) INSIDE the locked `mutateCadrePeer('peer-insert')` body,
   returning early instead of hitting the `CadrePeer.PeerId` UNIQUE constraint.

## Verified clean (do not re-check)

- **Lock coverage is complete.** Every public write method of `ControlDatabase` runs
  under the lock: `updateSelfPeerRecord`, `updateSelfDeviceToken`, `insertOwnerKey`,
  `insertStrand`, `deleteStrand`, `insertValidationKey`, `deleteValidationKey`,
  `deleteDeviceToken`, `insertFormationInvite`, `redeemInvitation`,
  `recordFormationUsage`, `mutateCadrePeer`; `deleteCadrePeer` inherits it via
  `mutateCadrePeer`. `loadSchema`'s `exec` is the only unlocked write and runs during
  `initialize()` before any caller exists — correct.
- **No unlocked writer outside the class.** A repo-wide sweep of `getDatabase()` found
  exactly two control-DB write sites outside `ControlDatabase`, both in
  `seed-bootstrap.ts`: `insertSelfDeviceToken` (now wrapped in `withWriteLock`) and
  `insertCadrePeerRow`'s insert (already inside the `mutateCadrePeer` body). Every
  other `getDatabase()` hit is a strand database, a test, or a read.
- **Non-re-entrancy is respected.** `deleteGuardedRow`, `inTransaction`, and
  `execFormationUsageInsert` are private and bare; each is only reached from an
  already-locked public entry point.
- **The idempotency check is sound.** `CadrePeer.StampId` is `text not null unique`
  in `control-schema.ts`, so `queryCadrePeerStampId(...) !== null` is exactly
  "row exists" — it cannot false-negative on a live row.
- **`withWriteLock`'s failure tail is correct.** `writeQueue.then(fn, fn)` runs the
  next write regardless of how the prior settled, and the parked tail swallows both
  outcomes, so one failed write cannot poison the queue. Each caller still receives
  its own rejection via the returned `run`.

## Findings to act on

### Minor — fix inline in this pass

- **`close()` does not drain the write queue** (`control-database.ts`, `close()`).
  Before the lock, a write's `exec` began immediately; now `withWriteLock` can park a
  write behind others across an await, so `close()` can null `this.db` while queued
  closures (which evaluate `this.db!` when they finally run) are still pending — the
  queued write then throws a `TypeError` on a null handle instead of committing.
  Fix: `await this.writeQueue;` at the top of `close()`. The tail never rejects
  (it swallows both outcomes), so a bare await is safe. Add a `NOTE:` that this makes
  `close()` wait on a stuck write — acceptable today, revisit if a write can hang.

- **DRY: `withWriteLock(() => this.db!.exec(sql, params))` is repeated at six sites**
  (`updateSelfPeerRecord`, `updateSelfDeviceToken`, `insertOwnerKey`, `insertStrand`,
  `insertValidationKey`, `insertFormationInvite`) plus once in `seed-bootstrap.ts`
  (`insertSelfDeviceToken`). Collapse into one method on `ControlDatabase`:

  ```ts
  /** One-statement local write, serialized by {@link withWriteLock}. Prefer this over a
   *  bare `getDatabase().exec` so a new writer cannot forget the lock. */
  execWrite(sql: string, params?: SqlParameters): Promise<void> {
    return this.withWriteLock(() => this.db!.exec(sql, params));
  }
  ```

  `SqlParameters` is exported from `@quereus/quereus`
  (`Record<string, SqlValue> | SqlValue[]`). Making it public lets
  `SeedBootstrapService.insertSelfDeviceToken` drop its `getDatabase()` call
  entirely. This is the concrete mitigation for the hazard `assertCommitBoundary`'s
  own `NOTE:` names ("a new method that forgets it"). **Do not** convert the
  `insertCadrePeerRow` insert — it is already inside a locked body and would
  self-deadlock.

### Minor — missing tests, add in this pass

There is **no unit test anywhere that drives two concurrent `ControlDatabase`
writers**; the fix is validated only by the integration scenario. Add
`packages/cadre-core/test/control-write-lock.spec.ts`. Copy the harness from
`control-membership-hub.spec.ts` verbatim — it already builds an initialized
`ControlDatabase` + `SeedBootstrapService` from a real `CadreNode`, seats an owner
key, and (importantly) disarms the ~1s self-registration timer that would otherwise
land stray `CadrePeer` inserts mid-test. Cases:

- Two concurrent `insertStrand` calls with different ids — both rows land, neither
  throws. (Pre-fix this was the torn-transaction path.)
- Concurrent `insertStrand` + `authorizePeer` — no
  `assertCommitBoundary` throw. This is the original scenario failure, reduced to a
  unit test; it is the regression that matters most.
- Concurrent `authorizePeer(p)` + `insertSelfPeerRecord(signPeerRecord(p, ...))` for
  the same fresh peer — resolves without throwing, exactly one row. Assert BOTH call
  orders: `insertSelfPeerRecord` first leaves `Sig` populated;
  `authorizePeer` first leaves `Sig` null. The second assertion deliberately pins the
  known window described in the ticket below — reference that slug in the test's
  comment so a future reader knows the null is documented, not accidental.
- A rejecting `withWriteLock` body followed by a normal write — the second succeeds
  (queue not poisoned).

`signPeerRecord` and the `freshPeer()` helper both come from the membership-hub spec's
imports. Note that `insertSelfPeerRecord` does not require the peer id to be the
node's own, so a `freshPeer()` identity is enough to stage the race.

### Major — file as a new ticket, do not fix here

**Self peer row can sit unresolvable for a heartbeat when self-authorize wins the
race.** `CadreNode.publishSelfRecord` reads `queryPeerRecord(peerId)` OUTSIDE the
lock, then branches update-vs-insert. If a foreground `authorizePeer(<own peer id>)`
seats the row between that read and the insert, the insert now no-ops (layer 2) and
the row keeps `authorizePeer`'s `Sig = null` — the owner cannot produce the peer's
self-signature. The row stays unresolvable until the next periodic `registerSelf`
takes the `updateSelfPeerRecord` branch. Self-healing, but the window is the heartbeat
interval, and other nodes resolving this node's addresses in that window get a row
that fails signature verification.

Reachable today (the integration scenario calls `authorizePeer` on the founder's own
id), never observed in a run (the startup `registerSelf` timer fires ~1s in, long
before authorize in practice). The obvious fix — have `insertCadrePeerRow` report
whether it inserted and fall through to `updateSelfPeerRecord` on a lost race — is
not a one-liner: `record.updatedAt` was computed from a pre-race read, and the
`AuthorizedUpdate` self-branch requires a strictly increasing `UpdatedAt`, so the
record must be re-signed against a fresh read of the row that actually landed. That
plus test coverage makes it too big for a review pass.

File as `tickets/backlog/bug-self-peer-record-sig-null-race.md`. Write the description
in plain language: *"When a node adds itself as a member at the same moment it is
publishing its own address record, the published record can be left without the
node's signature until the next refresh, so other nodes reject it in the meantime."*

### Tripwires — record as `NOTE:` comments, do not file as tickets

- **Non-re-entrant lock fails silently and permanently.** The doc comment on
  `withWriteLock` says the lock is not re-entrant, but not what happens if someone
  breaks that: a locked body that calls another locked public method (including a
  `mutateCadrePeer` body, which takes an arbitrary caller-supplied callback) queues
  behind its own tail and hangs forever — with no error, and taking the whole write
  queue down with it, not just that call. A boolean "held" flag cannot distinguish
  re-entry from a legitimately queued concurrent writer, so there is no cheap
  fail-fast. Add the consequence to the existing `withWriteLock` doc comment.
- **`ensureOwnerKey` is check-then-act across the lock** (`hasOwnerKey()` read, then
  `insertOwnerKey`). Two concurrent calls both read false; the loser's insert fails
  the schema's genesis branch (`committed.OwnerKey` count = 0) rather than corrupting
  anything, and genesis runs once from a single caller at startup. Considered and left
  alone — mention it in `## Review findings` as checked-and-accepted, no comment needed
  unless a second genesis caller appears.

## Still to do (the prior run did none of this)

- Confirm whether `docs/cadre-consistency.md` needs a line about the local write lock.
  The prior run checked: that document is explicitly marked "Design exploration, not
  yet implemented" except for its "What Ships Today" section, which covers replication
  breadth only and says nothing about local write serialization. Judge whether the
  lock belongs in "What Ships Today" or nowhere. `docs/architecture.md` and
  `docs/STATUS.md` were NOT checked for staleness against this diff — do that.
- Read `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`.
  The prior run never opened it. Verify the no-manual-dial rule the spec calls a hard
  requirement, and that the push-wake helper copy carries its `NOTE:` pointing at
  `integration-test-harness-helper-consolidation`.
- Run `yarn lint` (repo-wide) and `yarn workspace @serfab/cadre-core test`. Both must
  pass. The implement pass reported both green at `7c3be3a` (1199 passed, 1 skipped,
  ~50 s); anything new is from this review's edits.
- Do **not** run the full integration suite (>10 min wall clock; out-of-band per the
  workflow rules). Re-running the single scenario
  (`yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts`,
  ~9–13 s) is optional — it was green three consecutive runs at `7c3be3a`.

## Carried context

- Data replication A↔B is deliberately NOT asserted by the scenario (the bootstrap-mode
  founder commits via a purely local transactor). A possible follow-up scenario; do not
  build it in this review.
- `tickets/backlog/debt-cadrepeer-writes-behind-control-database.md` already tracks
  moving the remaining `CadrePeer` SQL out of `SeedBootstrapService` and behind
  `ControlDatabase`. The `execWrite` helper above is complementary, not a substitute —
  do not fold one into the other.
- Output of this ticket is `tickets/complete/`, with a `## Review findings` section
  listing what was checked, what was found, and what was done. Empty categories are
  fine but must be stated explicitly with a reason.
