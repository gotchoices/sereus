description: Add two end-to-end tests for the safeguard that keeps a one-time invitation reusable when the host runs out of time mid-join, so a future change that unhooks the pieces from each other fails a test instead of passing silently.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts
difficulty: medium
----

## Background

An invitation to join a strand can be single-use. Redeeming one means writing a
`FormationUsage` row into the host's control database. If the host's provisioning budget
expires mid-redemption, two behaviours must hold together:

1. **Cancel-before-write** — the host aborts the in-flight work and every layer below checks
   that abort before issuing the insert, so an invitation that was not yet redeemed stays
   unredeemed and the joiner's retry works.
2. **Adopt-if-it-lands** — if the work lands anyway inside the settle grace, the host adopts
   the outcome and tells the joiner the join succeeded, rather than reporting a timeout over
   an invitation that is in fact spent.

Both shipped. The chain that carries the cancellation is:

```
FormationListener.provision()            strand-formation-protocol.ts
  → AbortController.abort() at workMs, then settleWithinGrace()
  → StrandFormationManager.provisionAsResponder(contact, signal)   strand-formation-manager.ts
    → ControlFormationUsageRecorder.recordUsage({ ..., signal })    control-formation-recorder.ts
      → obtainApproval(..., signal) → askApprover(..., signal)      (relays abort onto the HTTP hook call)
      → ControlDatabase.recordFormationUsage({ ..., signal })       control-database.ts
        → withUseNumberRetry: `if (signal?.aborted) throw FormationAbortedError` inside the write lock
```

## What exists today

Per-layer only:

- `packages/cadre-core/test/control-formation-invite.spec.ts` (~line 361) — real database, a
  write parked behind another writer, caller aborts while queued, `FormationAbortedError` and
  no row. Covers the in-lock check at the bottom of the chain.
- `packages/cadre-core/test/control-formation-recorder.spec.ts` — pre-aborted signal, abort
  between the invite read and the approval ask, and a caller-abort during the ask re-labelled
  as `FormationAbortedError`. All against a fake database and fake approver.
- `packages/cadre-core/test/strand-formation-protocol.spec.ts` — the listener cancels on
  overrun, adopts a late success and a late refusal, and carves the grace out of the budget.
  Drives a hand-written `provisionStrand` stub over an in-memory stream; no manager, no
  recorder, no database.

Nothing runs the composed path. Remove the `signal` argument from any one hop above and every
one of those tests still passes.

## What to build

