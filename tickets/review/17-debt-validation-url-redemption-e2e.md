description: Review the new end-to-end test that stands up a real local approval server and checks that an invitation requiring outside sign-off can actually be redeemed — and is refused in the four ways it should be.
files: packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/api.md, docs/STATUS.md
difficulty: medium
----

# Review: end-to-end redemption of an approval-gated invitation

## What was built

An invitation can carry a web address (`ValidationUrl`) for an outside approver. When someone
tries to redeem it, the inviting party's node POSTs the redemption's details there over HTTP,
gets a signed sign-off back, and only then writes the join record. Each piece already had its own
test; the whole chain in one go did not. It does now.

Three files changed plus two docs:

**New fixture — `packages/integration-tests/src/harness/fixtures/approval-hook-server.ts`.**
`startApprovalHook(options?)` binds a real `node:http` listener on `127.0.0.1:0` and returns
`{ validationUrl, validationKey, requestCount, lastRequest, close() }`. `requestCount` /
`lastRequest` are getters over closure state, so a test reads live values. `lastRequest` is the
object `JSON.parse` produced, stored verbatim — the `disclosure` string is signed exactly as
received, never re-serialized. `options.decide(fields)` returns `'approve'` (default, signs
freshly), `'refuse'` (403), or a `FormationApproval` returned verbatim (the replay case).
`options.privateKeyB64` lets a caller sign the same way outside the hook. A throw inside the
handler answers 500 rather than becoming an unhandled rejection. `close()` destroys open sockets
before closing the listener. Re-exported from `src/harness/index.ts`.

**Helpers lifted to module scope in `src/scenarios/strand-formation-e2e.integration.ts`.**
`ownerSigner`, `responderService`, `invitationFor`, `readFormationUsage` moved out of the Phase 4
`describe` (they now sit in a `── Consent-path helpers (Phases 4 & 5) ──` section after
`createTestNodeConfig`). Phase 4 behaviour unchanged — its three cases still pass.

**New Phase 5 `describe`,** own `TestCadreNetwork` + `beforeAll`/`afterAll`, five cases, each with
its own parties and its own hook closed in a `finally`:

- (i) happy path — hook approves; asserts `formStrand` resolves, `hook.requestCount === 1`,
  `countFormationUsage === 1`, the posted body's key set is exactly
  `['disclosure','peerKey','strandId','token','usageStampId']`, each posted field equals the
  committed row's, `verifyFormationConsent(row)` is true, and the row's `PeerKey` is
  `ed25519PublicKeyB64FromPeerId(result.memberKey)`.
- (ii) hook refuses (403) → `Formation approval refused`, count 0, then the verdict flips to
  approve on the same hook/URL and the same single-use token redeems successfully (count 1) —
  proving the seat was left unspent, not merely uncounted.
