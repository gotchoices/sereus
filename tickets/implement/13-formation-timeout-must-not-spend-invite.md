description: When someone joins a network and the host runs out of time part-way through, the joiner is told the join failed even though the host may finish a moment later and burn the one-time invite — so the same invite is then refused and the person is stuck. Cancel the host's unfinished work when time runs out, and if it turns out to have finished anyway, tell the joiner it succeeded instead of lying about a failure.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, docs/architecture.md
difficulty: hard
----

<!-- resume-note -->
## Resume notes — prior run (investigation complete, NO code changed)

A prior agent run hit its token budget after reading every relevant file but **before editing
anything** — the working tree is untouched by that run. The design below was verified against
the actual code; start implementing directly. Verified findings that refine the plan:

- **`runSession` needs no change for adoption.** It already branches on the outcome object
  (`strand-formation-protocol.ts:409-429`): returning the late-settled
  `ResponderProvisionOutcome` from `provision()` makes an adopted approval flow through the
  normal disclosure path, and a late rejection reuses the `!outcome.approved` branch. Only
  `provision()` (`:355-380`) changes.
- **`withDeadline` (control-stream.ts:79) exposes neither a timed-out flag nor the signal
  outside `op`.** Two workable shapes: (a) capture the signal inside the op callback
  (`let signal; withDeadline(ms, label, (s) => { signal = s; pending = provisionStrand(..., s); return pending; })`)
  and treat `signal?.aborted` in the catch as "deadline fired" — sound because the controller
  aborts only on the timeout path and `withTimeout` clears its timer in `.finally` (microtask)
  before a queued timer macrotask can run; or (b) keep `withTimeout` + an own
  `AbortController` with the existing `timedOut`-flag idiom, which is what `withDeadline`
  does internally anyway. Either satisfies the ticket's intent; (b) is less clever.
- **Grace clamp re-checked against all five existing timeout tests** (spec `:215-320`) with
  `graceMs = min(2000, floor(provisionTimeoutMs/2))`, `workMs = provisionTimeoutMs - graceMs`:
  pT 20 → 10/10 (never-settles test still replies 'timed out'); clamped 900 → 450/450 vs
  950 ms hook → timed out; clamped 600 → 300/300 vs 700 ms hook → timed out; pT 200 →
  work 100 vs 30 ms hook → approves; pT 0 → default 12 000 → work 10 000. No existing test
  breaks.
- **New corner worth one doc sentence:** default work budget (10 s) now EQUALS the approval
  hook's own 10 s timeout, so a dead hook races 'Formation approval unavailable, retry'
  against 'Formation provisioning timed out'. Both retryable and both now leave the invite
  unspent (the caller-signal abort also cancels the outbound fetch); acceptable, but say so
  where the ladder is documented.
- **Manager catch order:** in `provisionAsResponder`'s catch (`strand-formation-manager.ts:322`),
  rethrow `FormationAbortedError` BEFORE the `FormationApprovalError` mapping and the generic
  'Formation conflict, retry' fallback. Import from `./control-database.js` — no cycle
  (control-database does not import the manager; formation-approval already imports from it).
- **DB check placement verified:** `recordFormationUsage`'s reads (`queryStrandStampId`,
  `nextUseNumber`) run BEFORE the lock, so the signal check belongs inside the
  `withWriteLock` callback immediately before `execFormationUsageInsert`
  (`control-database.ts:1415`); for `redeemInvitation`, inside the lock before
  `inTransaction('redemption', ...)` (`:1345`) — one check, never between the two inserts.
  Export `FormationAbortedError` beside `MissingHostStrandError` (`:58`).
- **Approver signature change is churn-free:** fakes implementing
  `requestApproval(request)` remain structurally assignable once the interface gains an
  optional second `signal` param. In the HTTP client (`formation-approval.ts:440-482`) add a
  `callerAborted` flag next to the existing `timedOut` flag: pre-aborted signal → throw
  'unavailable' before fetch; else `signal.addEventListener('abort', ..., { once: true })`
  aborting the client's own controller, removed in the existing `finally`. Delete the stale
  interface NOTE at `:83-87`.
- **Recorder checks:** throw `FormationAbortedError` at entry of `recordUsage` /
  `provisionAndRecord` (before `queryFormationInvite`) AND inside `obtainApproval`
  immediately before `approver.requestApproval`; thread `signal` into both DB write calls.
- **Test homes:** approval-client abort tests extend
  `packages/cadre-core/test/formation-approval.spec.ts` (has `stubFetch` / `expectFailure`
  helpers). No dedicated recorder spec exists (recorder is covered via
  `strand-formation-consent.spec.ts`); the already-aborted pre-check test can drive
  `ControlFormationUsageRecorder` with a stub/throwing `ControlDatabase` since the entry
  check precedes any DB access.
- **Test timings that clear CI jitter:** adoption regression — pT 400 (work 200 / grace 200),
  hook sleeps 300 ms then increments its use counter → lands mid-grace with 100 ms margin
  each side; "reply within pT" bound — pT 500 (work 250 / grace 250), signal-ignoring
  never-settling hook, assert elapsed ≤ 700 ms (a grace-added-on-top bug would reply ~750 ms).

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

