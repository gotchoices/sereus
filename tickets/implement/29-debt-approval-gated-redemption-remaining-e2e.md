----
description: Finish the end-to-end test coverage for invitations that need outside sign-off — the two turn-down reasons that were only ever checked in isolation (approver unreachable, approver address unusable), and the invitation shape that points at a network that already exists.
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, docs/api.md
difficulty: medium
----

# Finish Phase 5 of the strand-formation end-to-end scenario

## Background

An invitation may carry a `ValidationUrl`: before anyone may redeem it, the inviting party's node
POSTs the five signed fields of the redemption to that URL and must get back a signature from a
key the party enrolled in `CadreControl.ValidationKey`.

When that sign-off cannot be obtained, `FormationApprovalError.failure` is one of five categories
(`packages/cadre-core/src/formation-approval.ts` → `FormationApprovalFailure`), which
`strand-formation-manager.ts` → `APPROVAL_REJECTION_REASONS` maps onto the string the joiner is
told:

| failure | joiner sees | Phase 5 coverage today |
| --- | --- | --- |
| `refused` | `Formation approval refused` | case (ii) |
| `unenrolled` | `Formation approval key is not enrolled` | cases (iii), (iv) |
| `malformed` | `Formation approval invalid` | case (v) |
| `unavailable` | `Formation approval unavailable, retry` | **none** |
| `misconfigured` | `Formation approval misconfigured` | **none** |

And an invitation comes in two shapes, routed by `ControlFormationUsageRecorder.resolveStrand`:

- **unbound** — no `StrandId` on the invite; the responder mints a strand and writes the join
  record through `ControlDatabase.redeemInvitation`. This is the only shape Phase 5 drives.
- **bound** — the invite names an existing `StrandId`; the responder writes through
  `ControlDatabase.recordFormationUsage` instead, and hands the joiner that strand's
  `MemberPrivateKey` (the closed-strand read-gating secret) in the formation result.

This ticket closes both gaps with three new cases in
`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` → `Phase 5`, plus
one additive option on the approval-hook fixture and a docs paragraph.

## Design decisions (already settled — do not re-open)

**How to produce `unavailable`, and how to prove the seat survives.** Two arms, because the two
sub-paths reach `unavailable` from different places and only one of them can prove spendability:

- *Arm A — genuinely unreachable.* Publish the invite with `validationUrl:
  'http://127.0.0.1:1/hook'`. Port 1 is privileged, so nothing in the test process can be
  listening there and a loopback connect is refused immediately. Chosen over
  "start a hook and close it, reuse its port" because a released ephemeral port can be reassigned
  between close and redeem, which would make the case flaky for a reason unrelated to what it
  tests. This arm lands in `createHttpFormationApprover`'s catch-all
  (`Approval hook <origin> could not be reached`).
- *Arm B — the hook answered, badly.* A LIVE hook returning HTTP 503 hits
  `assertApprovingStatus`'s `!response.ok` branch — the same `unavailable` category. Because the
  hook stays alive on the URL the invite published, the verdict can then be flipped to approve and
  the SAME token redeemed successfully, which is the real proof the seat was never consumed —
  exactly the shape case (ii) uses for `refused`.

  Arm A cannot carry that proof: the `ValidationUrl` is inside the owner-signed `FormationInvite`
  row and cannot be repointed at a live hook afterwards. Arm A therefore asserts only
  `countFormationUsage(token) === 0` plus `isTokenUsed(token) === false` read through a
  `ControlFormationUsageRecorder` on the host — the same predicate the responder consults on the
  next redemption.

**Fixture change for arm B.** Add `'unavailable'` to the `decide` return union in
`packages/integration-tests/src/harness/fixtures/approval-hook-server.ts`, answering HTTP 503.
Additive — the existing `decide: () => verdict` caller at case (ii) is unaffected. Chosen over
`decide: () => { throw ... }` (which the handler's own `.catch` would turn into a 500, also
`unavailable`, with no fixture edit): the explicit verdict makes the fixture's three answer
classes — yes / no / broken — legible at the call site instead of relying on an error path
written for unexpected throws.

**How to produce `misconfigured`.** Publish the invite with `validationUrl:
'ftp://127.0.0.1:9/hook'`. `parseHookUrl` parses it fine and rejects on the scheme, BEFORE any
`fetch` — so a live hook standing by in the same case must show `requestCount === 0`. No scheme
validation exists on the write side (`ControlDatabase.insertFormationInvite` stores the string
verbatim; `schemas/control.qsql` declares `ValidationUrl text null`), so the bad invite really can
be published. Same spendability assertions as arm A, and for the same reason.

**Bound shape — use a CLOSED strand.** Insert the host strand up front with
`insertStrand(strandId, 'c', ownerPublicKey, ownerSigner(alice), memberPrivateKey)`. A closed
strand buys two assertions the unbound path structurally cannot make: the joiner receives exactly
the `memberPrivateKey` the owner inserted, and the approval hook's posted body still contains only
the five fields — i.e. the membership secret is disclosed to the joiner after sign-off but never
to the approver. Also assert the posted `strandId` equals the PRE-EXISTING id rather than a minted
one, which is what distinguishes this write path from the unbound one.

## Edge cases & interactions

- **A dropped (rather than refused) connection on arm A.** If the environment silently drops
  instead of refusing, the approval client's own 10 s budget (`DEFAULT_TIMEOUT_MS`) fires and
  still reports `unavailable` — the assertion holds, the case just takes ~10 s. That is inside the
  responder's 12 s default provisioning budget, so it must NOT surface as
  `Formation conflict, retry` or as a `FormationAbortedError`. Keep the per-case timeout at
  `30_000` so the slow path still fits.
