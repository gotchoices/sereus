description: An end-to-end test now stands up a real local approval server and proves an invitation requiring outside sign-off can actually be redeemed — and is refused in the four ways it should be.
files: packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/integration-tests/src/harness/fixtures/loopback-http-server.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts, docs/api.md, docs/STATUS.md
----

# Complete: end-to-end redemption of an approval-gated invitation

## What shipped

An invitation can carry a web address for an outside approver. When someone tries to redeem it,
the inviting party's node POSTs the redemption's details there over HTTP, gets a signed sign-off
back, and only then writes the join record. Every piece had its own test; the whole chain in one
go did not. It does now.

- **`harness/fixtures/loopback-http-server.ts`** (added in review) — `startLoopbackHttpServer()` /
  `readRequestBody()`: a real `node:http` listener on an OS-assigned loopback port. Closing it
  destroys open sockets before closing the listener, and the bind-time `error` handler is removed
  once the bind succeeds so a later server error is logged rather than swallowed.
- **`harness/fixtures/approval-hook-server.ts`** — `startApprovalHook(options?)`, built on that
  primitive. Answers with a real ed25519 signature over exactly the bytes it was posted; `decide`
  makes it approve (default), refuse with 403, or hand back a supplied sign-off verbatim (the
  replay case). Exposes `requestCount`, `lastRequest`, and (added in review) `lastMethod`,
  `lastPath`, `lastHeaders`.
- **`strand-formation-e2e.integration.ts` Phase 5** — five cases over real libp2p against that
  hook, through the recorder's DEFAULT HTTP approver (no injected fake): happy path; hook refuses
  and the seat is provably still spendable; approver key never enrolled; key enrolled then removed
  after the invitation went out; replayed sign-off. Phase 4's helpers (`ownerSigner`,
  `responderService`, `invitationFor`, `readFormationUsage`) were lifted to module scope so both
  phases share them.
- **`test/formation-approval-real-fetch.spec.ts`** — now uses the shared primitive instead of its
  own copy.
- **Docs** — `docs/STATUS.md` records what Phase 5 covers; `docs/api.md` §"Validate Strand
  Formation (approval hook)" points at Phase 5 as the executable check of the wire contract.

## Review findings

### Checked

Read the implement diff (`8df2bad`) before the handoff summary. Verified the tests' claims against
the sources they assert about, not against the ticket text: `formation-approval.ts` (wire contract,
failure categories, `signFormationApproval` / `verifyFormationApproval`),
`control-formation-recorder.ts` (pre-check ordering, both write paths),
`strand-formation-manager.ts` (`APPROVAL_REJECTION_REASONS` — all four asserted reason strings match
exactly), and `schemas/control.qsql` `FormationUsage` (`Authorized` vouch clause, `UsageStampId
unique`, the `with context` declaration). Cross-checked the layering claim by enumerating the
sibling suites: the schema-level `Authorized` validation-key branch and both replay guards are
covered in depth by `control-formation-invite.spec.ts` (~20 cases), so Phase 5 is genuinely adding
the missing whole-chain link rather than re-covering settled ground.

Also checked source hygiene (file sizes, helper decomposition, comment density), resource cleanup
(socket teardown, timer leaks, responder registration), type safety (no `any`; `JSON.parse` casts
are confined to the fixture), and whether the two doc edits match reality.

**The implement ticket's correction to its own premise is right.** `ValidationKey` /
`ValidationSignature` are INSERT-CONTEXT parameters, not `FormationUsage` columns — confirmed at
`schemas/control.qsql:613`. There is no approval material to read back off the row, so asserting
"the approval landed" from the row existing plus the hook's request count is the correct approach,
not a weak one.

### Found and fixed in this pass (minor)

- **Duplicated HTTP-fixture plumbing.** `readRequestBody` and the whole socket-tracking
  `startServer` were copy-pasted verbatim from `test/formation-approval-real-fetch.spec.ts` into
  the new fixture (~40 lines). Extracted to `harness/fixtures/loopback-http-server.ts`; both call
  sites now use it.
