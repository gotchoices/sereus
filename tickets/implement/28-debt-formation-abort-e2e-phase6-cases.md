description: Finish adding the two end-to-end tests for the safeguard that keeps a one-time invitation reusable when the host runs out of time mid-join; the shared test plumbing is already in place, the two test cases themselves still need writing.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts
difficulty: medium
----

Continuation of `debt-formation-abort-end-to-end-coverage`. That ticket's Phase 1 (fixture)
and the `responderService` extension have LANDED; the prior run stopped on its token budget
before writing the two test cases. Everything below is what remains, plus every fact the
prior run established so nothing has to be re-derived.

## Why this exists

An invitation to join a strand can be single-use. Redeeming one writes a `FormationUsage`
row into the host's control database. If the host's provisioning budget expires mid-redemption,
two behaviours must hold together:

1. **Cancel-before-write** — the host aborts the in-flight work and every layer below checks
   that abort before issuing the insert, so an invitation that was not yet redeemed stays
   unredeemed and the joiner's retry works.
2. **Adopt-if-it-lands** — if the work lands anyway inside the settle grace, the host adopts
   the outcome and tells the joiner the join succeeded, rather than reporting a timeout over
   an invitation that is in fact spent.

Both shipped. Both are covered per-layer only; nothing runs the composed path, so removing
the `signal` argument from any single hop still passes every existing test. The chain:

```
FormationListener.provision()            strand-formation-protocol.ts
  → AbortController.abort() at workMs, then settleWithinGrace()
  → StrandFormationManager.provisionAsResponder(contact, signal)   strand-formation-manager.ts
    → ControlFormationUsageRecorder.recordUsage({ ..., signal })    control-formation-recorder.ts
      → obtainApproval(..., signal) → askApprover(..., signal)      (relays abort onto the HTTP hook call)
      → ControlDatabase.recordFormationUsage({ ..., signal })       control-database.ts
```

## Already done — do NOT redo

**`packages/integration-tests/src/harness/fixtures/approval-hook-server.ts`** (verified, type-checks):

- `ApprovalHookOptions.beforeAnswer?: (fields: FormationVouchFields, requestIndex: number) => Promise<void>`
  — awaited between the `requestCount` bump and `decide`. `requestIndex` is the 1-based value
  `requestCount` just took, so `requestIndex === 1` holds only the first ask.
- `ApprovalHookServer.abortedCount: number` — incremented from `res.on('close')` when
  `!res.writableEnded`, i.e. the client hung up before the fixture answered.
- `answer` is now `async`; an `isDead(res)` guard (`res.writableEnded || res.destroyed`) short-
  circuits after a released hold and in the `.catch` 500 fallback, so writing to a socket the
  client already dropped cannot throw `ERR_STREAM_WRITE_AFTER_END`.
- `requestCount` still bumps as soon as the body parses — it means "the responder asked", not
  "the hook answered".

**`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`**:

- `StrandFormationManagerConfig` added to the module's type-only `@serfab/cadre-core` import.
- `responderService(party, overrides = {})` — second parameter is an options bag rather than a
  bare config (the original plan said "optional second parameter carrying that config"; a bag
  covers both overrides Phase 6 needs with one optional param). Shape:
  `{ formationConfig?: StrandFormationManagerConfig; formationUsageRecorder?: FormationUsageRecorder }`.
  Every existing single-argument caller is byte-identical in behaviour: the recorder still
  defaults to `new ControlFormationUsageRecorder(party.controlDatabase)` and `formationConfig`
  is only spread in when supplied.

`yarn workspace @serfab/integration-tests exec tsc --noEmit -p tsconfig.json` passes on the
tree as it stands. No test run has happened yet.

## What remains

A new `Phase 6: Provisioning abort and settle grace` `describe` appended at the END of
`strand-formation-e2e.integration.ts`, with its own `TestCadreNetwork` / `beforeAll` /
`afterAll`, mirroring Phases 4 and 5. Reuse the module-scope helpers `ownerSigner`,
`responderService`, `invitationFor`, `readFormationUsage`, and the `startApprovalHook` fixture.

Both cases use the **bound** (provision-then-record) invite shape — an owner-signed `Strand`
row inserted up front, and an invite carrying that `strandId`. That is the shape production
publishes, and it routes through `recordUsage` → `recordFormationUsage`, the path with the
real abort checks. Both set `formationConfig: { provisionTimeoutMs: 3000 }` on the responder.
The joiner is left unconfigured.

### Case (i) — cancellation leaves the invitation unspent, and the same token then works

Fully real, no test shims: the lever is a **stalled approval hook**, which is what a real-world
queue-behind-a-human approver looks like when it goes quiet.

