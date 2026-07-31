description: When someone joins a network and the host runs out of time part-way through, the joiner is told the join failed even though the host may finish a moment later and burn the one-time invite — so the same invite is then refused and the person is stuck. Cancel the host's unfinished work when time runs out, and if it turns out to have finished anyway, tell the joiner it succeeded instead of lying about a failure.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/formation-approval.spec.ts, docs/architecture.md
difficulty: hard
----

<!-- resume-note -->
## Resume notes — second run (one code edit landed, rest unimplemented)

Two prior runs both hit their token budget. Run 1 completed all investigation (findings folded
into the design below). Run 2 (this note) read every relevant file, verified the design again,
and landed exactly ONE code change before its budget warning:

**Already in the working tree — do not redo:**
- `control-database.ts`: `FormationAbortedError` is exported, directly below
  `MissingHostStrandError`. Constructor signature is `(token: string, operation: string)` —
  token FIRST (unlike `MissingHostStrandError`, which is `(strandId, token)`). Docblock
  already states the "never thrown once the insert has been issued" rule and that the manager
  rethrows rather than mapping it to a conflict.

**Everything else is NOT started.** No signal params exist anywhere yet; the listener still
uses plain `withTimeout` with no grace. Implement the TODO phases below in order.

Run-2 verified details that refine the plan (all confirmed against current code):