- **Swallowed server error.** Both copies armed `server.once('error', reject)` for the bind and
  never removed it, so the first error AFTER a successful bind was absorbed into an already-settled
  promise and lost — against the repo rule on eating exceptions. The extracted primitive removes
  the bind handler on success and installs a logging one (`sereus:integration:loopback-http`).
- **The wire contract was only half asserted.** `docs/api.md` promises a `POST`, a JSON
  content-type, an `accept: application/json`, and that the approver's own URL path (which may
  carry a hook secret) arrives unmangled. Only the body's field set was checked. The fixture now
  records method/path/headers and case (i) asserts all four.
- **Missing request counts** in cases (iv) and (v), flagged by the implementer as a known gap.
  Added: (iv) asserts the hook was reached once and its valid answer discarded locally; (v)
  asserts both redemptions really went out, so the replay is refused on the answer rather than
  short-circuiting before asking.
- **`docs/api.md` overclaimed.** "This whole contract is executable" — two of the five rejection
  reasons are not covered end to end. Reworded to "Most of this contract", naming which two are
  client-level only.

### Found and filed (major)

- `backlog/debt-approval-gated-redemption-remaining-e2e` — the `unavailable` and `misconfigured`
  rejection reasons never run against a real node (only against the HTTP client in isolation), and
  the bound-invitation redemption path (`recordUsage` against a pre-existing host strand) has no
  end-to-end approval coverage. Both were flagged by the implementer as deliberate scope calls;
  both are real remaining work rather than something to fix in a review pass, since the second
  needs new setup Phase 5 does not have.

### Tripwires

No new ones. The four the implementer parked (OS port assignment vs. the harness `allocatePort()`
pool; why enrollment goes through `ControlDatabase.insertValidationKey`; which of the two replay
guards fires in case (v); approval material being insert context rather than a column) were each
read against the source they describe and are accurate — they stay where they are. The port-pool
note moved into `loopback-http-server.ts` along with the `listen(0, …)` call it annotates.

### Considered and deliberately not filed

- **Scenario file size** — `strand-formation-e2e.integration.ts` is now 1290 lines across five
  phases. Large, but under the biggest scenario file in the package (`push-wake-e2e`, 38 KB), and
  Phase 5 shares Phase 4's helpers, so splitting it would separate code that belongs together. Not
  worth churn.
- **`fileParallelism: false` doing load-bearing work** — the implementer worried the suite has not
  been run with parallelism on. Each hook binds port 0 and closes in a `finally`, and every case
  builds its own parties, so there is nothing shared to collide over; this is not a latent defect.
- **The `unregisterResponder`-not-in-`finally` convention** — pre-existing, already documented in a
  `NOTE` on `responderService`, and harmless while every case owns its parties. Unchanged.
- **`manifest-server.ts`** partially duplicates the same listener shape but tracks no sockets and
  reads no bodies; folding it into the new primitive would touch a scenario outside this diff for
  no test-behaviour gain. Left alone.

### Validation run

- `yarn workspace @serfab/integration-tests run typecheck` — clean.
- `npx eslint` over all five changed/added TypeScript files — clean.
- `yarn vitest run test/formation-approval-real-fetch.spec.ts src/scenarios/strand-formation-e2e.integration.ts`
  — **25/25 pass** (17 scenario + 8 real-fetch), 47 s. Both suites were re-run because the extracted
  primitive is now shared between them.

Not run: full-repo `yarn lint` / `yarn typecheck`, and the rest of the integration suite. Nothing
outside `packages/integration-tests` changed except two markdown files, and the only newly-shared
symbol is the extracted primitive, whose two importers both pass.

No pre-existing test failures were observed, so `tickets/.pre-existing-error.md` was not written.

## Note

This was coverage for behaviour believed to work, and it works. No product defect surfaced —
every finding above is in the test/fixture code or the docs, not in the approval path itself.