`control-stream.ts` already has `withDeadline()`, which is `withTimeout()` wired to an
`AbortController`. Provisioning switches to it, and the signal is threaded to every step that can
still be abandoned:

```
FormationListener.provision()            withDeadline(workBudget, …, signal => …)
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
  check goes *inside* the locked body (`control-database.ts:1345` / `:1415`), so a write still
  queued behind another writer is abandoned rather than executed.
- **Never** abort once `execFormationUsageInsert` has been issued. A half-issued insert must be
  allowed to finish and report success; the settle grace below is what turns that into a
  successful join.
- Abandoning throws a named error (e.g. an exported `FormationAbortedError` alongside
  `MissingHostStrandError` in `control-database.ts`) so the manager can distinguish "we gave up"
  from a genuine conflict and not log it as one.
- Signal params are optional throughout, so existing test doubles and the `StrandProvisioner`
  mock path keep compiling. Threading the signal into `StrandProvisioner.provisionStrand` is
  optional — that path writes nothing.

`FormationApprover.requestApproval` gains an optional second `signal` parameter; the HTTP client
(`formation-approval.ts:441`) must abort its own controller when the caller's signal fires (add
an `abort` listener — do **not** reach for `AbortSignal.any`, which is not reliably present on
React Native/Hermes; the file's own docblock at `:418` commits to `fetch` + `AbortController`
only). Replace the `NOTE:` at `formation-approval.ts:83` with the real behaviour — this ticket is
the "if the responder ever gains a way to cancel a formation in flight" case that comment
anticipates.

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

- Add optional `signal?: AbortSignal` to `FormationListenerOptions.provisionStrand` (4th arg) and
  thread it through `StrandFormationManager.provisionAsResponder` / `provisionUnbound`.
- Add optional `signal` to `FormationUsageRecorder.recordUsage` and `provisionAndRecord` param
  objects in `strand-solicitation.ts`; implement in `ControlFormationUsageRecorder`.
- Add optional `signal` second parameter to `FormationApprover.requestApproval`; wire it into the
  HTTP client's existing `AbortController` via an `abort` listener, and replace the stale `NOTE:`
  at `formation-approval.ts:83`.
- Add optional `signal` to `ControlDatabase.recordFormationUsage` and `redeemInvitation`; check it
  inside the `withWriteLock` body immediately before the statement runs, and throw an exported
  `FormationAbortedError`. Do not check after the insert is issued.
- Map `FormationAbortedError` in `StrandFormationManager.provisionAsResponder`'s catch so it is
  not reported as `'Formation conflict, retry'` — rethrow it and let the listener's grace path own
  it.

### Phase 2 — abort + adopt in the listener

- Split `provisionTimeoutMs` into work budget + settle grace as above; add
  `PROVISION_SETTLE_GRACE_MS` with a docblock explaining the carve-out (budget ladder unchanged).
- Switch `FormationListener.provision()` from `withTimeout` to `withDeadline`; on timeout, await
  the pending provisioning under the grace and return its outcome when it settles.
- Have `runSession` treat an adopted late approval exactly like a timely one (identity disclosure
  is unchanged — it is still gated behind token + disclosure validation).
- Replace the `NOTE:` in `provision()` with the narrowed-residual note from §3.

### Phase 3 — tests (`packages/cadre-core/test/strand-formation-protocol.spec.ts`)

- Regression for the reported bug: hook that commits after its work budget but **within** the
  grace → listener replies `approved: true`, the invite's single use belongs to a join the
  joiner was told succeeded, and a retry is correctly refused as used. (Adapt the reproduction
  above: assert the *first* session now approves.)
- Hook that observes its `signal` and abandons without writing → reply is
  `'Formation provisioning timed out'` **and** the fake use counter is still 0, then a retry with
  the same contact frame is accepted.
- Hook that never settles at all → still `'Formation provisioning timed out'` (the existing test
  at `:235` covers the reply; extend it to assert the signal was aborted).
- Assert the work budget + grace stay within `provisionTimeoutMs` — a hook that ignores its signal
  and never settles must still get its reply by roughly `provisionTimeoutMs`, not later, so the
  initiator's 15 s await-response is not blown.
- Recorder-level test (`packages/cadre-core/test/` — colocate with the existing formation-recorder
  spec if one exists, otherwise a new spec): an already-aborted signal makes
  `recordUsage` / `provisionAndRecord` throw **before** contacting the approver and before any
  database write.
- Approval-client test: a caller signal aborted mid-flight rejects the in-flight
  `requestApproval` (unavailable), rather than waiting out its own 10 s transport timeout.

### Phase 4 — validation + docs

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-test.log`, plus `yarn typecheck` and
  `yarn lint` at the root.
- Update `docs/architecture.md:526`: the budget ladder now reads "responder provisioning (12 s
  `provisionTimeoutMs`, of which the last 2 s is a settle grace)", and state that an overrunning
  provisioning is **aborted** and its late success adopted rather than reported as a failure.