- **Listener `provision()` shape** (replaces `strand-formation-protocol.ts:355-380`): keep
  `withTimeout` + an own `AbortController` + the existing `timedOut`-flag idiom (do NOT use
  `withDeadline` — it exposes neither a timed-out flag nor the signal outside `op`):

  ```ts
  const graceMs = Math.min(PROVISION_SETTLE_GRACE_MS, Math.floor(this.provisionTimeoutMs / 2));
  const workMs = Math.max(1, this.provisionTimeoutMs - graceMs);
  const controller = new AbortController();
  let timedOut = false;
  const pending = this.options.provisionStrand(contact.token, contact.partyId, contact.disclosure, controller.signal);
  try {
    return await withTimeout(workMs, `Formation provisioning#${id}`, () => pending,
      () => { timedOut = true; controller.abort(); });
  } catch (err) {
    if (!timedOut) throw err;   // preserves the internal-error path for a throwing hook
    return await this.settleWithinGrace(id, pending, graceMs);
  }
  ```

  `settleWithinGrace(id, pending, graceMs)`: run `withTimeout(graceMs, `Formation settle#${id}`,
  () => pending, () => { stillPending = true; })`. Settles approved/rejected → log + return the
  outcome (`runSession` needs NO change — its existing `!outcome` / `!outcome.approved` /
  approved branches handle all rows of the outcome table below). Throws (incl.
  `FormationAbortedError`) → log, return `undefined`. `stillPending` → attach the existing
  `void pending.then(...)` late-settle logging, return `undefined`. `undefined` keeps mapping
  to the exact reply string `'Formation provisioning timed out'` — three existing tests assert
  it verbatim. Replace the stale NOTE at `:368-373` with the narrowed residual (§3 below).
  A hook rejecting right after abort is safe: `withTimeout`'s promise already settled, and
  `settleWithinGrace` attaches handlers to `pending` in the same catch — no unhandled
  rejection window.

- **Grace clamp re-checked against all five existing timeout tests** (spec `:215-320`):
  pT 20 → 10/10 (never-settles test still replies 'timed out'); clamped 900 → 450/450 vs
  950 ms hook → timed out; clamped 600 → 300/300 vs 700 ms hook → timed out; pT 200 →
  work 100 vs 30 ms hook → approves; pT 0 → default 12 000 → work 10 000. `slowProvision`
  ignores the signal, so no existing test breaks.

- **Manager:** listener option becomes
  `provisionStrand: (token, pid, disclosure, signal) => this.provisionAsResponder(token, pid, disclosure, signal)`.
  In `provisionAsResponder`'s catch (`strand-formation-manager.ts:322`), rethrow
  `FormationAbortedError` BEFORE the `FormationApprovalError` mapping. Import from
  `./control-database.js` — no cycle (control-database does not import the manager). Thread
  `signal` into `recordUsage`, `provisionUnbound`, `provisionAndRecord`; the
  `strandProvisioner` fallback and placeholder paths need no signal (they write nothing).

- **DB check placement:** `recordFormationUsage`'s reads (`queryStrandStampId`,
  `nextUseNumber`) run BEFORE the lock, so the check goes inside the `withWriteLock` callback
  immediately before `execFormationUsageInsert`; for `redeemInvitation`, inside the lock
  before `inTransaction('redemption', ...)` — one check, never between the two inserts. A
  synchronous throw inside the `withWriteLock` callback is fine (`writeQueue.then(fn, fn)`
  turns it into a rejection). Both param objects gain optional `signal?: AbortSignal`.

- **Recorder (`control-formation-recorder.ts`):** entry check
  (`if (signal?.aborted) throw new FormationAbortedError(token, ...)`) at the TOP of
  `recordUsage` and `provisionAndRecord` (before `queryFormationInvite`; in
  `provisionAndRecord` before the `randomBytes` strand-id mint too). `obtainApproval` gains a
  `signal` param, checks it immediately before `approver.requestApproval(fullRequest, signal)`.
  Thread `signal` into `controlDatabase.recordFormationUsage` / `redeemInvitation`.

- **Recorder interface (`strand-solicitation.ts:66,102`):** add optional
  `signal?: AbortSignal` to both param objects. Fakes stay structurally assignable.

- **Approval client (`formation-approval.ts`):** interface gains optional second
  `signal?: AbortSignal` param on `requestApproval`; DELETE the stale NOTE at `:83-87` (this
  ticket is the case it anticipates). In `createHttpFormationApprover`'s `requestApproval`
  (`:441-482`): after `origin` is computed, pre-aborted signal → throw
  `FormationApprovalError('unavailable', ...)` before fetch; else add a `callerAborted` flag
  beside the existing `timedOut` flag, plus
  `signal.addEventListener('abort', onCallerAbort, { once: true })` that sets the flag and
  aborts the client's own controller, removed via `removeEventListener` in the existing
  `finally`. Error message branch: timedOut → existing; callerAborted → "cancelled while
  approval hook <origin> was being asked"; else → existing could-not-be-reached. Do NOT use
  `AbortSignal.any` (not reliably present on React Native/Hermes; docblock at `:418` commits
  to `fetch` + `AbortController` only).

- **Test designs (timings verified to clear CI jitter):**
  - Adoption regression (`strand-formation-protocol.spec.ts`): pT 400 (work 200/grace 200);
    hook sleeps 300 ms, THEN increments a `uses` counter, returns approved; `validateToken`
    returns `{ valid: uses < 1 }`. First session → `approved: true`, strand disclosed,
    `uses === 1`. Second session, same contact → `'Invalid token'` (the spend belongs to a
    join the joiner was TOLD succeeded).
  - Abandon-without-write: pT 100; hook call #1 returns a promise that rejects when its
    `signal` fires (no counter bump); call #2 approves and bumps. Session 1 →
    `'Formation provisioning timed out'` with `uses === 0`; session 2 (same contact) →
    approved — the invite survived the timeout.
  - Extend the existing never-settles test (`:235`): capture the hook's `signal` arg, assert
    `signal.aborted === true` after the reply.
  - Reply-bound: pT 500 (250/250), signal-ignoring never-settling hook; assert reply reason +
    elapsed ≤ 700 ms (a grace-added-on-top bug would reply ~750 ms).
  - Recorder pre-check: NEW spec `packages/cadre-core/test/control-formation-recorder.spec.ts`
    (none exists; the consent spec covers the recorder only indirectly). Construct
    `ControlFormationUsageRecorder` with a stub `ControlDatabase` whose methods all throw
    'should not be reached' and an approver that throws likewise; pre-aborted signal →
    `recordUsage` and `provisionAndRecord` both reject with `FormationAbortedError`, stub
    never touched.
  - Approval client (extend `formation-approval.spec.ts` — has `stubFetch`, `expectFailure`,
    `baseRequest` helpers): (1) pre-aborted signal → `unavailable`, `calls` length 0;
    (2) signal aborted mid-flight (fetch stub that rejects when `init.signal` fires; caller
    aborts its own controller after ~10 ms; client `timeoutMs` 10_000) → prompt `unavailable`
    rejection, not a 10 s wait.

- **Docs (`docs/architecture.md:526`):** ladder becomes "responder provisioning (12 s
  `provisionTimeoutMs`, of which the last 2 s is a settle grace)"; state that an overrunning
  provisioning is ABORTED (invite left unspent when the hook/DB observed the signal) and a
  late success inside the grace is adopted and reported as approval. Add one sentence (also
  at `DEFAULT_PROVISION_TIMEOUT_MS`'s docblock): the default work budget (10 s) now EQUALS
  the approval hook's own 10 s timeout, so a dead hook races 'Formation approval unavailable,
  retry' against 'Formation provisioning timed out' — both retryable, both leave the invite
  unspent.

- **Validation:** `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-test.log`, then
  root `yarn typecheck` and `yarn lint`.

Original ticket follows, unchanged.

## Confirmed reproduction

Written against the existing `MockStream` harness in
`packages/cadre-core/test/strand-formation-protocol.spec.ts` and run (passed, i.e. the bug
reproduces) — a `provisionStrand` hook that sleeps past `provisionTimeoutMs` and *then*
increments a use counter:

1. `FormationListener` replies `approved: false, reason: 'Formation provisioning timed out'`,
   and at that instant the use counter is still `0`.
2. ~100 ms later the abandoned hook finishes and the counter becomes `1` — the invite is spent.
3. A second session with the *same* contact frame is now answered `'Invalid token'`, because
   `validateToken` → `isTokenUsed` sees `uses >= totalUses`.

The joiner therefore holds an invitation that is permanently unusable, with no way to tell it
apart from a genuinely bad token.

Root cause is at `strand-formation-protocol.ts` → `FormationListener.provision()`: it runs the
hook under `withTimeout()`, which only stops *waiting*. The hook keeps running (there is already
a `NOTE:` there saying exactly this) and its `FormationUsage` insert lands late.

## Decision: cancel the work, then adopt a late success

The ticket offered two routes — cancel the provisioning, or make the spend recoverable on retry.
**Take the cancel route, plus a short "did it land anyway?" grace.** Reasons:

- *Recoverable spend is not reachable today.* Recovery would mean the host recognising a retry as
  the same joiner's half-finished redemption. The only durable identity on the consent row is
  `FormationUsage.PeerId`, and `StrandSolicitationService.formStrand()`
  (`strand-solicitation.ts:277`) mints a **fresh Ed25519 keypair on every call** and sets
  `disclosure.partyId` to it. A retry is therefore a *different* peer id with a *different*
  disclosure, so `(Token, PeerId)` recovery would never match. Making it match means adding a
  "resume this join with the same member key" affordance to the public join API — a much larger
  change than this bug warrants.
- *Recovery also widens disclosure.* A spent invite currently reveals nothing. A `(Token, PeerId)`
  recovery path would hand the strand id **and the closed-strand `MemberPrivateKey`** to anyone
  re-presenting a spent token under the recorded peer id — and `PeerId` is writer-asserted, not
  verified (see `schemas/control.qsql`, `FormationUsage.PeerId`, and backlog
  `debt-formation-usage-peer-signature-unverified`).
- *Cancellation is cheap and lands where the time actually goes.* Of the 12 s provisioning budget,
  the outbound approval-hook HTTP call owns up to 10 s of it, and the database write can sit
  queued behind other writers in `ControlDatabase.withWriteLock` (`control-database.ts:1110`).
  Both are points where "we have already given up" can be observed **before** anything is
  written, so an aborted provisioning overwhelmingly ends with the invite *not* spent.
- *The grace closes what cancellation cannot.* Once the `FormationUsage` insert has been issued,
  nothing can un-spend it (the table is append-only — `constraint InsertOnly check on update,
  delete (false)`). So instead of reporting failure over a write that may have landed, the
  listener waits a short settle grace after aborting and, if the provisioning settles
  **approved** in that window, replies with the real approval. The joiner's join succeeds and
  the spend is legitimate.

Net user-visible behaviour: a formation that reports failure leaves the invitation unspent, and a
formation whose work completed reports success — the "told it failed, invite gone" outcome
disappears except for the pathological residual noted at the end.

## Design

### 1. An `AbortSignal` down the provisioning path

The listener's provisioning timeout aborts an `AbortController`, and the signal is threaded to
every step that can still be abandoned:

```
FormationListener.provision()            work-budget timeout → controller.abort()
  → FormationListenerOptions.provisionStrand(token, partyId, disclosure, signal)
    → StrandFormationManager.provisionAsResponder(token, partyId, disclosure, signal)
      → FormationUsageRecorder.recordUsage({ …, signal })
        / FormationUsageRecorder.provisionAndRecord({ …, signal })
        → FormationApprover.requestApproval(request, signal)   // aborts the outbound fetch
        → ControlDatabase.recordFormationUsage({ …, signal })
          / ControlDatabase.redeemInvitation({ …, signal })    // checked inside the write lock
