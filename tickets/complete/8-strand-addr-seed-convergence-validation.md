description: Reviewed and finished a fix that lets two parts of a node write to its control database at the same time without corrupting each other, adding the concurrency tests it was missing and documenting the guarantee.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-write-lock.spec.ts, docs/architecture.md, docs/STATUS.md
difficulty: hard
----
Review of `strand-addr-seed-convergence-validation-2` (implement commits `52bbb5c` +
`7c3be3a`), completed across four review runs. The implementation added a process-local
write queue to `ControlDatabase` so a node's own components — the background self-record
publish and a foreground `authorizePeer` — can no longer interleave mid-statement on the
single Quereus database handle they share, plus an idempotent `CadrePeer` first-row insert
so the loser of that race is a no-op instead of a UNIQUE-constraint failure.

## What the completed work is

- `ControlDatabase.withWriteLock` serializes every public write method; `execWrite` is the
  one-statement shorthand, used by six writers in the class and by
  `SeedBootstrapService.insertSelfDeviceToken`. Reads stay unlocked.
- `close()` drains the queue before releasing the handle.
- `SeedBootstrapService.insertCadrePeerRow` checks for an existing row *inside* the locked
  body, so the second writer for the same peer skips rather than collides.
- New unit coverage: `packages/cadre-core/test/control-write-lock.spec.ts` (6 cases).
- New docs: `architecture.md` → *Control Network → Local write serialization*, and a
  `STATUS.md` coverage subsection.

## Review findings

### Verified clean — no action

- **Lock coverage is complete.** Every public write method of `ControlDatabase` runs under
  the lock. `loadSchema`'s `exec` is the only unlocked write and runs during
  `initialize()`, before any caller exists.
- **No unlocked control-DB writer outside the class.** Repo-wide `getDatabase()` sweep:
  every other hit is a strand database, a test, or a read.
- **Non-re-entrancy is respected.** The private bare bodies (`deleteGuardedRow`,
  `inTransaction`, `execFormationUsageInsert`) are the ones locked callers compose, and
  none of them re-takes the lock.
- **The idempotency check is sound.** `CadrePeer.StampId` is `text not null unique`, so
  the stamp read cannot false-negative on a live row.
- **`withWriteLock`'s failure tail is correct.** A failed write cannot poison the queue and
  each caller still receives its own rejection. Now pinned by a test.
- **`insertCadrePeerRow` was correctly left off `execWrite`** — its insert already runs
  inside a locked `mutateCadrePeer` body and would self-deadlock.
- **Integration scenario read in full**
  (`packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`).
  The no-manual-dial rule holds: the only `dial` is `connectControlNodes`, the documented
  test-only stand-in for control-cohort discovery on the CONTROL network. Nothing dials a
  strand node; the mesh forms from the RPC-resolved seed alone. The copied push-wake
  helpers carry the `NOTE:` pointing at
  `integration-test-harness-helper-consolidation`. No findings.

### Checked and accepted — no change

- **`ensureOwnerKey` is check-then-act across the lock** (`hasOwnerKey()` read, then
  `insertOwnerKey`). Two concurrent calls both read false; the loser's insert fails the
  schema's genesis branch rather than corrupting anything, and genesis runs once from a
  single caller at startup. Revisit only if a second genesis caller appears.
- **`docs/cadre-consistency.md` deliberately left alone.** Its one shipped-behaviour
  section is scoped to *replication breadth* and exists as the baseline the rest of that
  document proposes to improve on. Local write serialization is node-local concurrency
  control and says nothing about agreement between nodes, so documenting it there would
  blur the document's stated scope. It went into `architecture.md`'s Control Network
  section instead, with a pointer back to `cadre-consistency.md` for the cross-node half.

### Minor — fixed in this review

- `close()` now awaits the write queue. A queued closure evaluates `this.db!` only when it
  runs, so nulling the handle first threw on a null handle instead of committing.
- `execWrite` collapsed six repeated `withWriteLock(() => this.db!.exec(...))` sites and
  gave `SeedBootstrapService` a seam that does not reach for `getDatabase()`. This is also
  the concrete mitigation for the hazard `assertCommitBoundary`'s own `NOTE:` names — "a
  new method that forgets it".
- Missing concurrency coverage (see next section).

### Major — filed as a ticket

- `backlog/bug-self-peer-record-sig-null-race` — when `authorizePeer` wins the first-row
  race, the row keeps a null `Sig` and the self-publish insert is skipped as
  already-present rather than filling it in, so the row stays unresolved until a later
  self-UPDATE lands. Pinned (not fixed) by a test that names the slug.

### Tripwires parked

- **Re-entrancy consequence** — `NOTE:` on the `withWriteLock` doc comment in
  `packages/cadre-core/src/control-database.ts`: re-entry hangs silently and permanently
  and strands the whole queue, and no cheap fail-fast exists (a "held" flag cannot tell
  re-entry from a legitimately queued concurrent writer).
- **`close()` waits on a stuck write** — `NOTE:` on `close()`. Acceptable while every
  locked body is a bounded local `exec`; revisit with a bounded drain if a write can hang.

### Tests added

`packages/cadre-core/test/control-write-lock.spec.ts`, 6 cases: mutual exclusion and call
order on `withWriteLock` itself; two raced strand inserts; a bare write raced against two
transactional `CadrePeer` mutations; both orderings of the self-publish/authorize first-row
race (exactly one row, no UNIQUE violation, `Sig` present or absent per winner); a
rejecting locked body followed by a normal write.

Each case was checked against a deliberately disabled lock rather than assumed meaningful.
That surfaced something worth recording: **the row-level races pass with or without the
lock.** Quereus serializes each statement internally (`Database._withMutex`), and control
writes are fast in-memory statements, so a unit-scale race between two of them completes
the first before the second starts. Staggering by a macrotask did not help — the first
write had already finished. Only the two peer-idempotency cases and a body that spans a
timer fail with the lock removed, so the direct `withWriteLock` case is what actually pins
the contract. Both facts are recorded in `STATUS.md` so a future reader does not delete
that case as redundant.

Residual gap, stated rather than papered over: the torn-transaction interleave the lock
also prevents has no deterministic unit reproduction — it is asserted only by the
integration scenario. Recorded in `STATUS.md`; not filed as a ticket, because the
serialization contract that prevents it *is* now covered.

### Validation

- `yarn lint` (repo-wide) — clean, exit 0.
- `yarn workspace @serfab/cadre-core test` — 77 files, **1205 passed, 1 skipped**
  (1199 + 1 at `7c3be3a`, plus the 6 new cases).
- `yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts`
  — 1 passed, 12.3 s.
- Full integration suite not run (>10 min wall clock; out-of-band per the workflow rules).
- The stale-build guard tripped twice mid-review and both rebuilds were run as instructed:
  `@quereus/quereus` (the sibling repo had concurrent uncommitted edits from another run —
  its dist now matches that source) and `@serfab/cadre-core` (run 3's source edits had
  never been rebuilt).

## Carried context for whoever picks this area up next

- Data replication A↔B is deliberately not asserted by the convergence scenario — the
  bootstrap-mode founder commits via a purely local transactor. A possible follow-up
  scenario; not built here.
- `tickets/backlog/debt-cadrepeer-writes-behind-control-database.md` tracks moving the
  remaining `CadrePeer` SQL out of `SeedBootstrapService` and behind `ControlDatabase`. The
  `execWrite` helper is complementary, not a substitute — do not fold one into the other.