- alice inserts the host strand, enrolls `hook.validationKey` (`insertValidationKey`), and
  publishes an owner-signed invite with `totalUses: 1`, `strandId: hostStrandId`,
  `validationUrl: hook.validationUrl`.
- The hook **holds** its first request: `beforeAnswer: (_f, i) => i === 1 ? held : Promise.resolve()`
  where `held` is a promise the test resolves later.
- bob's `formStrand` rejects with `/Formation provisioning timed out/` — the listener's own
  retryable reason, not `Internal formation error` and not a dial read-error.
- `countFormationUsage(token)` is **0**.
- `hook.requestCount` is 1 and `hook.abortedCount` is 1 — the cancellation reached the wire and
  killed the outbound HTTP call. Without this the case would still pass if the reply came from
  some unrelated timeout. `abortedCount` is observed by the SERVER a few ticks after the client
  aborts; wrap it in the harness `waitUntil` (short cap, e.g. 5 s) before the `expect` so it
  cannot flake.
- Release the hold, then `formStrand` the **same token** again: it resolves,
  `result.strandId === hostStrandId`, `countFormationUsage(token)` is 1, `hook.requestCount`
  is 2, and `verifyFormationConsent(await readFormationUsage(alice, token))` is true.

Why the hook and not the database as the lever: `askApprover` relays the caller-abort onto its
own `fetch`, so a stalled hook produces a genuine `FormationAbortedError` at a deterministic
moment (the 1500 ms work deadline) with no timing race.

### Case (ii) — a redemption that lands inside the grace is adopted

Same shape, but **no `validationUrl`** and no hook. The lever is a thin timing decorator around
the real recorder, wired as the responder's `formationUsageRecorder` via the new
`responderService` override:

```ts
// Delegates every method to a REAL ControlFormationUsageRecorder over the REAL control
// database. The only thing it changes is WHEN recordUsage's promise settles: the row is
// written first, then the call parks until the listener's work budget expires and aborts —
// so it settles just inside the settle grace, on purpose and without a timer race.
recordUsage: async (params) => {
  await inner.recordUsage(params);          // the real row really is written
  observedAbort = await waitForAbort(params.signal, ABORT_WAIT_CAP_MS);
}
```

`waitForAbort(signal, capMs)` resolves true on the signal's `abort` event (or immediately if
already aborted) and false after the cap (~10 s), so a regression that stops cancelling fails
as an assertion rather than hanging to the session timeout. Declare the timer handle as a
`let` before the `onAbort` listener so neither references the other before definition.

- `formStrand` **resolves** — the joiner is told the truth about a spent invitation, not "timed
  out". `result.strandId === hostStrandId`.
- `observedAbort` is **true**. Without this the case degenerates into an ordinary happy path
  and would pass even if cancellation were removed entirely. (Assignment ordering is safe: the
  `await` completes before `recordUsage` returns, which is before the result frame is sent.)
- `countFormationUsage(token)` is 1; `verifyFormationConsent(row)` is true; and
  `ed25519PublicKeyB64FromPeerId(result.memberKey) === row.peerKey`.
- A second `formStrand` with the same single-use token is refused with `/Invalid token/`, and
  the count stays 1 — the adopted redemption really did consume the seat.

State plainly in the block comment that the decorator is a timing shim, not a fake: recorder
and database beneath it are the real ones and the row is written by the real write path. A real
commit finishes in milliseconds, and no production lever lands a write inside a 1500 ms grace on
demand — the approval hook cannot be that lever, because the caller-abort is relayed onto the
outgoing HTTP request and kills it.

## Facts the prior run confirmed by reading the sources

**The numbers.** `provisionTimeoutMs: 3000` on the responder is not clamped:
`resolveProvisionTimeoutMs` (`strand-formation-protocol.ts:304`) computes a ceiling of
`max(1, 30000 − 5000 − min(3000, 12500))` = 22000 ms, and 3000 < 22000. `splitProvisionBudget`
(`:330`) then yields **workMs 1500 / graceMs 1500**. An unconfigured joiner gets
`DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS` = 15 s (`:103`), which comfortably outlasts the
responder's ~1.5–3 s reply.

**Case (i)'s reason string arrives as written.** `runSession` sends
`{ approved: false, reason: 'Formation provisioning timed out' }` (`:601`) and `dialFormation`
rethrows it as `Error('Formation rejected: <reason>')` (`:681`).

