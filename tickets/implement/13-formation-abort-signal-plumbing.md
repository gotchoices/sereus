description: First half of the formation-timeout fix: thread a cancellation signal through the invite-redemption write path so work the host has already given up on is abandoned before it spends the one-time invite.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/cadre-core/test/control-formation-recorder.spec.ts
difficulty: hard
----

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

## Already in the working tree (do not redo)

- `control-database.ts`: `FormationAbortedError` exported directly below
  `MissingHostStrandError`. Constructor is `(token, operation)` — token FIRST (unlike
  `MissingHostStrandError`). Its docblock already states the "never thrown once the insert
  has been issued" rule and that the manager rethrows it rather than mapping to a conflict.
- `strand-formation-protocol.ts`: `PROVISION_SETTLE_GRACE_MS = 2_000` constant + docblock,
  and the work-budget-equals-hook-timeout race note in `DEFAULT_PROVISION_TIMEOUT_MS`'s
  docblock. Both are consumed by the sibling ticket; nothing in this ticket touches them.

## TODO (all placements verified against current code)

- `strand-formation-protocol.ts`: add optional 4th param `signal?: AbortSignal` to
  `FormationListenerOptions.provisionStrand` (type-level only — passing a real signal is the
  sibling ticket's job). Docblock: aborted when the listener's work budget expires; a hook
  that observes it before writing leaves the invite unspent.
- `strand-solicitation.ts` (`FormationUsageRecorder`, param objects at ~:66 and ~:102): add
  optional `signal?: AbortSignal` to `recordUsage` and `provisionAndRecord`.
- `formation-approval.ts`:
  - `FormationApprover.requestApproval` gains an optional second `signal?: AbortSignal`
    param; DELETE the stale `NOTE:` above it (~:83–87 — this work is exactly the case it
    anticipates).
  - `createHttpFormationApprover`'s `requestApproval` (~:441–482): after `origin` is
    computed and BEFORE creating the timer or fetching — pre-aborted signal → throw
    `FormationApprovalError('unavailable', `Formation was cancelled before approval hook ${origin} was asked`)`.
    Otherwise add a `callerAborted` flag beside the existing `timedOut` flag plus
    `signal.addEventListener('abort', onCallerAbort, { once: true })` where `onCallerAbort`
    sets the flag and calls `controller.abort()`; remove via `removeEventListener` in the
    existing `finally` (which already clears the timer). Error-message branch in the catch:
    `timedOut` → existing message; else `callerAborted` →
    `` `Formation was cancelled while approval hook ${origin} was being asked` ``; else the
    existing could-not-be-reached message. Do NOT use `AbortSignal.any` — not reliably
    present on React Native/Hermes; the docblock at ~:418 commits to `fetch` +
    `AbortController` only.
- `control-database.ts`: `recordFormationUsage` and `redeemInvitation` param objects gain
  optional `signal?: AbortSignal`. Check INSIDE the `withWriteLock` callback — for record,
  immediately before `execFormationUsageInsert`; for redeem, before
  `inTransaction('redemption', ...)` — ONE check, never between the two inserts. Throw
  `new FormationAbortedError(token, 'usage recording')` / `(token, 'redemption')`. A
  synchronous throw inside the callback is fine (`writeQueue.then(fn, fn)` turns it into a
  rejection). The reads (`queryStrandStampId`, `nextUseNumber`) stay before the lock,
  unchecked.
- `control-formation-recorder.ts`:
  - `recordUsage` and `provisionAndRecord`: destructure `signal`; entry check at the TOP
    (`if (signal?.aborted) throw new FormationAbortedError(token, ...)`) — before
    `queryFormationInvite`, and in `provisionAndRecord` also before the `randomBytes`
    strand-id mint. Thread `signal` into `controlDatabase.recordFormationUsage` /
    `redeemInvitation`.
  - `obtainApproval` gains a second `signal?: AbortSignal` param; check it immediately
    before `this.approver.requestApproval(fullRequest, signal)`.
- `strand-formation-manager.ts`:
  - Listener wiring becomes
    `provisionStrand: (token, initiatorPartyId, disclosure, signal) => this.provisionAsResponder(token, initiatorPartyId, disclosure, signal)`.
  - `provisionAsResponder` gains optional trailing `signal?: AbortSignal`; thread into
    `recorder!.recordUsage({..., signal})` and `provisionUnbound(..., signal)` →
    `provisionAndRecord({..., signal})`. The `strandProvisioner` fallback and the
    placeholder path write nothing — no signal needed.
  - In `provisionAsResponder`'s catch, rethrow `FormationAbortedError` BEFORE the
    `FormationApprovalError` mapping (import from `./control-database.js` — no cycle;
    control-database does not import the manager), so an abandoned provisioning is not
    reported as `'Formation conflict, retry'`. With this ticket alone the listener never
    fires the signal, so the rethrow is dormant until the sibling ticket lands — that is the
    intended intermediate state.

## Tests

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
