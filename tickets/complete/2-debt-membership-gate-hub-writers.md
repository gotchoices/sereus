description: Adding or removing a party member only updates the security check that admits that member's traffic if the code doing the write remembers to say "membership changed". This first half added the single notification point every member-row write now passes through, so the reminder can no longer be forgotten.
prereq:
files:
  - packages/cadre-core/src/control-database.ts (`membershipListener` field, `setMembershipChangeListener` / `mutateCadrePeer` / `assertCommitBoundary` / `notifyMembershipChanged`, now-public `inTransaction`, `updateSelfPeerRecord` carve-out comment)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow`, `removePeer`, `reauthorizePeer` wrapped; `removePeer` + `deleteDeviceToken` now reuse `inTransaction`)
  - packages/cadre-core/src/index.ts (re-exports `type MembershipChangeListener`)
  - packages/cadre-core/test/control-membership-hub.spec.ts (new — the seam's contract)
difficulty: medium
----

# Complete: the membership-change hub on `ControlDatabase` + its three writers

Phase 1 of 2. Still **inert by design**: nothing attaches a listener, so runtime behaviour
is unchanged. Phase 2 (`debt-membership-gate-coalescing-refresh`, in `implement/`) attaches
`CadreNode` and is where the user-visible fix lands.

## What the problem was

Each node holds an in-memory list of the peers it believes are approved party members
(`CadreNode.authorizedControlPeers`). A fail-closed check
(`CadreNode.authorizeInboundControlStream`) consults that list on every inbound control-
database stream. The check must be synchronous — answering it with a database read would
pull blocks over the very protocols it gates, deadlocking into mutual denial — so the list
is a snapshot rebuilt out of band.

Before this change the rebuild was bolted onto seven `CadreNode` methods plus a ~15 s timer.
Code that wrote a member row without going through one of those methods left the snapshot
stale, and the node denied the traffic of the member it had just approved for up to ~15 s —
long enough to kill that member's database startup. Missed twice already (an integration-test
helper; `CadreNode.addPhoneWithRelay`).

## What landed

### `ControlDatabase` — the hub (src/control-database.ts)

Grouped after `inTransaction`, the other write-plumbing helper:

- `private membershipListener: MembershipChangeListener | null = null`.
- `setMembershipChangeListener(listener | null)` — public, single-slot (a second call
  replaces, never fans out, so a torn-down node cannot keep receiving notifications).
- `async mutateCadrePeer<T>(reason, body)` — `ensureInitialized()`, assert commit boundary,
  run `body`, assert commit boundary again, notify, return `body`'s result. A throwing
  `body` propagates and does not notify.
- `private assertCommitBoundary(reason, where)` — throws unless `Database.getAutocommit()`
  is true, at both ends of the body. Added during review; see findings.
- `private notifyMembershipChanged(reason)` — no-op when the listener is null; a throwing
  listener is logged and swallowed.

`inTransaction` became public so `SeedBootstrapService` stops re-deriving the
begin/commit/rollback shape (findings).

`updateSelfPeerRecord` is the one deliberate non-notifier: self-only row, filtered out of
the snapshot by `listAuthorizedMembers`, and it runs on a periodic refresh where a notify
would be a recurring read for nothing. Its doc now also explains why the *insert*
counterpart notifying is not an inconsistency.

### `SeedBootstrapService` — the three writers (src/seed-bootstrap.ts)

Bodies wrapped, not restructured:

- `insertCadrePeerRow` → `mutateCadrePeer('peer-insert', …)`. Signing and stamp minting stay
  outside the wrapper (they can fail before anything is written); only the `exec` is inside.
- `removePeer` → `mutateCadrePeer('peer-remove', () => inTransaction('removePeer', …))`, so
  the notify lands strictly after `commit()`.
- `reauthorizePeer` → `mutateCadrePeer('peer-reauthorize', …)`. An UPDATE, but it rewrites
  `VouchOwner`/`VouchSig`, which the authorized-membership predicate judges on, so it can
  change the set.

These three plus `updateSelfPeerRecord` remain the only `CadrePeer` row mutators in `src/`
repo-wide (re-verified by grep for insert/update/delete against the table).

## Validation

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core test` — **70 files, 1067 passed, 1 skipped, exit 0**
  (was 69 files / 1057 passed; +1 file, +10 tests from this review). The 1 skip is
  pre-existing and untouched.
- `yarn lint` (repo root) — clean.
- `yarn typecheck` (all workspaces) — clean.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## Review findings

Read the implement diff (`da67175`) before the handoff summary, then the current state of
every file it touched plus the ones it should have: `control-database.ts`,
`seed-bootstrap.ts`, `index.ts`, `strand-membership-writer.ts` (the other transaction
helper), `cadre-node.ts` (`registerSelf` / `publishSelfRecord` / `authorizePeer` /
`removePeer` / `refreshMembershipGate`), `docs/architecture.md` L340–341,
`docs/STATUS.md` L819–826, and the phase-2 ticket.

### Fixed in this pass (minor)