- **Exact reason strings, no substring shortcuts.** Assert
  `/Formation approval unavailable, retry/` and `/Formation approval misconfigured/` in full. A
  regex like `/Formation approval/` passes on four of the five categories and would make these
  cases vacuous.
- **Vacuity guard on "the hook was never asked".** Both new refusal cases stand up a real hook
  (enrolled, live) that the invite does NOT point at, and assert `hook.requestCount === 0`. Without
  it, a case would pass identically if the failure came from somewhere else entirely.
- **`unenrolled` must not be what actually fires.** Arms A/B and the misconfigured case fail before
  any approval is returned, so enrollment is never consulted — enroll the live hook's key anyway,
  so a future reordering of the recorder's pre-checks shows up as a changed reason string rather
  than as a case that was already failing for the wrong reason.
- **Arm B's retry reaches the same published URL.** One hook, one `validationUrl`, a mutable
  `verdict` closure — as in case (ii). Do not close and restart the hook between the two
  redemptions.
- **Single-row premise of `readFormationUsage`.** It returns whichever row the scan yields first.
  Every new case uses `totalUses: 1`, so keep asserting `countFormationUsage(token) === 1` before
  reading a row back.
- **Bound-path `StrandExists`.** The `FormationUsage` insert carries a deferred `StrandExists`
  CHECK. Insert the strand before the redemption, not just before the assertion — Phase 4 (ii)
  already pins the opposite case (`missing` → `Host strand not yet available on this responder`),
  so getting the order wrong here surfaces as that message, not as a write failure.
- **Teardown.** Every case closes its hook in `finally`. Follow the existing Phase 5 convention of
  calling `unregisterResponder` at the end of the body (the leak dies with `network.shutdown()`),
  and give each `network.createParty({ name })` a name unique within the file.
- **No `allocatePort()`.** The harness port pool is reserved for libp2p listeners; the hardcoded
  dead ports (1, 9) and the fixture's own OS-assigned port stay out of it.
- **Header line count.** The file's top-of-file NOTE quotes `wc -l` (1565 today) and the rule for
  when to split Phase 5 out into a sibling file. Re-measure and update it; these cases add roughly
  200 lines and do not add a phase, so the existing "split when another phase lands" guidance
  stands.

## Expected test outcomes

- **(vi) `unavailable`, both arms.** Arm A: `formStrand` rejects with
  `Formation approval unavailable, retry`; `countFormationUsage === 0`; standby hook
  `requestCount === 0`; recorder `isTokenUsed === false`. Arm B: first redemption rejects with the
  same string and `requestCount === 1`; after flipping to approve, the same token redeems,
  `strandId` is defined, `requestCount === 2`, `countFormationUsage === 1`.
- **(vii) `misconfigured`.** `formStrand` rejects with `Formation approval misconfigured`;
  standby hook `requestCount === 0` (the scheme check ran before any HTTP);
  `countFormationUsage === 0`; recorder `isTokenUsed === false`.
- **(viii) bound shape.** `result.strandId` equals the pre-inserted strand id;
  `result.memberPrivateKey` equals the inserted membership key; `hook.requestCount === 1`;
  `hook.lastRequest` key set is still exactly
  `['disclosure', 'peerKey', 'strandId', 'token', 'usageStampId']` and its `strandId` is the
  pre-existing id; `countFormationUsage === 1`; the stored row satisfies
  `verifyFormationConsent` and its `peerKey` matches
  `ed25519PublicKeyB64FromPeerId(result.memberKey)`.

## TODO

### Phase 1 — fixture

- Add `'unavailable'` to `ApprovalHookOptions.decide`'s return union in
  `approval-hook-server.ts`, answering `503` with a JSON body, and document it in the option's
  doc comment alongside `'approve'` / `'refuse'` as "the hook is up but broken".

### Phase 2 — new Phase 5 cases

- Add case **(vi)** covering `unavailable` with arm A (dead port 1) and arm B (live hook returning
  `'unavailable'`, then flipped to approve and the same token re-redeemed).
- Add case **(vii)** covering `misconfigured` via an `ftp://` `ValidationUrl`, with a live standby
  hook asserted at `requestCount === 0`.
- Add case **(viii)** covering the bound invitation shape: pre-insert a closed strand with
  `insertStrand(..., 'c', ..., memberPrivateKey)`, publish a gated invite carrying that `strandId`,
  redeem through a real hook, and assert the full list under "Expected test outcomes".
- `publishGatedInvite` currently hardcodes the unbound shape. Extend it with an optional
  `strandId` (and keep its comment explaining why the unbound default exists) rather than writing a
  second bespoke `insertFormationInvite` call.
- Update the `Phase 5` block comment: it says "plus the four ways a redemption must be refused" —
  it is now all five categories plus both invitation shapes. Keep the "transport behaviour lives in
  `test/formation-approval-real-fetch.spec.ts`" pointer, but note that (vi) now drives the two
  transport outcomes that carry a distinct joiner-visible reason.

### Phase 3 — validate and document

- `yarn workspace @serfab/integration-tests typecheck`, then
  `yarn workspace @serfab/integration-tests test 2>&1 | tee <scratch>/it.log` (stream it — do not
  silently redirect). Run the scenario at least twice and report in the review handoff how many
  consecutive runs were green, and how long arm A took (fast-refusal vs 10 s-budget path).
- `yarn lint`.
- Rewrite the coverage paragraph in `docs/api.md` (immediately after the reason table, currently
  "Most of this contract is executable … covered only at the HTTP-client level, in
  `test/formation-approval-real-fetch.spec.ts`"): all five reasons and both invitation shapes now
  run end to end. Keep the pointer to the real-fetch spec for the transport decision table, and
  keep the existing sentence that none of these reasons consumes the invitation — the new cases are
  what makes it checkable.
