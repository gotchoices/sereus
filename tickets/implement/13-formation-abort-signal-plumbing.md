description: First half of the formation-timeout fix: thread a cancellation signal through the invite-redemption write path so work the host has already given up on is abandoned before it spends the one-time invite.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/cadre-core/test/control-formation-recorder.spec.ts
difficulty: hard
----

<!-- resume-note -->
A prior agent run completed ALL source edits but hit its token budget before writing the
tests or running validation. Do not redo the source changes — verify them by running the
validation commands, then write the two test items below. Everything under "Source changes
already landed" is in the working tree (uncommitted).
<!-- /resume-note -->

## Context

Confirmed bug (repro details in the sibling ticket `formation-settle-grace-listener`): when the
formation responder's provisioning budget expires, `withTimeout` only stops *waiting* — the
abandoned hook keeps running and its `FormationUsage` insert lands late, spending the
single-use invite after the joiner was already told the join failed. The same invite is then
refused (`'Invalid token'`) and the joiner is stuck.

The fix is split across two tickets. **This ticket** threads an `AbortSignal` from the
listener's timeout down the whole redemption write path, so abandoned work is observed and
dropped BEFORE anything is written (throwing `FormationAbortedError`, already exported).
**`formation-settle-grace-listener`** (prereq'd on this one) then makes the listener actually
fire the signal on work-budget expiry and adopt a late success within a settle grace.

Signal placement rules — the point of the whole exercise:

- Check **before** the approval-hook HTTP call and **before** the DB write statement is
  issued. The DB check goes INSIDE the write-lock body, so a write still queued behind
  another writer is abandoned rather than executed.
- **Never** abort once `execFormationUsageInsert` has been issued — a half-issued insert must
  be allowed to land (the sibling ticket's settle grace adopts it as a successful join).
- Every signal param is optional, so existing test doubles and the `StrandProvisioner` mock
  path keep compiling. Fakes stay structurally assignable.

## Source changes already landed (verify, do not redo)

All per the original TODO list, all in the working tree:

- `strand-formation-protocol.ts`: `FormationListenerOptions.provisionStrand` has optional
  4th param `signal?: AbortSignal` with docblock (type-level only — the listener does not
  pass one yet; that is the sibling ticket's job). Pre-existing from an earlier run:
  `PROVISION_SETTLE_GRACE_MS` constant + docblocks — untouched, correct.
- `strand-solicitation.ts`: `FormationUsageRecorder.recordUsage` and `provisionAndRecord`
  param objects each gained optional `signal?: AbortSignal` with a one-line docblock.
- `formation-approval.ts`:
  - `FormationApprover.requestApproval(request, signal?)` — stale NOTE about missing
    AbortSignal support replaced with a docblock describing the new param.
  - `createHttpFormationApprover`'s `requestApproval`: pre-aborted signal (checked after
    `origin` is computed, before the timer/fetch) throws
    `FormationApprovalError('unavailable', 'Formation was cancelled before approval hook
    ${origin} was asked')`. Mid-flight: `callerAborted` flag + `onCallerAbort` listener
    (added `{ once: true }`, relays to `controller.abort()`; comment notes
    `AbortSignal.any` deliberately avoided for React Native/Hermes). Listener removed in
    the existing `finally` alongside `clearTimeout`. Catch picks message via if/else chain:
    `timedOut` → existing "did not answer within Nms"; else `callerAborted` →
    `'Formation was cancelled while approval hook ${origin} was being asked'`; else
    existing could-not-be-reached.
- `control-database.ts`: `redeemInvitation` and `recordFormationUsage` param objects gained
  optional `signal?: AbortSignal` (docblocked). Check is INSIDE the `withWriteLock`
  callback: redeem checks before `inTransaction('redemption', ...)` (one check, never
  between the two inserts) throwing `new FormationAbortedError(token, 'redemption')`;
  record checks immediately before `execFormationUsageInsert` throwing
  `(token, 'usage recording')`. Reads (`queryStrandStampId`, `nextUseNumber`) stay before
  the lock, unchecked. Pre-existing from an earlier run: `FormationAbortedError` class —
  untouched, correct. NOTE: `redeemInvitation`'s lock body was re-indented when the check
  was inserted (the SQL template literal's leading whitespace changed — harmless to SQL).
- `control-formation-recorder.ts`: imports `FormationAbortedError` (value import merged
  into the existing `control-database.js` import). `recordUsage` / `provisionAndRecord`
  destructure `signal` and check at the TOP (before `queryFormationInvite`; in
  `provisionAndRecord` also before the `randomBytes` strand-id mint), throwing
  `FormationAbortedError(token, 'usage recording')` / `(token, 'redemption')`. Signal
  threaded into `controlDatabase.recordFormationUsage` / `redeemInvitation`.
  `obtainApproval` gained a second `signal?: AbortSignal` param, checked immediately
  before `this.approver.requestApproval(fullRequest, signal)` throwing
  `FormationAbortedError(fields.token, 'approval')`.
- `strand-formation-manager.ts`: imports `FormationAbortedError` from
  `./control-database.js` (comment notes no cycle). Listener wiring passes the 4th
  `signal` arg through to `provisionAsResponder`, which gained optional trailing
  `signal?: AbortSignal` and threads it into `recorder!.recordUsage({..., signal})` and
  `provisionUnbound(..., signal)` → `provisionAndRecord({..., signal})`. The
  `strandProvisioner` fallback and placeholder path write nothing — no signal, as
  intended. `provisionAsResponder`'s catch rethrows `FormationAbortedError` BEFORE the
  `FormationApprovalError` mapping (dormant until the sibling ticket fires the signal —
  intended intermediate state).

Editor diagnostics during the run showed transient "Expected 3 arguments, but got 4" /
unused-variable errors in `strand-formation-manager.ts` — these appeared mid-edit-sequence
and should be stale (the signature edits landed after the wiring edit), but NOTHING has been
validated: no typecheck, no lint, no tests were run. Verify first.

## TODO (remaining)

- Run root `yarn typecheck` first to confirm the landed edits compile; fix any real
  residue (watch `strand-formation-manager.ts` — see stale-diagnostics note above).
- Extend `test/formation-approval.spec.ts` (has `stubFetch` / `expectFailure` /
  `baseRequest` helpers):
  - Pre-aborted caller signal → `unavailable`, and `calls` has length 0 (hook never
    contacted).
  - Mid-flight abort: fetch stub that rejects when `init.signal` fires (copy the existing
    never-answers stub in the 'aborts and reports unavailable when the hook never answers'
    test); the caller aborts its own controller after ~10 ms via `setTimeout`; client
    `timeoutMs: 10_000` → prompt `unavailable` rejection (not a 10 s wait),
    `error.message` contains `'cancelled'`.
- NEW `test/control-formation-recorder.spec.ts` (none exists today): construct
  `ControlFormationUsageRecorder` with a Proxy-based `ControlDatabase` whose every property
  access throws `'must not be reached'`, and an approver whose `requestApproval` throws
  likewise; a pre-aborted signal → `recordUsage` and `provisionAndRecord` both reject with
  `FormationAbortedError`, stubs never touched. (Constructor only stores the database, so
  the Proxy is safe to hand in; pass the throwing approver so the default HTTP client is
  not constructed.)

## Validation

`yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-test.log`, then root
`yarn typecheck` and `yarn lint`.

When done, write the review/ handoff for the whole ticket (source changes above + tests)
and delete this file.