- **A doc comment asserted something false, and it was load-bearing.** `mutateCadrePeer`'s
  `NOTE:` claimed the commit-before-notify contract "cannot be enforced — Quereus' `Database`
  exposes no public 'am I in a transaction?' probe". It does: `getAutocommit()`, already used
  by this repo's own `strand-membership-writer.ts`. Replaced the note with a real guard
  (`assertCommitBoundary`) checked at both ends of the body: open transaction on entry means
  the wrapper is nested inside someone else's transaction and must be moved out; open on
  return means the body never committed. Either would notify a listener that then reads
  pre-commit state and materializes a membership snapshot silently missing the write it was
  told about — the exact failure this ticket exists to prevent. Unreachable from today's
  callers, so it is a fail-fast guard, and it is covered by two of the new tests.
- **Nothing exercised the seam** (the implementer's own largest flagged gap). Added
  `test/control-membership-hub.spec.ts`, 10 cases against a real `CadreNode` +
  `ControlDatabase`: one notification per insert / remove / re-authorize with the correct
  reason; post-commit ordering proved non-vacuously (the listener reads `CadrePeer` back and
  must see the row present on insert, absent on remove); no notify when the target row is
  already absent; no notify on the `updateSelfPeerRecord` carve-out; no notify when the body
  throws; the write still succeeds when the listener throws; single-slot replace + clear;
  and the two commit-boundary refusals. The node's 1 s self-registration timer is disarmed
  in setup — it is itself a member-row insert and would otherwise land stray notifications
  mid-test.
- **Same 15-line transaction shape written four times.** `removePeer` (moved by this diff)
  and `deleteDeviceToken` each hand-rolled the begin / commit / rollback-and-swallow-the-
  secondary-throw block that `ControlDatabase.inTransaction` already owned, comment
  included. Made `inTransaction` public and reused it in both; log strings are byte-identical
  to before. The fourth copy (`inStrandTransaction` in `strand-membership-writer.ts`) stays:
  different database, and it deliberately *joins* a caller-owned transaction rather than
  opening its own.
- **Two doc statements contradicted each other.** `mutateCadrePeer` said "EVERY `CadrePeer`
  writer goes through here" while `updateSelfPeerRecord` documented itself as an exception.
  The absolute claim now names its one exception.
- **The insert/update asymmetry the ticket asked a reviewer to judge.**
  `insertSelfPeerRecord` notifies, `updateSelfPeerRecord` does not — correct as landed:
  neither can change the snapshot, but the insert shares the one owner-signed writer with
  every other member's row and happens once at startup (one wasted read), while the update
  repeats on a timer. Carving the insert out would mean a conditional inside the shared
  writer. Recorded the reasoning on `updateSelfPeerRecord` and pinned the update half with a
  test so a later "make it uniform" edit fails loudly.

### Filed as new work (major)

- `backlog/debt-cadrepeer-writes-behind-control-database` — the rule "member-row writes go
  through `mutateCadrePeer`" is still upheld by a grep, not by types. Any holder of the
  control database can reach the table through `getDatabase()` with no compiler, lint, or
  runtime complaint, and this specific mistake has already been made twice. The structural
  fix (move the three statements behind `ControlDatabase` methods) is a real refactor with a
  known obstacle — the member table's authorization digests differ from the other guarded
  tables, so it cannot reuse `deleteGuardedRow` — which is why planning deferred it. Too
  large for a review pass; filed rather than assumed away. The new commit-boundary guard
  narrows the blast radius but does not close this.

### Parked as tripwires (conditional — not tickets)

- `assertCommitBoundary` reads autocommit for the whole `Database`, not for one call. Control
  writes are sequential today; a future path running a member write *concurrently* with an
  unrelated control transaction on the same `Database` would now throw rather than silently
  join that transaction. Safe outcome, but such a caller must serialize — `NOTE:` on the
  method.
- The implementer's own transaction-boundary tripwire is retired, not moved: it is now an
  assertion instead of a comment.

### Checked, nothing found

- **Failure paths.** `removePeer` / `reauthorizePeer` on an absent row still early-return
  ahead of the wrapper (verified in source and pinned by a test), so no notify — correct,
  nothing changed. A constraint rejection inside a body throws out without notifying.
- **No-listener operation.** The specs that drive the real service against a bare control
  database, and those that write member rows with raw SQL bypassing the seam entirely
  (`seed-bootstrap.spec.ts`, `control-authorization-domain-separation.spec.ts`,
  `control-revocation-replay.spec.ts`), all still pass.
- **Docs.** `docs/architecture.md` L341 and `docs/STATUS.md` L826 describe the snapshot
  refresh as riding the `CadreNode` wrappers, with a stated caller obligation to follow a
  low-level write with `refreshMembershipGate()`. Both are still **accurate at this commit**
  precisely because phase 1 attaches no listener, so they were deliberately left alone —
  editing them now would document behaviour that does not yet exist. Phase 2's ticket
  already lists both as required edits (its `files:` header and its own findings section).
  No other doc mentions the write path.
- **Type safety.** Considered narrowing `reason` from `string` to a closed union of the
  three labels; declined. It is a log label only, and phase 2 passes its own reasons
  (`'timer'`, `'startup'`, …) through the same channel, so a union would have to grow with
  every caller for no checked invariant.
- **Resource cleanup.** The listener slot is a single field cleared by
  `setMembershipChangeListener(null)`; no timers, streams, or subscriptions are created
  here. Phase 2 owns the teardown ordering (clear before `close()`), and its ticket says so.

### Deliberately out of scope

Notification is awaited inline, so a slow listener adds latency to every member write. That
is phase 2's problem by construction — coalescing is its whole subject — and it is specified
there. Not re-filed.
