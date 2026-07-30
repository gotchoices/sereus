----
description: Finish a concurrency fix in the control database (a write lock that serializes local writes), then run the remaining test suites for the new two-node strand-join network test and hand off to review. A prior run found and half-landed the fix before hitting its token budget.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts
difficulty: hard
----

Continuation of `strand-addr-seed-convergence-validation` (itself the
execution phase of `strand-addr-seed-convergence-scenario`). The prior run
executed the suites, found a REAL cadre-core race, and landed most — not all —
of the fix before hitting its token budget. This ticket: finish the fix
(4 small mechanical edits), validate, hand off to review.

## What the prior run established (do not redo)

- Sibling repos fresh: `C:\projects\quereus` was rebuilt
  (`cd C:\projects\quereus\packages\quereus && yarn build`, compiles clean);
  optimystic packages all fresh. Freshness = newest file mtime under `src`
  vs newest anywhere under `dist` (`.tsbuildinfo` counts) — matches
  `test-harness/build-freshness.ts` logic. The sibling's runner may re-edit
  its tree at any time; rebuild again if the guard trips.
- `yarn workspace @serfab/cadre-core test` — GREEN before the fix edits
  (76 files, 1199 passed, 1 skipped, ~65 s). Must be re-run after them.
- The scenario run FAILED, reproducibly explaining itself:

  ```
  Error: mutateCadrePeer(peer-insert): a transaction is open on entry to the
  mutation body — a CadrePeer write must commit before the membership listener runs
    at ControlDatabase.assertCommitBoundary (control-database.ts)
    at SeedBootstrapService.insertCadrePeerRow (seed-bootstrap.ts:372)
    at scenario line ~224: await A.authorizePeer(aPeerId)
  ```

## Root cause (fully diagnosed — trust this, don't re-derive)

Founder A in the scenario has a STABLE identity (same Ed25519 key = node
identity + owner signing key). When joiner B's control connection opens, A's
0→≥1 growth edge (`CadreNode.handleControlConnectionChange`) fires the
background drain (`drainPendingControlReplication`), whose first step calls
`registerSelf()`. On a stable-identity owner with no existing row that is an
owner-signed CadrePeer INSERT (`SeedBootstrapService.insertSelfPeerRecord` →
`ControlDatabase.mutateCadrePeer`). The test's foreground
`A.authorizePeer(aPeerId)` runs the same `mutateCadrePeer` path concurrently.
Quereus `getAutocommit()` is Database-wide and a write's implicit transaction
spans awaits inside `exec`, so whichever call enters second sees the other's
open transaction and the commit-boundary assert throws. Not a test bug — a
latent production race for any stable-identity owner authorizing a peer near
its first control connection. The assert's own NOTE anticipated it: "such a
caller must serialize."

Why sibling scenarios never hit it: push-wake scenario 1/4 owners use
EPHEMERAL node identities (`registerSelf` skips — no self-signing key);
scenario 3 has three `connectControlNodes` calls between connect and
authorize, giving the drain time to finish. Timing luck, not immunity.

## Fix chosen and MOSTLY landed in `control-database.ts`

A database-wide local-write mutex on `ControlDatabase`:

- `private writeQueue: Promise<unknown>` field + public
  `withWriteLock<T>(fn)` (promise-chain mutex, failure-proof tail) — landed,
  full doc comment on it.
- `mutateCadrePeer` now runs [entry assert, body, return assert, notify]
  entirely under the lock (listener is read-only; doc updated to say a
  writing listener would deadlock) — landed.
- `assertCommitBoundary` NOTE rewritten: with writers locked it now only
  catches enclosing-transaction misuse or a writer that bypasses the lock —
  landed.
- Wrapped under the lock: `updateSelfPeerRecord`, `updateSelfDeviceToken`,
  `insertOwnerKey`, `insertStrand`, `insertValidationKey`, `deleteStrand`,
  `deleteValidationKey`, `deleteDeviceToken` (the latter three wrap their
  `deleteGuardedRow` call). `deleteCadrePeer` is already covered via
  `mutateCadrePeer`. — all landed.
- CRITICAL invariant: `deleteGuardedRow` and `inTransaction` (private bodies)
  stay BARE — they run inside already-locked public entry points; locking
  them would self-deadlock. The lock is NOT re-entrant.

## TODO — remaining edits (mechanical, ~4 spots)

- `insertFormationInvite`: wrap its single `this.db!.exec(...)` in
  `await this.withWriteLock(() => this.db!.exec(...))` (the
  `canonicalDatetime` read before it can stay outside).
- `redeemInvitation`: wrap the `await this.inTransaction('redemption', ...)`
  call in `withWriteLock` (reads before it stay outside).
- `recordFormationUsage`: wrap the `await this.execFormationUsageInsert(...)`
  call in `withWriteLock`.
- `seed-bootstrap.ts` `insertSelfDeviceToken` (~line 401): its direct
  `db.exec` insert is a control-DB write outside any wrapper — wrap it in
  `this.controlDatabase.withWriteLock(() => db.exec(...))`. (Its CadrePeer
  writes at lines ~372/~616 are already inside `mutateCadrePeer` bodies —
  leave them bare.)
- Optional polish: one-line doc notes on `deleteGuardedRow`/`inTransaction`
  saying they stay bare because they run under the caller's write lock.

## TODO — validation

- `yarn workspace @serfab/cadre-core build` (or repo typecheck) + `yarn lint`.
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
  — watch for any unit test that drove concurrent writes and depended on
  interleaving (none expected; lock only serializes).
- Rerun the scenario, streaming:
  `yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts 2>&1 | tee /tmp/strand-addr-seed.log`
  The `authorizePeer` collision should be gone. Next likely failure points,
  per the original ticket: empty RPC seed (responder gate — the explicit
  `isAuthorizedMember` asserts before it distinguish gate vs addr-lookup),
  or auto-dial convergence timeout (report as a finding, NEVER add a manual
  dial — hard rule from the spec).
- If green, run once or twice more for stability; record timings.
- Do NOT run the whole integration suite inline (>10 min; out-of-band/CI).

## TODO — handoff (write review/ ticket, delete this one)

Carry into the review ticket:
- The race + fix story above (it is the main review surface: lock placement,
  non-re-entrancy invariant, notify-inside-lock decision).
- Whether auto-dial convergence was stable across runs, with timings.
- Data replication A↔B deliberately NOT asserted (bootstrap-mode founder
  commits via a purely local transactor); a data-convergence scenario needs
  both nodes networked — possible follow-up, don't build it.
- Push-wake helpers copied, not shared — tracked in
  `integration-test-harness-helper-consolidation`; `NOTE:` at the copy site.
- Phase 1 (observable `StrandInstance.mode`) landed two commits back; its
  unit-spec stub updates were mechanical.
- Validation state at THIS ticket's start: cadre-core unit tests green
  pre-fix; lint/typecheck green pre-fix; scenario failing on the race above;
  nothing yet run post-fix.
