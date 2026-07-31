description: First half of the formation-timeout fix: a cancellation signal now threads through the invite-redemption write path so work the host has already given up on is abandoned before it spends the one-time invite. Implemented and code-reviewed.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/cadre-core/test/control-formation-recorder.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts
difficulty: hard
----

## What landed

An optional `AbortSignal` now runs from the formation listener's `provisionStrand` hook all
the way down to the two database write methods that spend an invite. Work whose caller has
given up throws `FormationAbortedError` (from `control-database.ts`) BEFORE anything is
written, so the invite's single use survives.

Nothing fires the signal yet — the sibling ticket `formation-settle-grace-listener`
(`tickets/implement/13.5-...`) makes the listener abort on work-budget expiry and adopt a
late success within a settle grace. Until it lands the new paths are dormant, but they are
now tested at every layer that can be reached without it.

### Signal placement (the invariants)

- Checked before the approval-hook HTTP call and before each write statement is issued.
- The database check sits INSIDE `withWriteLock`'s callback, so a write still queued behind
  another writer when the caller gave up is abandoned rather than executed.
  `redeemInvitation` checks once, before its transaction opens, never between its two
  inserts.
- Never aborts once `execFormationUsageInsert` has been issued — a half-issued insert must
  land, and the sibling's settle grace adopts it as a successful join.
- Every `signal` parameter is optional, so existing fakes and the `StrandProvisioner` mock
  path compile unchanged. The `strandProvisioner` fallback and the placeholder path write
  nothing and take no signal.

### Where the checks live

- `formation-approval.ts` `createHttpFormationApprover`: pre-aborted signal throws an
  `unavailable` `FormationApprovalError` before the timer/fetch; a mid-flight abort is
  relayed by hand onto the fetch's own `AbortController` (`AbortSignal.any` deliberately
  avoided — not reliable on React Native/Hermes) and reported as "cancelled while ... being
  asked". The listener is removed in the existing `finally` alongside `clearTimeout`.
- `control-formation-recorder.ts`: `recordUsage` / `provisionAndRecord` check at the top,
  before the invite read and before the strand-id mint; `obtainApproval` checks before the
  hook is asked and re-labels a caller-abort raised *during* the ask (see review finding 1).
- `control-database.ts`: `redeemInvitation` / `recordFormationUsage` check inside the
  write-lock body.
- `strand-formation-manager.ts`: listener wiring threads the 4th argument through
  `provisionAsResponder` → `recordUsage` / `provisionUnbound` → `provisionAndRecord`. Its
  catch rethrows `FormationAbortedError` BEFORE the `FormationApprovalError` mapping, so an
  abort is never returned as a rejection the sibling's grace would adopt and send.
- `strand-formation-protocol.ts`: `FormationListenerOptions.provisionStrand` gained the
  optional 4th `signal` parameter (type-level only). `PROVISION_SETTLE_GRACE_MS` (2 s) is
  exported for the sibling.

## Review findings

Reviewed the two implement commits (`2bad50d`, `6e75fbb`) against the current tree, then
read every touched source file plus the listener, the write lock, and the manager's error
mapping.

### Fixed in this pass (minor)

1. **A caller-abort during the approval hook did not surface as an abort.** The HTTP client
   correctly relays the abort onto its own request, but reports it as an `unavailable`
   `FormationApprovalError` — which the manager cannot tell from a genuinely dead hook, so
   it MAPPED it to `'Formation approval unavailable, retry'` and RETURNED rather than
   rethrowing. Every other abort on the path throws, which is exactly what makes the manager
   rethrow and leave the reply to the listener's timeout path; once the sibling lands, its
   settle grace would have adopted that returned rejection and sent the wrong reason. No
   invite was ever spent by this (nothing is written on the path), so it is a
   reply-correctness bug, not a spend bug. Fix: a new private `askApprover` in
   `control-formation-recorder.ts` re-labels an approver failure observed with an aborted
   signal as `FormationAbortedError`, keeping the approval error as `cause`.
   `FormationAbortedError` gained an optional `{ cause }` so nothing is swallowed.
