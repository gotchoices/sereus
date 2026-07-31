description: First half of the formation-timeout fix: a cancellation signal now threads through the invite-redemption write path so work the host has already given up on is abandoned before it spends the one-time invite. Ready for code review.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/cadre-core/test/control-formation-recorder.spec.ts
difficulty: hard
----

## What this is

Plumbing half of the fix for the confirmed bug where a formation responder's expired
provisioning budget only stopped the *wait* — the abandoned work kept running and its late
`FormationUsage` insert spent the single-use invite after the joiner had already been told
the join failed. This ticket threads an optional `AbortSignal` from the formation listener's
`provisionStrand` hook down the entire redemption write path, so abandoned work throws
`FormationAbortedError` (exported from `control-database.ts`) BEFORE anything is written.

Nothing fires the signal yet. The sibling ticket `formation-settle-grace-listener`
(prereq'd on this one) makes the listener abort on work-budget expiry and adopt a late
success within a settle grace. Until it lands, every new code path is dormant-but-tested.

## Signal placement (the invariants to review against)

- Checked BEFORE the approval-hook HTTP call and BEFORE each DB write statement is issued.
- The DB check sits INSIDE `withWriteLock`'s callback — a write still queued behind another
  writer when the caller gave up is abandoned rather than executed. `redeemInvitation`
  checks once, before its transaction opens, never between its two inserts.
- NEVER aborts once `execFormationUsageInsert` has been issued — a half-issued insert must
  land (the sibling's settle grace adopts it as a successful join).
- Every `signal` param is optional; existing fakes and the `StrandProvisioner` mock path
  compile unchanged. The `strandProvisioner` fallback and placeholder paths write nothing
  and intentionally take no signal.

## Where the checks live

- `formation-approval.ts` `createHttpFormationApprover`: pre-aborted signal → throws
  `FormationApprovalError('unavailable', '...cancelled before approval hook...')` before
  the timer/fetch; a mid-flight abort is relayed by hand onto the fetch's own
  `AbortController` (`AbortSignal.any` deliberately avoided — not reliable on React
  Native/Hermes) and reported as `'unavailable'` with "cancelled while ... being asked".
  Listener removed in the existing `finally` alongside `clearTimeout`.
- `control-formation-recorder.ts`: `recordUsage` / `provisionAndRecord` check at the top
  (before the invite read; `provisionAndRecord` also before the strand-id mint), throw
  `FormationAbortedError`, and thread the signal into the DB calls. `obtainApproval`
  checks immediately before asking the approver.
- `control-database.ts`: `redeemInvitation` / `recordFormationUsage` check inside the
  write-lock body as described above.
- `strand-formation-manager.ts`: listener wiring passes the 4th `signal` arg through
  `provisionAsResponder` → `recordUsage` / `provisionUnbound` → `provisionAndRecord`.
  Its catch rethrows `FormationAbortedError` BEFORE the `FormationApprovalError` mapping,
  so an abort is never misreported as a retryable conflict (dormant until the sibling
  fires the signal — intended).
- `strand-formation-protocol.ts`: `FormationListenerOptions.provisionStrand` gained the
  optional 4th `signal` param (type-level only this ticket). `PROVISION_SETTLE_GRACE_MS`
  (2 s) is defined for the sibling; it was flagged unused by lint, so it is now
  **exported** — the sibling wires it into the listener and its tests can reference it.

## Validation performed

- `yarn workspace @serfab/cadre-core test`: 79 files, 1222 passed, 1 skipped
  (pre-existing skip), 0 failures.
- Root `yarn typecheck`: clean.
- Root `yarn lint`: 0 errors. 6 pre-existing warnings (unused eslint-disable directives)
  in `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`,
  untouched by this ticket.

## New tests (a floor, not a ceiling)

`test/formation-approval.spec.ts` additions:
- Pre-aborted caller signal → `unavailable`, and the fetch stub records zero calls (an
  abandoned redemption never contacts the hook).
- Mid-flight caller abort (~10 ms in) with a 10 s client timeout → prompt `unavailable`
  rejection whose message contains "cancelled", and the fetch's own signal observed the
  abort — proving the relay, not the timer, ended the request.

`test/control-formation-recorder.spec.ts` (new file):
- `recordUsage` and `provisionAndRecord` with a pre-aborted signal reject with
  `FormationAbortedError` (correct token + operation in message) against a Proxy-based
  `ControlDatabase` whose every member access throws and an approver that throws — proving
  no read, no approval ask, no write happens.
- Guard-on-the-guard: an unaborted signal reaches the database (the booby-trap trips),
  proving the tests distinguish the two cases.

## Known gaps for the reviewer

- The in-write-lock abort checks in `control-database.ts` (`redeemInvitation`,
  `recordFormationUsage`) have NO direct test — exercising them needs a real
  `ControlDatabase` with a signal aborted while a write sits queued behind the lock.
  The sibling ticket's listener-level tests are the natural place; flagging in case the
  reviewer wants a DB-level test sooner.
- `obtainApproval`'s own pre-ask check (abort between invite read and hook ask) is
  untested — only the earlier top-of-function checks and the HTTP client's checks are.
- `provisionAsResponder`'s `FormationAbortedError` rethrow-before-mapping is dormant and
  untested until the sibling fires the signal.
- `PROVISION_SETTLE_GRACE_MS` is exported but unconsumed until the sibling lands; if the
  sibling's design changes, revisit whether it should stay exported.