**Case (i)'s abort really does reach the socket.** `createHttpFormationApprover`'s `startBudget`
registers `onCallerAbort` on the caller signal and calls `controller.abort()` on the `fetch`
(`formation-approval.ts:462-482`), so the held request's response emits `close` with
`writableEnded` still false. The resulting `FormationApprovalError` is re-labelled
`FormationAbortedError` by `ControlFormationUsageRecorder.askApprover`
(`control-formation-recorder.ts:164`), `provisionAsResponder` rethrows rather than mapping it to
a rejection (`strand-formation-manager.ts:358`), and `settleWithinGrace` sees an already-rejected
promise (`stillPending` false) and returns `undefined` — the timed-out reply.

**Case (ii)'s second attempt.** `INVALID_TOKEN_REASON` is the literal `'Invalid token'`
(`strand-formation-protocol.ts:45`). The second redemption is gated by `validateToken`
(`isTokenUsed` sees count 1 ≥ `totalUses` 1) before provisioning, so the decorator is not
re-entered.

**Signatures.**
- `insertStrand(strandId, type, ownerKey, signMessage, memberPrivateKey?)` — `control-database.ts:998`.
  Use `'o'` (open) — `memberPrivateKey` stays null, which the initiator's structural validator
  does not require.
- The decorator must satisfy `FormationUsageRecorder` (`strand-solicitation.ts:67`). The bound
  path calls only `resolveStrand` → `recordUsage` (`strand-formation-manager.ts:327-343`), but
  `validateToken` also calls `isTokenValid` + `isTokenUsed` (`:262-268`); `provisionAndRecord`
  and `hasOutstandingInvitation` are optional and can be delegated for completeness.

## Edge cases & interactions

- **Test does not hang on regression.** Every wait has a cap: the hook hold is released by the
  test (in a `finally` too — the fixture never times a hold out), and `waitForAbort` gives up
  after ~10 s. Neither case may rely on a vitest timeout to terminate.
- **Budget ordering.** Assert on the reply's *reason string*, not merely that something threw,
  so a joiner-side timeout can never be mistaken for the responder's rejection.
- **Zero-count is not the same as reusable.** Case (i)'s re-redemption of the same token is the
  assertion that carries the ticket.
- **Adoption must not double-spend.** Case (ii)'s follow-up rejection pins that the adopted
  redemption consumed exactly one seat.
- **Handler leak between cases.** Unregister the responder in a `finally`, and close the hook in
  the same `finally` — case (i) has intermediate assertions that can throw while the hook is held.
- **Cross-party isolation.** Give every party, token, and strand id a case-unique name
  (`Date.now()` suffix, as the existing phases do).
- **Not covered, deliberately.** The composed path reaches `ControlDatabase`'s in-lock abort
  check only through the recorder's earlier checks, so a dropped `signal` on the
  `controlDatabase.recordFormationUsage({ ..., signal })` call alone would not fail these two
  cases. Driving that seam end to end needs the write lock held from outside, which has no
  public handle; it stays covered by `packages/cadre-core/test/control-formation-invite.spec.ts`
  (~line 361). Say so in the Phase 6 block comment so the gap is visible where a reader meets it.

## Coordination

Two sibling plan tickets extend the same integration file and fixture:
`debt-approval-gated-redemption-remaining-e2e` and
`debt-formation-use-number-race-real-concurrency`. Not a `prereq:` — the work is additive.
Append Phase 6 as a new `describe` at the end of the file.

## TODO

### Phase A — Phase 6 test block

- Add the `Phase 6: Provisioning abort and settle grace` describe with its own
  `TestCadreNetwork` / `beforeAll` / `afterAll`.
- Add local helpers: `insertHostStrand(party, strandId)` (owner-signed open `Strand` row),
  `publishBoundInvite(...)`, and `waitForAbort(signal, capMs)`.
- Write case (i) — stalled hook, timeout reply, zero rows, abort observed on the wire, same
  token then redeems.
- Write case (ii) — recorder timing decorator, adopted success, one row, consent re-verifies,
  seat consumed.
- Give both cases a 30 s vitest timeout, matching the surrounding phases.

### Phase B — validate (nothing below has run yet, including for the landed Phase 1 fixture edit)

- `yarn workspace @serfab/integration-tests test 2>&1 | tee` the scenario file (stream the
  output; never silently redirect). This is the FIRST run since the fixture change, so it also
  re-validates the existing Phase 5 cases against the now-async `answer` + `isDead` guard.
- Run case (ii) a few times to confirm the abort-driven settle is not timing-flaky.
- `yarn lint` and the repo type check over both touched packages.
- Sanity-check against a vacuous pass: temporarily drop the `signal` argument from
  `StrandFormationManager`'s `recordUsage` call and confirm case (i) fails; restore it.