```

Signal placement rules — the point of the whole exercise:

- Check **before** the approval call and **before** the write statement is issued. The write-lock
  check goes *inside* the locked body, so a write still queued behind another writer is
  abandoned rather than executed.
- **Never** abort once `execFormationUsageInsert` has been issued. A half-issued insert must be
  allowed to finish and report success; the settle grace below is what turns that into a
  successful join.
- Abandoning throws the (already-added) `FormationAbortedError` so the manager can distinguish
  "we gave up" from a genuine conflict and not log it as one.
- Signal params are optional throughout, so existing test doubles and the `StrandProvisioner`
  mock path keep compiling. Threading the signal into `StrandProvisioner.provisionStrand` is
  optional — that path writes nothing.

### 2. Settle grace, carved out of the existing budget

`FormationListener.provision()` becomes: run the hook under a *work budget*, and on timeout abort
it and wait up to a *settle grace* for it to finish.

The grace is taken **out of** `provisionTimeoutMs`, not added to it, so the nesting ladder
documented at `DEFAULT_PROVISION_TIMEOUT_MS` (approval hook 10 s < responder provisioning 12 s <
initiator await-response 15 s < session 30 s) is untouched and the 3 s wire margin is preserved:

```
graceMs = min(PROVISION_SETTLE_GRACE_MS, floor(provisionTimeoutMs / 2))   // clamp keeps tiny test budgets sane
workMs  = max(1, provisionTimeoutMs - graceMs)
```

`PROVISION_SETTLE_GRACE_MS` = 2000 (so the default 12 s becomes 10 s of work + 2 s of settle).

Outcomes after the work budget expires:

| provisioning settles within the grace as | listener replies |
| --- | --- |
| approved | the real approval (identity + cadre + provision result disclosed as usual) |
| rejected (`approved: false`) | that rejection reason, non-disclosing |
| threw / aborted | `approved: false, reason: 'Formation provisioning timed out'` |
| still pending at the end of the grace | `approved: false, reason: 'Formation provisioning timed out'` |

The existing "log how it eventually settled" `void pending.then(...)` stays for the last row —
that is the only case left where the outcome is unknown at reply time.

Keep the `'Formation provisioning timed out'` reason string exactly as-is; three existing tests
assert it verbatim.

### 3. Residual, and where to park it

There remains one unavoidable window: the work budget expires in the gap between the insert being
issued and the grace expiring, on a write slow enough to outlast the grace. The invite is then
spent while the joiner is told it timed out. Nothing short of an un-spend (impossible — the table
is append-only) or a same-identity retry (see the decision section) closes it. Replace the
existing `NOTE:` in `FormationListener.provision()` with one describing this narrowed residual —
it is a tripwire, not a follow-up ticket.

## TODO

### Phase 1 — abort plumbing

- ~~Export `FormationAbortedError` from `control-database.ts`~~ **DONE (in working tree).**
- Add optional `signal?: AbortSignal` to `FormationListenerOptions.provisionStrand` (4th arg) and
  thread it through `StrandFormationManager.provisionAsResponder` / `provisionUnbound`.
- Add optional `signal` to `FormationUsageRecorder.recordUsage` and `provisionAndRecord` param
  objects in `strand-solicitation.ts`; implement in `ControlFormationUsageRecorder` (entry
  checks + `obtainApproval` pre-check — see resume notes).
- Add optional `signal` second parameter to `FormationApprover.requestApproval`; wire it into the
  HTTP client's existing `AbortController` via an `abort` listener (+ `callerAborted` flag,
  pre-aborted → `unavailable` before fetch), and replace the stale `NOTE:` at
  `formation-approval.ts:83`.
- Add optional `signal` to `ControlDatabase.recordFormationUsage` and `redeemInvitation`; check it
  inside the `withWriteLock` body immediately before the statement runs, throwing
  `FormationAbortedError`. Do not check after the insert is issued.
- Rethrow `FormationAbortedError` in `StrandFormationManager.provisionAsResponder`'s catch BEFORE
  the `FormationApprovalError` mapping so it is not reported as `'Formation conflict, retry'`.

### Phase 2 — abort + adopt in the listener

- Split `provisionTimeoutMs` into work budget + settle grace as above; add
  `PROVISION_SETTLE_GRACE_MS` with a docblock explaining the carve-out (budget ladder unchanged)
  and the work-budget-equals-hook-timeout race note.
- Rework `FormationListener.provision()` per the resume-note shape (own AbortController +
  `timedOut` flag + `settleWithinGrace`); a settled grace outcome flows back through the
  unchanged `runSession` branches, so a late approval discloses normally and a late rejection
  relays its reason.
- Replace the `NOTE:` in `provision()` with the narrowed-residual note from §3.

### Phase 3 — tests

- The four new/extended listener tests in `strand-formation-protocol.spec.ts`, the two
  approval-client tests in `formation-approval.spec.ts`, and the new
  `control-formation-recorder.spec.ts` pre-check spec — exact designs + timings in the resume
  notes.

### Phase 4 — validation + docs

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-test.log`, plus `yarn typecheck` and
  `yarn lint` at the root.
- Update `docs/architecture.md:526` (ladder + abort/adopt behaviour + hook-race sentence — see
  resume notes).