A new `Phase 6: Provisioning abort and settle grace` block at the end of
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`, reusing that
file's existing module-scope helpers (`ownerSigner`, `responderService`, `invitationFor`,
`readFormationUsage`) and the `startApprovalHook` fixture.

Both cases use the **bound** (provision-then-record) invite shape — an owner-signed `Strand`
row inserted up front via `alice.controlDatabase.insertStrand(hostStrandId, 'o',
alice.ownerPublicKey, ownerSigner(alice))`, and an invite carrying that `strandId`. That is
the shape production publishes (see the `provisionUnbound` doc comment in
`strand-formation-manager.ts`), and it routes through `recordUsage` →
`recordFormationUsage`, the path with the real abort checks.

Both cases set the responder's budget via `formationConfig: { provisionTimeoutMs: 3000 }`,
which `splitProvisionBudget` turns into **1500 ms work + 1500 ms grace** (the grace is capped
at half the budget). The joiner is left unconfigured, so its 15 s await-response budget
comfortably outlasts the responder's ~1.5 s reply. `responderService(party)` needs an
optional second parameter carrying that config; keep its current single-argument callers
unchanged.

### Case (i) — cancellation leaves the invitation unspent, and the same token then works

Fully real, no test shims: the lever is a **stalled approval hook**, which is what a
real-world queue-behind-a-human approver looks like when it goes quiet.

- alice inserts the host strand, enrolls `hook.validationKey`, and publishes an owner-signed
  invite with `totalUses: 1`, `strandId: hostStrandId`, `validationUrl: hook.validationUrl`.
- The hook **holds** its first request without answering.
- bob's `formStrand` rejects with `/Formation provisioning timed out/` — the listener's own
  retryable reason, not `Internal formation error` and not a dial read-error.
- `countFormationUsage(token)` is **0**.
- `hook.requestCount` is 1 and `hook.abortedCount` is 1 — the cancellation reached the wire
  and killed the outbound HTTP call. Without this assertion the case would still pass if the
  reply were produced by some unrelated timeout.
- Release the hold, then `formStrand` the **same token** again: it resolves,
  `result.strandId === hostStrandId`, `countFormationUsage(token)` is 1,
  `hook.requestCount` is 2, and `verifyFormationConsent(await readFormationUsage(alice, token))`
  is true.

Why the hook and not the database as the lever: `askApprover` relays the caller-abort onto its
own `fetch`, so a stalled hook produces a genuine `FormationAbortedError` at a deterministic
moment (the 1500 ms work deadline) with no timing race.

### Case (ii) — a redemption that lands inside the grace is adopted

Same shape, but **no `validationUrl`** and no hook. The lever is a thin timing decorator around
the real recorder, wired as the responder's `formationUsageRecorder`:

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

`waitForAbort` resolves on the signal's `abort` event (or immediately if already aborted) and
returns false after a cap (~10 s) so a regression that stops cancelling fails as an assertion
rather than hanging to the session timeout.

- `formStrand` **resolves** — the joiner is told the truth about a spent invitation, not
  "timed out". `result.strandId === hostStrandId`.
- `observedAbort` is **true**. Without this the case degenerates into an ordinary happy path
  and would pass even if cancellation were removed entirely.
- `countFormationUsage(token)` is 1; `verifyFormationConsent(row)` is true; and
  `ed25519PublicKeyB64FromPeerId(result.memberKey) === row.peerKey` — the joiner was told
  about the row that actually exists.
- A second `formStrand` with the same single-use token is refused with `/Invalid token/`, and
  the count stays 1 — the adopted redemption really did consume the seat.

State plainly in the block comment that the decorator is a timing shim, not a fake: recorder
and database beneath it are the real ones and the row is written by the real write path. A
real commit finishes in milliseconds, and no production lever lands a write inside a 1500 ms
grace on demand — the approval hook cannot be that lever, because the caller-abort is relayed
onto the outgoing HTTP request and kills it.

### Fixture change — `startApprovalHook` stall lever

Extend `ApprovalHookOptions` additively in
`packages/integration-tests/src/harness/fixtures/approval-hook-server.ts`:

- `beforeAnswer?: (fields: FormationVouchFields, requestIndex: number) => Promise<void>` —
  awaited after the body is parsed and `requestCount` is bumped, before `decide` runs. This is
  the hold.
- `abortedCount: number` on `ApprovalHookServer` — requests whose socket closed before the
  fixture answered (`res.on('close')` while `!res.writableEnded`).
- Guard the response write: a held request released after its client gave up must not write to
  a destroyed socket. Return early when `res.writableEnded || res.destroyed`.

Keep `requestCount` incrementing where it does now (as soon as the body parses), so it means
"the responder asked" rather than "the hook answered".

## Edge cases & interactions

- **Test does not hang on regression.** Every wait has a cap: the hook hold is released by the
  test, and `waitForAbort` gives up after ~10 s. Neither case may rely on a vitest timeout to
  terminate.
- **Held request released after the client aborted.** The fixture must survive writing to a
  socket the client already dropped (`ERR_STREAM_WRITE_AFTER_END` / destroyed response), both
  on explicit release and on `hook.close()` in the `finally`.
- **Budget ordering under the small config.** With `provisionTimeoutMs: 3000` on the responder
  and defaults on the joiner, the responder must reply before the joiner's 15 s
  await-response budget. Assert on the reply's *reason string*, not merely that something
  threw, so a joiner-side timeout can never be mistaken for the responder's rejection.
- **Zero-count is not the same as reusable.** Case (i)'s re-redemption of the same token is
  the assertion that carries the ticket; a bare `countFormationUsage === 0` would also be
  satisfied by an invitation left in an unusable state.
- **Adoption must not double-spend.** Case (ii)'s follow-up rejection pins that the adopted
  redemption consumed exactly one seat — not zero (invite still open despite the joiner being
  told it succeeded) and not two.
- **Handler leak between cases.** Each case creates its own parties, but unregister the
  responder in a `finally` — Case (i) has an intermediate assertion that can throw while the
  hook is still held (the existing Phase 4/5 helper's NOTE flags this pattern).
- **Cross-party isolation.** Give every party, token, and strand id a case-unique name
  (`Date.now()` suffix, as the existing phases do) so a shared `TestCadreNetwork` cannot leak
  a row between cases.
- **Not covered, deliberately.** The composed path reaches `ControlDatabase`'s in-lock abort
  check only through the recorder's earlier checks, so a dropped `signal` on the
  `controlDatabase.recordFormationUsage({ ..., signal })` call alone would not fail these two
  cases. Driving that seam end to end needs the write lock held from outside, which has no
  public handle; it stays covered by `control-formation-invite.spec.ts` (~line 361). Say so in
  the Phase 6 block comment so the gap is visible where a reader will meet it.

## Coordination

Two sibling plan tickets extend the same integration file and fixture:
`debt-approval-gated-redemption-remaining-e2e` (adds Phase 5 cases and may touch
`approval-hook-server.ts`) and `debt-formation-use-number-race-real-concurrency`. Not made a
`prereq:` — the work is additive and independent. Append Phase 6 as a new `describe` at the
end of the file and make the fixture change purely additive, so the three land without
stepping on each other.

## TODO

### Phase 1 — fixture

- Add `beforeAnswer` to `ApprovalHookOptions`, awaited between the `requestCount` bump and
  `decide`.
- Add `abortedCount` to `ApprovalHookServer`, tracked from `res.on('close')` before
  `writableEnded`.
- Guard the response write against a destroyed/ended response; verify the existing Phase 5
  cases still pass unchanged.

### Phase 2 — Phase 6 test block

- Extend `responderService(party, formationConfig?)` with the optional config; leave existing
  call sites untouched.
- Add a `Phase 6: Provisioning abort and settle grace` describe with its own
  `TestCadreNetwork` / `beforeAll` / `afterAll`, mirroring Phases 4 and 5.
- Add a local `insertHostStrand(party, strandId)` helper (owner-signed open `Strand` row) and
  a `waitForAbort(signal, capMs)` helper.
- Write case (i) — stalled hook, timeout reply, zero rows, abort observed on the wire, same
  token then redeems.
- Write case (ii) — recorder timing decorator, adopted success, one row, consent re-verifies,
  seat consumed.
- Give both cases a 30 s vitest timeout, matching the surrounding phases.

### Phase 3 — validate

- `yarn workspace @serfab/integration-tests test 2>&1 | tee` the scenario file (stream the
  output; never silently redirect).
- Run the case (ii) file a few times to confirm the abort-driven settle is not timing-flaky.
- `yarn lint` and the repo type check over both touched packages.
- Sanity-check the guard against a vacuous pass: temporarily drop the `signal` argument from
  `StrandFormationManager`'s `recordUsage` call and confirm case (i) fails; restore it.