2. **`obtainApproval` minted a `usageStampId` before checking the signal.** Wasted work on a
   redemption already abandoned, and the check was meant to precede the ask. Check moved
   above the mint.
3. **Two docblocks described listener behaviour that does not exist yet.**
   `PROVISION_SETTLE_GRACE_MS` and `DEFAULT_PROVISION_TIMEOUT_MS` both read in the present
   tense ("the listener aborts …", "the last 2 s of this budget IS a settle grace"), which
   would mislead anyone reading the file today. Both now say the split is not yet wired and
   point at the sibling ticket.

### Tests added (filling the gaps the handoff flagged)

- `test/control-formation-invite.spec.ts` — the ticket's central invariant had NO direct
  test. Three cases against the real `ControlDatabase`: `redeemInvitation` and
  `recordFormationUsage` each parked behind a deliberately-held write lock, aborted while
  queued, asserting `FormationAbortedError`, no rows written, and — the point of the whole
  exercise — that the `totalUses: 1` invite is still spendable afterwards. Plus a
  guard-on-the-guard: the same parked-behind-a-writer shape with a live signal lands
  normally, so the two abort cases cannot pass for the wrong reason.
- `test/control-formation-recorder.spec.ts` — `obtainApproval`'s own pre-ask check (abort
  landing between the invite read and the hook ask), asserting the approver is asked zero
  times; and the mid-ask re-label from finding 1, asserting the `FormationAbortedError`
  class and that the `FormationApprovalError` is retained as `cause`.

### Checked, nothing wrong

- **Write-lock safety.** `withWriteLock` is `writeQueue.then(fn, fn)`, so the new synchronous
  `throw` inside the callback becomes a rejection of the returned promise and the tail is
  parked as a swallowed copy — no leaked lock, no poisoned queue, no unhandled rejection.
  This was the one way the change could have deadlocked every writer in the process.
- **`AbortSignal` listener cleanup** in the HTTP approver: added with `{ once: true }` and
  removed in the `finally` alongside `clearTimeout`, on every exit path.
- **Reads left unchecked before the lock** (`queryStrandStampId`, `nextUseNumber`,
  `queryFormationInvite`, `resolveStrand`) — correct: they spend nothing, and an abort that
  arrives during them is caught by the in-lock check anyway.
- **Interface compatibility.** All `signal` parameters optional; every existing
  `provisionStrand` / `requestApproval` / `FormationUsageRecorder` implementation across
  `cadre-core` tests, `integration-tests`, and `reference-app-web`'s e2e fixture stays
  structurally assignable. No implementation outside `cadre-core` needed a change.
- **Docs.** `docs/api.md` documents the approval hook's WIRE contract, which this change does
  not alter, and `docs/architecture.md`'s formation-timeout ladder still describes today's
  runtime behaviour accurately because no timing changed. The ladder rewrite belongs to the
  sibling ticket, which already owns it in its Docs section — deliberately not done here.
- **No new tickets filed.** The remaining untested path — the manager's
  `FormationAbortedError` rethrow — cannot be exercised until something fires the signal, and
  the sibling ticket's test list already covers it (it captures the hook's 4th argument and
  asserts the abort). Filing a ticket for it would duplicate work already queued.

### Tripwire (recorded in code, not filed as a ticket)

None. The one conditional concern in this area — a work budget expiring after the
`FormationUsage` insert has been issued but before it commits — is already owned by the
sibling ticket, which parks it as a tripwire in `settleWithinGrace`'s docblock.

## Validation

- `yarn workspace @serfab/cadre-core test`: 79 files, 1227 passed, 1 skipped (pre-existing),
  0 failures — up from 1222 passing, i.e. the 5 tests added by this review.
- Root `yarn typecheck`: clean.
- Root `yarn lint`: 0 errors. 6 pre-existing warnings (unused eslint-disable directives) in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, a file
  no part of this ticket touches.