- (iii) approver key never enrolled → `Formation approval key is not enrolled`, count 0, and
  `requestCount === 1` (the hook was asked; the refusal is the redeeming node's local check).
- (iv) key enrolled, invite published, then `deleteValidationKey` (asserted `true`) → same
  unenrolled reason, count 0.
- (v) replayed sign-off — one hook, a flag flips it from signing to handing back the first
  joiner's approval verbatim; a second joiner redeems a second single-use invite naming the same
  hook → `Formation approval invalid`, second token count 0, first token count still 1.

## Validation actually run

- `yarn workspace @serfab/integration-tests run typecheck` — clean.
- `npx eslint` over the three changed TypeScript files — clean.
- `yarn workspace @serfab/integration-tests test src/scenarios/strand-formation-e2e.integration.ts`
  — **17/17 pass** (all four pre-existing phases plus the five new cases), ~50 s wall clock.
  Phase 5 case timings: 2.9 s / 3.2 s / 2.4 s / 2.7 s / 4.2 s.

## Correction to the ticket's premise — worth a reviewer's eye

The implement ticket said the happy path lands "a committed `FormationUsage` row carrying a
`ValidationKey` + `ValidationSignature`". **It does not — those are not columns.**
`schemas/control.qsql` declares them as INSERT-CONTEXT parameters
(`FormationUsage ... with context (Now datetime, ValidationKey text null, ValidationSignature text null)`);
the `Authorized` CHECK verifies the sign-off against the STORED `ValidationKey.Key` row at write
time and nothing about the approval is persisted on the usage row.

So "the approval landed" is asserted indirectly and deliberately: the row exists at all (an
unapproved insert is rolled back by that CHECK) **and** the hook's own `requestCount` proves the
node really called out. A first draft of `readFormationUsage` selected those two columns and was
reverted; the helper's doc comment now records why there is nothing to read back. A reviewer
wanting a stronger assertion here should know there is no column to reach for — the next step up
would be a negative case (an approval-gated invite whose sign-off is withheld must never produce
a row), which cases (ii)–(v) already cover from four directions.

## Known gaps — treat the tests as a floor

- **`requestCount` is asserted in (i), (ii), (iii) but not (iv) or (v).** In (iv) the hook is
  reached and its answer discarded by the local enrollment check; in (v) it is reached twice.
  Neither is pinned. Cheap to add if the reviewer wants it.
- **No case asserts `unavailable` or `misconfigured`** end to end. Both are reachable through
  this path (dead hook / non-`http(s)` `ValidationUrl`) and both have client-level coverage in
  `test/formation-approval-real-fetch.spec.ts`, but the scenario-level reason-string mapping for
  those two categories is unexercised. Deliberate scope call — the ticket named four rejection
  categories and those are the four covered.
- **Only the unbound (`provisionAndRecord`) redemption path is exercised.** The bound
  (`recordUsage` against a pre-existing host strand) path also obtains an approval and is not
  covered here.
- **Replay is proven against one of its two guards.** Case (v) lands on the recorder's local
  `verifyFormationApproval` pre-check (`malformed`). The schema's independent
  `FormationUsage.UsageStampId unique` guard never gets a chance to fire, because the local check
  runs first. The test comments say so explicitly, so a reordering fails loudly — but the unique
  column itself is not exercised by this suite.
- **Refusal is only tested as 403.** `401` maps to the same `refused` category per the wire
  contract and is not separately driven.
- **`fileParallelism: false` is what keeps port and hook state from colliding.** Each hook binds
  port 0 and closes in a `finally`, so this should hold regardless, but the suite has not been run
  with parallelism on.
- **Full-repo `yarn lint` and `yarn typecheck` were not run** — only the integration-tests
  workspace typecheck and eslint over the three changed files. Nothing outside that package was
  touched apart from two markdown files, so the risk is low but it is not zero.
- **Only this one scenario file was run**, not the whole integration suite. The lifted helpers are
  private to that file, so no other file can be affected, but that reasoning is not a test run.

## Tripwires parked

- `harness/fixtures/approval-hook-server.ts` — comment at the `server.listen(0, ...)` call
  recording that the fixture deliberately uses OS port assignment rather than the harness
  `allocatePort()` pool (that pool is reserved for libp2p listeners; drawing from both invites
  collisions).
- `strand-formation-e2e.integration.ts` — comment on `enrollApprover` recording why enrollment
  goes through `ControlDatabase.insertValidationKey` (the call `CadreNode.enrollValidationKey`
  bottoms out in) rather than cadre-cli's `applyAdd`: reaching the latter would need a test-only
  store adapter, and a shim written for the test is not the operator path.
- `strand-formation-e2e.integration.ts` — comment in case (v) naming which of the two replay
  guards fires and why, so a future reordering of the recorder's pre-checks fails loudly instead
  of quietly passing on the other mechanism.
- `readFormationUsage` doc comment — records that approval material is insert context, not a
  stored column (see the correction above).

The pre-existing `responderService` NOTE about unregistering at the end of a case rather than in a
`finally` still applies and Phase 5 follows the same convention; every Phase 5 case creates its own
parties, so a leaked responder dies with `network.shutdown()`.

## Docs updated

- `docs/STATUS.md` — replaced the "Still unexercised end-to-end" sentence with what Phase 5 now
  covers. The two following sentences (the separate, still-open
  `backlog/debt-control-key-enrollment-accepts-malformed-keys` gap, and the note that invitations
  without a `ValidationUrl` are unaffected) were left intact.
- `docs/api.md` §"Validate Strand Formation (approval hook)" — the wire contract already matched
  the fixture exactly, so nothing was corrected; a short paragraph was added after the
  rejection-reason table pointing at Phase 5 and the fixture as the executable check of that
  contract.

## Note

This was coverage for behaviour believed to work, and it works — no defect surfaced, so no `fix/`
ticket was filed.
